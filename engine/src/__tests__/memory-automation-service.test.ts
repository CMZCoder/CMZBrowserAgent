import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryAutomationService } from '../memory/memory-automation-service.js';
import { BrowserAgentStore } from '../session/store.js';

function makeDbPath(): string {
  return path.join(
    os.tmpdir(),
    `browser-agent-memory-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
}

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const file of cleanupPaths.splice(0, cleanupPaths.length)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore cleanup failure in tests
    }
  }
});

describe('MemoryAutomationService', () => {
  it('captures checkpoints with dedupe and redaction', () => {
    const dbPath = makeDbPath();
    cleanupPaths.push(dbPath);
    const store = new BrowserAgentStore(dbPath);
    const memory = new MemoryAutomationService(store);

    memory.capturePrompt({
      sessionId: 'session-a',
      source: 'cli',
      role: 'assistant',
      content: '[MEMORY_CHECKPOINT]Operator email is admin@example.com and token sk_test_1234567890123[/MEMORY_CHECKPOINT]',
    });

    memory.capturePrompt({
      sessionId: 'session-a',
      source: 'cli',
      role: 'assistant',
      content: '[MEMORY_CHECKPOINT]Operator email is admin@example.com and token sk_test_1234567890123[/MEMORY_CHECKPOINT]',
    });

    const cards = store.listMemoryCards({ limit: 50, status: 'active' });
    expect(cards.length).toBe(1);
    expect(cards[0]?.summary).toContain('[REDACTED_EMAIL]');
    expect(cards[0]?.summary).toContain('[REDACTED_TOKEN]');
    expect(cards[0]?.writeCount).toBe(2);

    store.close();
  });

  it('ranks same-domain policy memory above unrelated memory and tracks read audit', () => {
    const dbPath = makeDbPath();
    cleanupPaths.push(dbPath);
    const store = new BrowserAgentStore(dbPath);
    const memory = new MemoryAutomationService(store);

    memory.captureCommandOutcome({
      sessionId: 'session-a',
      command: { type: 'click', selector: 'button[data-testid="save"]' },
      activeTabUrl: 'https://github.com/CMZCoder/BrowserAgent/settings',
      success: true,
      approvalSource: 'user_confirmation',
    });

    memory.captureCommandOutcome({
      sessionId: 'session-a',
      command: { type: 'click', selector: 'button[data-testid="save"]' },
      activeTabUrl: 'https://github.com/CMZCoder/BrowserAgent/settings',
      success: true,
      approvalSource: 'user_confirmation',
    });

    memory.captureCommandOutcome({
      sessionId: 'session-a',
      command: { type: 'click', selector: 'button[data-testid="save"]' },
      activeTabUrl: 'https://vercel.com/cmzcoder/comerzio/settings',
      success: false,
      approvalSource: 'user_confirmation',
    });

    const ranked = memory.retrieveForCommandIntent({
      sessionId: 'session-a',
      command: { type: 'click', selector: 'button[data-testid="save"]' },
      activeTabUrl: 'https://github.com/CMZCoder/BrowserAgent/settings',
      limit: 5,
    });

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]?.domain).toBe('github.com');

    const decisions = store.listMemoryDecisions(20);
    const readEvents = decisions.filter((entry) => entry.decisionType === 'retrieve_skipped');
    expect(readEvents.length).toBe(0);

    store.close();
  });

  it('blocks high-risk commands without confirmation and honors no-store mode', () => {
    const dbPath = makeDbPath();
    cleanupPaths.push(dbPath);
    const store = new BrowserAgentStore(dbPath);
    const memory = new MemoryAutomationService(store);

    const blocked = memory.evaluateCommandPolicy({
      sessionId: 'session-a',
      command: { type: 'evaluate', script: '() => document.cookie' },
      activeTabUrl: 'https://github.com/CMZCoder/BrowserAgent/settings',
      confirmationProvided: false,
    });

    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe('high_risk_requires_confirmation');

    const noStore = memory.setNoStore(true);
    expect(noStore.noStore).toBe(true);

    memory.capturePrompt({
      sessionId: 'session-a',
      source: 'cli',
      role: 'assistant',
      content: '[MEMORY_CHECKPOINT]This should not persist[/MEMORY_CHECKPOINT]',
    });

    const cards = store.listMemoryCards({ limit: 50 });
    expect(cards.length).toBe(0);

    store.close();
  });

  it('prevents false policy blocking from unrelated failing memories', () => {
    const dbPath = makeDbPath();
    cleanupPaths.push(dbPath);
    const store = new BrowserAgentStore(dbPath);
    const memory = new MemoryAutomationService(store);

    memory.captureCommandOutcome({
      sessionId: 'session-a',
      command: { type: 'click', selector: 'button[data-testid=\"danger-delete\"]' },
      activeTabUrl: 'https://github.com/CMZCoder/BrowserAgent/settings',
      success: false,
      approvalSource: 'user_confirmation',
    });

    const decision = memory.evaluateCommandPolicy({
      sessionId: 'session-a',
      command: { type: 'click', selector: 'button[data-testid=\"save-settings\"]' },
      activeTabUrl: 'https://github.com/CMZCoder/BrowserAgent/settings',
      confirmationProvided: false,
    });

    expect(decision.blocked).toBe(false);

    store.close();
  });

  it('persists memory across store reopen for cross-session continuity', () => {
    const dbPath = makeDbPath();
    cleanupPaths.push(dbPath);

    {
      const store = new BrowserAgentStore(dbPath);
      const memory = new MemoryAutomationService(store);

      memory.captureCommandOutcome({
        sessionId: 'session-a',
        command: { type: 'select', selector: 'select[name="framework"]', value: 'nextjs' },
        activeTabUrl: 'https://vercel.com/cmzcoder/comerzio/settings',
        success: true,
        approvalSource: 'user_confirmation',
      });

      store.close();
    }

    {
      const reopened = new BrowserAgentStore(dbPath);
      const memory = new MemoryAutomationService(reopened);
      const ranked = memory.retrieveForCommandIntent({
        sessionId: 'session-b',
        command: { type: 'select', selector: 'select[name="framework"]', value: 'nextjs' },
        activeTabUrl: 'https://vercel.com/cmzcoder/comerzio/settings',
        limit: 5,
      });

      expect(ranked.length).toBeGreaterThan(0);
      expect(ranked[0]?.domain).toBe('vercel.com');
      reopened.close();
    }
  });
});
