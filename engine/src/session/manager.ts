import { isAllowedDomain, type EngineConfig } from '../config.js';
import type { AuditLogger } from '../audit/log.js';
import { AutonomousMemory } from '../memory/autonomous-memory.js';
import { MemoryAutomationService } from '../memory/memory-automation-service.js';
import { isMutatingCommand, type BrowserCommand } from '../protocol/commands.js';
import type { ExtensionToEngineEvent, EngineToExtensionEvent } from '../protocol/events.js';
import type { BrowserAgentStore, CommandApprovalSource, CommandRecord, SessionRecord } from './store.js';
import type { SecretProvider } from '../vault/types.js';

export interface CommandDispatchHub {
  hasReadyExtension(): boolean;
  sendToPrimary(event: EngineToExtensionEvent): boolean;
}

export interface EnqueueResult {
  readonly command: CommandRecord;
  readonly blocked: boolean;
  readonly reason: string | null;
}

function ensureActiveSession(store: BrowserAgentStore, sessionId: string): SessionRecord {
  const session = store.getSession(sessionId);
  if (!session) {
    throw new Error(`Session '${sessionId}' was not found.`);
  }

  if (session.status !== 'active') {
    throw new Error(`Session '${sessionId}' is not active.`);
  }

  return session;
}

export class SessionManager {
  private inFlightCommandId: string | null = null;
  private readonly memory: AutonomousMemory;
  private readonly memoryAutomation: MemoryAutomationService;

  public constructor(
    private readonly config: EngineConfig,
    private readonly store: BrowserAgentStore,
    private readonly hub: CommandDispatchHub,
    private readonly audit: AuditLogger,
    private readonly secrets: SecretProvider,
  ) {
    this.memory = new AutonomousMemory(this.store);
    this.memoryAutomation = new MemoryAutomationService(this.store);
  }

  public startSession(createdBy: string): SessionRecord {
    const session = this.store.createSession(createdBy);
    this.audit.record('session.started', `Session ${session.id} started`, {
      sessionId: session.id,
      createdBy,
    });
    return session;
  }

  public stopSession(sessionId: string): SessionRecord {
    const stopped = this.store.stopSession(sessionId);
    if (!stopped) {
      throw new Error(`Session '${sessionId}' is not active or does not exist.`);
    }

    if (this.inFlightCommandId) {
      this.inFlightCommandId = null;
    }

    this.audit.record('session.stopped', `Session ${sessionId} stopped`, { sessionId });
    return stopped;
  }

  public enqueueCommand(
    sessionId: string,
    command: BrowserCommand,
    confirmationToken?: string,
  ): EnqueueResult {
    const session = ensureActiveSession(this.store, sessionId);
    this.assertCommandDomainEligibility(command);
    const extensionState = this.store.getLatestExtensionState();
    const activeTabUrl = extensionState?.activeTabUrl ?? null;
    const hasValidConfirmation = confirmationToken === session.confirmationToken;
    const policyDecision = this.memoryAutomation.evaluateCommandPolicy({
      sessionId,
      command,
      activeTabUrl,
      confirmationProvided: hasValidConfirmation,
    });
    const decayedCards = this.memoryAutomation.decayStaleMemory();
    if (decayedCards > 0) {
      this.audit.record('memory.decayed', 'Stale memory cards decayed', {
        count: decayedCards,
      });
    }

    if (policyDecision.blocked) {
      const blocked = this.store.insertCommand({
        sessionId,
        command,
        requiresConfirmation: true,
        approvalSource: 'awaiting_confirmation',
        status: 'awaiting_confirmation',
      });

      this.audit.record('command.blocked_policy', 'Command blocked by memory policy gate', {
        sessionId,
        commandId: blocked.id,
        commandType: command.type,
        reason: policyDecision.reason,
        relatedCards: policyDecision.relatedCards.slice(0, 3).map((card) => card.id),
      });

      return {
        command: blocked,
        blocked: true,
        reason: `Command requires confirmation (${policyDecision.reason}).`,
      };
    }

    const isMutating = isMutatingCommand(command);
    let approvalSource: CommandApprovalSource = isMutating ? 'user_confirmation' : 'none';

    if (isMutating && !hasValidConfirmation) {
      const memoryDecision = this.memory.tryAutoApprove(command, activeTabUrl);
      if (memoryDecision.approved) {
        approvalSource = 'memory_auto_approve';
      } else {
        const blocked = this.store.insertCommand({
          sessionId,
          command,
          requiresConfirmation: true,
          approvalSource: 'awaiting_confirmation',
          status: 'awaiting_confirmation',
        });

        this.audit.record('command.blocked_confirmation', 'Mutating command blocked by guarded autopilot', {
          sessionId,
          commandId: blocked.id,
          commandType: command.type,
          memoryReason: memoryDecision.reason,
          policyReason: policyDecision.reason,
        });

        return {
          command: blocked,
          blocked: true,
          reason: 'Mutating command requires a valid session confirmation token.',
        };
      }
    }

    const queued = this.store.insertCommand({
      sessionId,
      command,
      requiresConfirmation: isMutating,
      approvalSource,
      status: 'queued',
    });

    if (approvalSource === 'memory_auto_approve') {
      this.audit.record('command.auto_approved_memory', `Command ${queued.id} auto-approved by autonomous memory`, {
        sessionId,
        commandId: queued.id,
        commandType: command.type,
      });
    }

    this.audit.record('command.queued', `Command ${queued.id} queued`, {
      sessionId,
      commandId: queued.id,
      commandType: command.type,
      approvalSource,
    });

    void this.dispatchNext();

    return {
      command: queued,
      blocked: false,
      reason: null,
    };
  }

  public handleExtensionEvent(extensionId: string, event: ExtensionToEngineEvent): void {
    switch (event.type) {
      case 'extension.ready': {
        this.store.touchTrustedExtension(extensionId);
        this.audit.record('extension.ready', `Extension ${extensionId} ready`, {
          extensionId,
          version: event.data.version,
        });
        void this.dispatchNext();
        return;
      }

      case 'extension.state': {
        this.store.touchTrustedExtension(extensionId);
        this.store.updateExtensionState({
          extensionId,
          activeTabId: event.data.activeTabId,
          activeTabUrl: event.data.activeTabUrl,
          panelOpen: event.data.panelOpen,
          status: event.data.status,
          timestamp: event.data.timestamp,
        });
        void this.dispatchNext();
        return;
      }

      case 'extension.result': {
        this.store.touchTrustedExtension(extensionId);
        this.handleCommandResult(event.data.commandId, event.data.status, event.data.result, event.data.error, event.data.durationMs);
        return;
      }

      case 'extension.error': {
        this.store.touchTrustedExtension(extensionId);
        if (event.data.commandId) {
          this.store.markCommandFailed(event.data.commandId, event.data.message);
          if (this.inFlightCommandId === event.data.commandId) {
            this.inFlightCommandId = null;
          }
        }

        this.audit.record('extension.error', event.data.message, {
          extensionId,
          code: event.data.code,
          commandId: event.data.commandId,
          details: event.data.details,
        });

        void this.dispatchNext();
        return;
      }

      case 'extension.pong': {
        this.store.touchTrustedExtension(extensionId);
        return;
      }

      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  public handleExtensionDisconnect(extensionId: string): void {
    if (this.inFlightCommandId) {
      this.store.markCommandFailed(this.inFlightCommandId, `Extension ${extensionId} disconnected before command completion.`);
      this.audit.record('command.failed_disconnect', 'In-flight command failed due to extension disconnect', {
        commandId: this.inFlightCommandId,
        extensionId,
      });
      this.inFlightCommandId = null;
    }
  }

  private handleCommandResult(
    commandId: string,
    status: 'success' | 'error',
    rawResult: Record<string, unknown> | undefined,
    errorText: string | undefined,
    durationMs: number | undefined,
  ): void {
    const command = this.store.getCommand(commandId);
    const extensionState = this.store.getLatestExtensionState();

    if (status === 'success') {
      const result = rawResult ?? {};
      this.store.markCommandSucceeded(commandId, result, durationMs);
      this.audit.record('command.succeeded', `Command ${commandId} succeeded`, {
        commandId,
        durationMs,
      });
    } else {
      const message = errorText ?? 'Extension reported unknown command failure.';
      this.store.markCommandFailed(commandId, message, durationMs);
      this.audit.record('command.failed', message, {
        commandId,
        durationMs,
      });
    }

    if (command) {
      this.memory.recordCommandOutcome({
        command: command.payload,
        activeTabUrl: extensionState?.activeTabUrl ?? null,
        success: status === 'success',
        approvalSource: command.approvalSource,
      });
      this.memoryAutomation.captureCommandOutcome({
        sessionId: command.sessionId,
        command: command.payload,
        activeTabUrl: extensionState?.activeTabUrl ?? null,
        success: status === 'success',
        approvalSource: command.approvalSource,
      });
    }

    if (this.inFlightCommandId === commandId) {
      this.inFlightCommandId = null;
    }

    void this.dispatchNext();
  }

  private assertCommandDomainEligibility(command: BrowserCommand): void {
    if (command.type === 'navigate' || command.type === 'tab_open') {
      if (!isAllowedDomain(command.url, this.config.allowedDomains)) {
        throw new Error('Command URL is outside the BrowserAgent domain allowlist.');
      }
      return;
    }

    const extensionState = this.store.getLatestExtensionState();
    if (extensionState?.activeTabUrl && !isAllowedDomain(extensionState.activeTabUrl, this.config.allowedDomains)) {
      throw new Error('Active browser tab is outside the BrowserAgent domain allowlist.');
    }
  }

  private async dispatchNext(): Promise<void> {
    if (this.inFlightCommandId) {
      return;
    }

    if (!this.hub.hasReadyExtension()) {
      return;
    }

    const activeSession = this.store.getActiveSession();
    if (!activeSession) {
      return;
    }

    const next = this.store.getNextQueuedCommand(activeSession.id);
    if (!next) {
      return;
    }

    const payload = await this.buildDispatchPayload(next);
    if (!payload) {
      return;
    }

    const event: EngineToExtensionEvent = {
      type: 'engine.command',
      data: {
        commandId: next.id,
        sessionId: next.sessionId,
        commandType: next.commandType,
        payload,
        createdAt: next.createdAt,
      },
    };

    const sent = this.hub.sendToPrimary(event);
    if (!sent) {
      return;
    }

    this.store.markCommandDispatched(next.id);
    this.inFlightCommandId = next.id;
    this.audit.record('command.dispatched', `Command ${next.id} dispatched to extension`, {
      commandId: next.id,
      commandType: next.commandType,
      sessionId: next.sessionId,
      approvalSource: next.approvalSource,
    });
  }

  private async buildDispatchPayload(command: CommandRecord): Promise<Record<string, unknown> | null> {
    const basePayload = command.payload as unknown as Record<string, unknown>;

    if (command.commandType !== 'auth_fill_secret') {
      return basePayload;
    }

    const selectorValue = basePayload.selector;
    if (typeof selectorValue !== 'string' || selectorValue.trim().length === 0) {
      this.store.markCommandFailed(command.id, 'auth_fill_secret payload is missing selector.');
      this.audit.record('command.failed_secret', 'auth_fill_secret payload is invalid', {
        commandId: command.id,
      });
      void this.dispatchNext();
      return null;
    }

    const secretKeyValue = basePayload.secretKey;
    if (typeof secretKeyValue !== 'string' || secretKeyValue.trim().length === 0) {
      this.store.markCommandFailed(command.id, 'auth_fill_secret payload is missing secretKey.');
      this.audit.record('command.failed_secret', 'auth_fill_secret secretKey is missing', {
        commandId: command.id,
      });
      void this.dispatchNext();
      return null;
    }

    try {
      const secretValue = await this.secrets.resolveSecret(secretKeyValue);
      const dispatchPayload: Record<string, unknown> = {
        type: 'auth_fill_secret',
        selector: selectorValue,
        secretValue,
      };

      if (typeof basePayload.submit === 'boolean') {
        dispatchPayload.submit = basePayload.submit;
      }

      return dispatchPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.markCommandFailed(command.id, `Secret resolution failed: ${message}`);
      this.audit.record('command.failed_secret_resolution', 'Failed resolving secret for auth_fill_secret', {
        commandId: command.id,
        secretKey: secretKeyValue,
      });
      void this.dispatchNext();
      return null;
    }
  }
}
