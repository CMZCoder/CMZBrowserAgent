import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserAgentStore } from '../session/store.js';

function makeDbPath(): string {
  return path.join(
    os.tmpdir(),
    `browser-agent-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

describe('BrowserAgentStore pairing', () => {
  it('rejects unknown pairing code', () => {
    const dbPath = makeDbPath();
    cleanupPaths.push(dbPath);

    const store = new BrowserAgentStore(dbPath);
    const result = store.completePairing('000000', 'ext-test');

    expect(result).toBeNull();

    store.close();
  });

  it('consumes pairing code once', () => {
    const dbPath = makeDbPath();
    cleanupPaths.push(dbPath);

    const store = new BrowserAgentStore(dbPath);
    const pairing = store.createPairingCode(300, 'test-suite');

    const first = store.completePairing(pairing.code, 'ext-test');
    const second = store.completePairing(pairing.code, 'ext-test');

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    store.close();
  });

  it('promotes memory pattern after two confirmed successes and clears on reset', () => {
    const dbPath = makeDbPath();
    cleanupPaths.push(dbPath);

    const store = new BrowserAgentStore(dbPath);

    store.recordMemoryPatternOutcome({
      host: 'vercel.com',
      commandType: 'click',
      fingerprint: 'fp-click-save',
      payload: { type: 'click', selector: 'button.save' },
      success: true,
      approvalSource: 'user_confirmation',
      autoApproveEligible: true,
    });

    store.recordMemoryPatternOutcome({
      host: 'vercel.com',
      commandType: 'click',
      fingerprint: 'fp-click-save',
      payload: { type: 'click', selector: 'button.save' },
      success: true,
      approvalSource: 'user_confirmation',
      autoApproveEligible: true,
    });

    const rule = store.getMemoryPattern('vercel.com', 'click', 'fp-click-save');
    expect(rule).not.toBeNull();
    expect(rule?.autoApprove).toBe(true);
    expect(rule?.confirmedSuccessCount).toBe(2);

    const deleted = store.clearMemoryPatterns();
    expect(deleted).toBe(1);
    expect(store.getMemorySummary().totalPatterns).toBe(0);

    store.close();
  });

  it('stores memory cards/settings and clears automation data as one unit', () => {
    const dbPath = makeDbPath();
    cleanupPaths.push(dbPath);

    const store = new BrowserAgentStore(dbPath);
    const settings = store.setMemoryNoStore(true);
    expect(settings.noStore).toBe(true);

    const card = store.upsertMemoryCard({
      scope: 'durable_project',
      title: 'Checkpoint',
      summary: 'Validate webhook health before deploy.',
      dedupeKey: 'dedupe-checkpoint-webhook-health',
      sourceType: 'checkpoint',
      payload: { note: 'webhook health' },
      confidence: 0.8,
      reliability: 0.75,
    });
    expect(card.id).toMatch(/^memory_/);

    store.logMemoryDecision({
      decisionType: 'policy_gate',
      reason: 'policy_check_passed',
    });

    const cleared = store.clearMemoryAutomation();
    expect(cleared.cardRows).toBe(1);
    expect(cleared.decisionRows).toBe(1);
    expect(store.listMemoryCards({ limit: 10 }).length).toBe(0);

    store.close();
  });
});
