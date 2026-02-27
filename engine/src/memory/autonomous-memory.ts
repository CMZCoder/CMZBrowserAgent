import crypto from 'node:crypto';
import type { BrowserCommand } from '../protocol/commands.js';
import type { BrowserAgentStore, CommandApprovalSource, MemoryPatternRecord } from '../session/store.js';

const TRACKED_COMMAND_TYPES = new Set<BrowserCommand['type']>([
  'navigate',
  'tab_open',
  'click',
  'type',
  'select',
  'wait_for',
  'extract',
  'tab_focus',
  'screenshot',
]);

const AUTO_APPROVE_ELIGIBLE_TYPES = new Set<BrowserCommand['type']>(['click', 'select']);

function parseHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function resolveCommandHost(command: BrowserCommand, activeTabUrl: string | null): string | null {
  if (command.type === 'navigate' || command.type === 'tab_open') {
    return parseHost(command.url);
  }

  if (!activeTabUrl) {
    return null;
  }

  return parseHost(activeTabUrl);
}

function classifyText(text: string): string {
  const trimmed = text.trim();
  const length = trimmed.length;
  if (length === 0) {
    return 'empty';
  }

  const charset =
    /^[a-z0-9._\-@]+$/i.test(trimmed) ? 'alnum' :
    /^[0-9]+$/.test(trimmed) ? 'numeric' :
    'mixed';

  const lengthBucket = length <= 8 ? 'xs' : length <= 24 ? 'sm' : length <= 80 ? 'md' : 'lg';
  return `${charset}:${lengthBucket}`;
}

function normalizeCommandPayload(command: BrowserCommand): Record<string, unknown> | null {
  switch (command.type) {
    case 'navigate':
      return {
        type: command.type,
        url: command.url,
      };

    case 'tab_open':
      return {
        type: command.type,
        url: command.url,
        active: command.active === true,
      };

    case 'tab_focus':
      return {
        type: command.type,
        tabId: command.tabId ?? null,
      };

    case 'screenshot':
      return {
        type: command.type,
        fullPage: command.fullPage === true,
      };

    case 'click':
      return {
        type: command.type,
        selector: command.selector.trim(),
        waitForNavigation: command.waitForNavigation === true,
      };

    case 'type':
      return {
        type: command.type,
        selector: command.selector.trim(),
        clear: command.clear === true,
        submit: command.submit === true,
        textShape: classifyText(command.text),
      };

    case 'select':
      return {
        type: command.type,
        selector: command.selector.trim(),
        value: command.value,
      };

    case 'wait_for':
      return {
        type: command.type,
        selector: command.selector?.trim() ?? null,
        text: command.text?.trim() ?? null,
        timeoutMs: command.timeoutMs ?? null,
      };

    case 'extract':
      return {
        type: command.type,
        selector: command.selector.trim(),
        kind: command.kind ?? 'text',
        attribute: command.attribute?.trim() ?? null,
      };

    case 'auth_fill_secret':
      return null;

    case 'evaluate':
      return null;

    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

function buildFingerprint(payload: Record<string, unknown>): string {
  const normalized = JSON.stringify(payload);
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

export interface MemoryAutoApproveDecision {
  readonly approved: boolean;
  readonly reason: string;
  readonly rule: MemoryPatternRecord | null;
}

export class AutonomousMemory {
  public constructor(private readonly store: BrowserAgentStore) {}

  public tryAutoApprove(command: BrowserCommand, activeTabUrl: string | null): MemoryAutoApproveDecision {
    if (!AUTO_APPROVE_ELIGIBLE_TYPES.has(command.type)) {
      return {
        approved: false,
        reason: 'command_type_not_auto_approvable',
        rule: null,
      };
    }

    const host = resolveCommandHost(command, activeTabUrl);
    if (!host) {
      return {
        approved: false,
        reason: 'missing_host_context',
        rule: null,
      };
    }

    const payload = normalizeCommandPayload(command);
    if (!payload) {
      return {
        approved: false,
        reason: 'payload_not_memory_trackable',
        rule: null,
      };
    }

    const fingerprint = buildFingerprint(payload);
    const rule = this.store.getMemoryPattern(host, command.type, fingerprint);
    if (!rule) {
      return {
        approved: false,
        reason: 'no_matching_rule',
        rule: null,
      };
    }

    if (!rule.autoApprove) {
      return {
        approved: false,
        reason: 'rule_not_promoted',
        rule,
      };
    }

    if (rule.failureCount > 0) {
      return {
        approved: false,
        reason: 'rule_has_failures',
        rule,
      };
    }

    this.store.touchMemoryPattern(rule.id);
    return {
      approved: true,
      reason: 'approved_by_memory_rule',
      rule,
    };
  }

  public recordCommandOutcome(input: {
    command: BrowserCommand;
    activeTabUrl: string | null;
    success: boolean;
    approvalSource: CommandApprovalSource;
  }): void {
    if (!TRACKED_COMMAND_TYPES.has(input.command.type)) {
      return;
    }

    const host = resolveCommandHost(input.command, input.activeTabUrl);
    if (!host) {
      return;
    }

    const payload = normalizeCommandPayload(input.command);
    if (!payload) {
      return;
    }

    const fingerprint = buildFingerprint(payload);
    this.store.recordMemoryPatternOutcome({
      host,
      commandType: input.command.type,
      fingerprint,
      payload,
      success: input.success,
      approvalSource: input.approvalSource,
      autoApproveEligible: AUTO_APPROVE_ELIGIBLE_TYPES.has(input.command.type),
    });
  }
}
