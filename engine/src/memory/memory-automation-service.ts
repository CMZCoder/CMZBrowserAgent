import crypto from 'node:crypto';
import type { BrowserCommand } from '../protocol/commands.js';
import type {
  BrowserAgentStore,
  CommandApprovalSource,
  MemoryCardRecord,
  MemoryScope,
} from '../session/store.js';

const SENSITIVE_KEYWORDS = [
  'password',
  'passcode',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'otp',
  '2fa',
  'ssn',
  'creditcard',
];

const URL_REGEX = /https:\/\/[^\s]+/gi;
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const TOKEN_REGEX = /\b(?:sk|ghp|gho|xoxb|xoxp|pat)_[A-Za-z0-9_\-]{12,}\b/g;
const LONG_SECRET_REGEX = /\b[A-Za-z0-9_\-]{30,}\b/g;
const EMAIL_DETECT_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const TOKEN_DETECT_REGEX = /\b(?:sk|ghp|gho|xoxb|xoxp|pat)_[A-Za-z0-9_\-]{12,}\b/i;

const HIGH_RISK_COMMAND_TYPES = new Set<BrowserCommand['type']>(['evaluate', 'auth_fill_secret']);

interface PromptCaptureInput {
  readonly sessionId: string;
  readonly source: 'cli' | 'extension';
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
}

interface OutcomeCaptureInput {
  readonly sessionId: string;
  readonly command: BrowserCommand;
  readonly activeTabUrl: string | null;
  readonly success: boolean;
  readonly approvalSource: CommandApprovalSource;
}

export interface MemoryRetrievalContext {
  readonly sessionId: string;
  readonly command: BrowserCommand;
  readonly activeTabUrl: string | null;
  readonly limit: number;
}

export interface MemoryPolicyDecision {
  readonly blocked: boolean;
  readonly reason: string;
  readonly highRisk: boolean;
  readonly relatedCards: readonly MemoryCardRecord[];
}

function nowMs(): number {
  return Date.now();
}

function parseHost(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s:_\-./]/g, '')
    .trim();
}

function hashKey(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function redactText(text: string): string {
  return text
    .replace(EMAIL_REGEX, '[REDACTED_EMAIL]')
    .replace(TOKEN_REGEX, '[REDACTED_TOKEN]')
    .replace(LONG_SECRET_REGEX, (token) => {
      if (/\d{10,}/.test(token)) {
        return '[REDACTED_ID]';
      }
      return token;
    });
}

function hasSensitiveContent(text: string): boolean {
  const lowered = text.toLowerCase();
  if (SENSITIVE_KEYWORDS.some((keyword) => lowered.includes(keyword))) {
    return true;
  }

  return EMAIL_DETECT_REGEX.test(text) || TOKEN_DETECT_REGEX.test(text);
}

function redactStructured(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactStructured(entry));
  }

  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const keyLower = key.toLowerCase().replace(/\s+/g, '');
      if (SENSITIVE_KEYWORDS.some((keyword) => keyLower.includes(keyword))) {
        output[key] = '[REDACTED]';
      } else {
        output[key] = redactStructured(entry);
      }
    }
    return output;
  }

  if (typeof value === 'string') {
    return redactText(value);
  }

  return value;
}

function inferScopeFromPrompt(role: PromptCaptureInput['role'], content: string): MemoryScope {
  const normalized = content.toLowerCase();

  if (/\[(memory_checkpoint|user_action_required)\]/i.test(content)) {
    return 'durable_project';
  }

  if (role === 'user' && /\b(always|never|prefer|usually|do not|don't)\b/i.test(normalized)) {
    return 'durable_operator';
  }

  return 'ephemeral_session';
}

function extractCheckpointChunks(content: string): readonly string[] {
  const results: string[] = [];
  const explicitRegex = /\[MEMORY_CHECKPOINT(?::[^\]]+)?\]([\s\S]*?)\[\/MEMORY_CHECKPOINT\]/gi;
  let explicitMatch = explicitRegex.exec(content);
  while (explicitMatch) {
    const chunk = explicitMatch[1]?.trim();
    if (chunk) {
      results.push(chunk);
    }
    explicitMatch = explicitRegex.exec(content);
  }

  const actionRegex = /\[USER_ACTION_REQUIRED\]([\s\S]*?)\[\/USER_ACTION_REQUIRED\]/gi;
  let actionMatch = actionRegex.exec(content);
  while (actionMatch) {
    const chunk = actionMatch[1]?.trim();
    if (chunk) {
      results.push(chunk);
    }
    actionMatch = actionRegex.exec(content);
  }

  return results;
}

function resolveCommandHost(command: BrowserCommand, activeTabUrl: string | null): string | null {
  if (command.type === 'navigate' || command.type === 'tab_open') {
    return parseHost(command.url);
  }

  return parseHost(activeTabUrl);
}

function commandIntentKey(command: BrowserCommand): string {
  switch (command.type) {
    case 'navigate':
      return `navigate:${parseHost(command.url) ?? 'unknown'}`;
    case 'tab_open':
      return `tab_open:${parseHost(command.url) ?? 'unknown'}`;
    case 'click':
      return `click:${normalizeText(command.selector)}`;
    case 'type':
      return `type:${normalizeText(command.selector)}`;
    case 'select':
      return `select:${normalizeText(command.selector)}`;
    case 'wait_for':
      return `wait_for:${normalizeText(command.selector ?? command.text ?? '')}`;
    case 'extract':
      return `extract:${normalizeText(command.selector)}`;
    case 'screenshot':
      return 'screenshot';
    case 'tab_focus':
      return 'tab_focus';
    case 'auth_fill_secret':
      return `auth_fill_secret:${normalizeText(command.selector)}`;
    case 'evaluate':
      return 'evaluate';
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

function isHighRiskCommand(command: BrowserCommand): boolean {
  if (HIGH_RISK_COMMAND_TYPES.has(command.type)) {
    return true;
  }

  if (command.type === 'type') {
    const selector = command.selector.toLowerCase();
    return /password|secret|token|otp|2fa|passcode/.test(selector);
  }

  return false;
}

function scoreCard(card: MemoryCardRecord, intentKey: string, host: string | null): number {
  const ageMs = Math.max(0, nowMs() - Date.parse(card.updatedAt));
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recency = Math.exp(-ageDays / 14);
  const reliability = clamp(card.reliability);
  const confidence = clamp(card.confidence);

  const domainScore =
    host && card.domain === host ? 0.22 :
    card.domain === null ? 0.08 :
    0;

  const intentScore = card.intentKey && intentKey.includes(card.intentKey) ? 0.22 : 0;

  const scopeScore =
    card.scope === 'policy' ? 0.16 :
    card.scope === 'outcome' ? 0.12 :
    card.scope === 'durable_operator' ? 0.1 :
    card.scope === 'durable_project' ? 0.08 :
    0.03;

  return reliability * 0.34 + confidence * 0.26 + recency * 0.22 + domainScore + intentScore + scopeScore;
}

export class MemoryAutomationService {
  public constructor(private readonly store: BrowserAgentStore) {}

  public getSettings(): { noStore: boolean } {
    return this.store.getMemorySettings();
  }

  public setNoStore(enabled: boolean): { noStore: boolean } {
    return this.store.setMemoryNoStore(enabled);
  }

  public capturePrompt(input: PromptCaptureInput): void {
    if (this.store.getMemorySettings().noStore) {
      return;
    }

    const raw = input.content.trim();
    if (!raw) {
      return;
    }

    const redacted = redactText(raw);
    if (hasSensitiveContent(raw)) {
      this.store.logMemoryDecision({
        sessionId: input.sessionId,
        decisionType: 'capture_skipped',
        reason: 'prompt_contains_sensitive_data',
        details: {
          source: input.source,
          role: input.role,
        },
      });
    }

    const checkpoints = extractCheckpointChunks(raw);
    const chunks = checkpoints.length > 0 ? checkpoints : [redacted];
    const scope = inferScopeFromPrompt(input.role, raw);

    for (const chunk of chunks) {
      const summary = redactText(chunk).slice(0, 450);
      if (!summary) {
        continue;
      }

      const firstUrl = summary.match(URL_REGEX)?.[0] ?? null;
      const domain = parseHost(firstUrl);
      const dedupeRaw = `${scope}:${domain ?? 'global'}:${normalizeText(summary).slice(0, 240)}`;

      this.store.upsertMemoryCard({
        scope,
        title: scope === 'durable_operator' ? 'Operator preference' : 'Prompt memory',
        summary,
        domain,
        intentKey: null,
        dedupeKey: hashKey(dedupeRaw),
        sourceType: checkpoints.length > 0 ? 'checkpoint' : 'prompt',
        sourceRef: `${input.source}:${input.role}`,
        payload: {
          source: input.source,
          role: input.role,
          sample: summary,
        },
        confidence: checkpoints.length > 0 ? 0.85 : 0.62,
        reliability: checkpoints.length > 0 ? 0.8 : 0.58,
      });
    }
  }

  public captureCommandOutcome(input: OutcomeCaptureInput): void {
    if (this.store.getMemorySettings().noStore) {
      return;
    }

    if (input.command.type === 'auth_fill_secret') {
      return;
    }

    const host = resolveCommandHost(input.command, input.activeTabUrl);
    const intentKey = commandIntentKey(input.command);
    const payload = redactStructured(input.command);
    const normalizedPayload = normalizeText(JSON.stringify(payload));
    const payloadHash = hashKey(normalizedPayload);

    const outcomeSummary = `${input.command.type} on ${host ?? 'unknown-host'} ${input.success ? 'succeeded' : 'failed'}`;
    const outcomeCard = this.store.upsertMemoryCard({
      scope: 'outcome',
      title: 'Command outcome',
      summary: outcomeSummary,
      domain: host,
      intentKey,
      dedupeKey: hashKey(`outcome:${host ?? 'global'}:${intentKey}:${payloadHash}`),
      sourceType: 'command_result',
      sourceRef: input.approvalSource,
      payload: {
        commandType: input.command.type,
        payload,
        approvalSource: input.approvalSource,
      },
      confidence: input.success ? 0.78 : 0.66,
      reliability: input.success ? 0.82 : 0.28,
      successDelta: input.success ? 1 : 0,
      failureDelta: input.success ? 0 : 1,
    });

    const policySummary = `${input.command.type} policy on ${host ?? 'unknown-host'} (${input.success ? 'positive' : 'negative'} feedback)`;
    this.store.upsertMemoryCard({
      scope: 'policy',
      title: 'Execution policy',
      summary: policySummary,
      domain: host,
      intentKey,
      dedupeKey: hashKey(`policy:${host ?? 'global'}:${intentKey}:${payloadHash}`),
      sourceType: 'command_result',
      sourceRef: input.approvalSource,
      payload: {
        commandType: input.command.type,
        commandFingerprint: payloadHash,
        approvalSource: input.approvalSource,
      },
      confidence: input.approvalSource === 'user_confirmation' ? 0.9 : 0.74,
      reliability: input.success ? 0.84 : 0.2,
      successDelta: input.success ? 1 : 0,
      failureDelta: input.success ? 0 : 1,
    });

    this.store.logMemoryDecision({
      sessionId: input.sessionId,
      decisionType: 'outcome_captured',
      reason: input.success ? 'command_success' : 'command_failure',
      commandType: input.command.type,
      host,
      memoryCardId: outcomeCard.id,
    });
  }

  public retrieveForCommandIntent(input: MemoryRetrievalContext): readonly MemoryCardRecord[] {
    if (this.store.getMemorySettings().noStore) {
      this.store.logMemoryDecision({
        sessionId: input.sessionId,
        decisionType: 'retrieve_skipped',
        reason: 'no_store_enabled',
        commandType: input.command.type,
      });
      return [];
    }

    const host = resolveCommandHost(input.command, input.activeTabUrl);
    const intentKey = commandIntentKey(input.command);

    const cards = this.store.listMemoryCards({
      limit: 500,
      status: 'active',
      domain: host ?? undefined,
    });

    const now = nowMs();
    const ranked = cards
      .filter((card) => {
        if (!card.expiresAt) {
          return true;
        }
        const expiresAt = Date.parse(card.expiresAt);
        return !Number.isNaN(expiresAt) && expiresAt > now;
      })
      .map((card) => ({
        card,
        score: scoreCard(card, intentKey, host),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit)
      .map((entry) => entry.card);

    this.store.markMemoryCardsRead(ranked.map((card) => card.id));
    return ranked;
  }

  public evaluateCommandPolicy(input: {
    sessionId: string;
    command: BrowserCommand;
    activeTabUrl: string | null;
    confirmationProvided: boolean;
  }): MemoryPolicyDecision {
    const host = resolveCommandHost(input.command, input.activeTabUrl);
    const intentKey = commandIntentKey(input.command);
    const relatedCards = this.retrieveForCommandIntent({
      sessionId: input.sessionId,
      command: input.command,
      activeTabUrl: input.activeTabUrl,
      limit: 8,
    });

    const highRisk = isHighRiskCommand(input.command);
    if (highRisk && !input.confirmationProvided) {
      this.store.logMemoryDecision({
        sessionId: input.sessionId,
        decisionType: 'policy_gate',
        reason: 'high_risk_requires_confirmation',
        commandType: input.command.type,
        host,
      });

      return {
        blocked: true,
        reason: 'high_risk_requires_confirmation',
        highRisk,
        relatedCards,
      };
    }

    const failingPolicy = relatedCards.find((card) => {
      if (card.scope !== 'policy') {
        return false;
      }
      if (card.failureCount <= card.successCount || card.reliability >= 0.45) {
        return false;
      }
      if (card.intentKey && card.intentKey !== intentKey) {
        return false;
      }
      if (card.domain !== null && host !== null && card.domain !== host) {
        return false;
      }
      return true;
    });

    if (failingPolicy && !input.confirmationProvided) {
      this.store.logMemoryDecision({
        sessionId: input.sessionId,
        decisionType: 'policy_gate',
        reason: 'negative_policy_memory_requires_confirmation',
        commandType: input.command.type,
        host,
        memoryCardId: failingPolicy.id,
      });

      return {
        blocked: true,
        reason: 'negative_policy_memory_requires_confirmation',
        highRisk,
        relatedCards,
      };
    }

    this.store.logMemoryDecision({
      sessionId: input.sessionId,
      decisionType: 'policy_gate',
      reason: 'policy_check_passed',
      commandType: input.command.type,
      host,
    });

    return {
      blocked: false,
      reason: 'policy_check_passed',
      highRisk,
      relatedCards,
    };
  }

  public decayStaleMemory(nowIso = new Date().toISOString()): number {
    if (this.store.getMemorySettings().noStore) {
      return 0;
    }

    const cards = this.store.listMemoryCards({ limit: 500, status: 'active' });
    const now = Date.parse(nowIso);
    if (Number.isNaN(now)) {
      return 0;
    }

    let updated = 0;
    for (const card of cards) {
      const ageDays = (now - Date.parse(card.updatedAt)) / (1000 * 60 * 60 * 24);
      if (!Number.isFinite(ageDays) || ageDays < 45) {
        continue;
      }

      const decayedReliability = clamp(card.reliability * 0.92);
      if (Math.abs(decayedReliability - card.reliability) < 0.001) {
        continue;
      }

      const nextStatus = decayedReliability < 0.2 && card.scope === 'ephemeral_session' ? 'disabled' : card.status;
      const next = this.store.updateMemoryCard({
        id: card.id,
        reliability: decayedReliability,
        status: nextStatus,
      });
      if (next) {
        updated += 1;
      }
    }

    return updated;
  }
}
