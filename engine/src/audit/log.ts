import type { BrowserAgentStore } from '../session/store.js';

const SENSITIVE_KEYS = [
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apiKey',
  'secretValue',
  'opRef',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEYS.some((sensitive) => normalized.includes(sensitive.toLowerCase()));
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }

  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (shouldRedactKey(key)) {
        output[key] = '[REDACTED]';
      } else {
        output[key] = redactValue(entry);
      }
    }
    return output;
  }

  return value;
}

export class AuditLogger {
  public constructor(private readonly store: BrowserAgentStore) {}

  public record(eventType: string, message: string, payload?: unknown): void {
    this.store.insertAuditLog({
      eventType,
      message,
      payloadJson: payload === undefined ? null : redactValue(payload),
    });
  }
}
