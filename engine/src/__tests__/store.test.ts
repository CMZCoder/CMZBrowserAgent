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
});
