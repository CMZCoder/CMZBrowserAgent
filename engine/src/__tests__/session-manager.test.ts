import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConfig } from '../config.js';
import type { EngineToExtensionEvent } from '../protocol/events.js';
import { SessionManager } from '../session/manager.js';
import { BrowserAgentStore } from '../session/store.js';
import { AuditLogger } from '../audit/log.js';
import type { SecretProvider } from '../vault/types.js';

class MockHub {
  public ready = false;
  public sent: EngineToExtensionEvent[] = [];

  public hasReadyExtension(): boolean {
    return this.ready;
  }

  public sendToPrimary(event: EngineToExtensionEvent): boolean {
    this.sent.push(event);
    return true;
  }
}

class MockSecrets implements SecretProvider {
  public async resolveSecret(secretKey: string): Promise<string> {
    return `secret:${secretKey}`;
  }

  public async testSecret(secretKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
    void secretKey;
    return { ok: true };
  }
}

function makeDbPath(): string {
  return path.join(
    os.tmpdir(),
    `browser-agent-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

function makeManager(): {
  manager: SessionManager;
  store: BrowserAgentStore;
  hub: MockHub;
} {
  const dbPath = makeDbPath();
  cleanupPaths.push(dbPath);

  const config: EngineConfig = {
    host: '127.0.0.1',
    port: 8787,
    pairingTtlSeconds: 300,
    wsTokenTtlSeconds: 300,
    dbPath,
    allowedDomains: ['github.com', 'vercel.com'],
  };

  const store = new BrowserAgentStore(dbPath);
  const audit = new AuditLogger(store);
  const hub = new MockHub();
  const manager = new SessionManager(config, store, hub, audit, new MockSecrets());

  return {
    manager,
    store,
    hub,
  };
}

describe('SessionManager', () => {
  it('rejects a second active session', () => {
    const { manager, store } = makeManager();

    const first = manager.startSession('test-cli');
    expect(first.status).toBe('active');

    expect(() => manager.startSession('test-cli-2')).toThrow(/active session already exists/i);

    store.close();
  });

  it('blocks mutating command without confirmation token', () => {
    const { manager, store } = makeManager();

    const session = manager.startSession('test-cli');

    const result = manager.enqueueCommand(session.id, {
      type: 'click',
      selector: 'button[type="submit"]',
    });

    expect(result.blocked).toBe(true);
    expect(result.command.status).toBe('awaiting_confirmation');
    expect(result.reason).toMatch(/requires a valid session confirmation token/i);

    store.close();
  });

  it('rejects navigate command outside allowlist', () => {
    const { manager, store } = makeManager();

    const session = manager.startSession('test-cli');

    expect(() =>
      manager.enqueueCommand(session.id, {
        type: 'navigate',
        url: 'https://example.com',
      }),
    ).toThrow(/outside the BrowserAgent domain allowlist/i);

    store.close();
  });

  it('queues and dispatches read-only command when extension is ready', async () => {
    const { manager, store, hub } = makeManager();
    hub.ready = true;

    const session = manager.startSession('test-cli');

    const result = manager.enqueueCommand(session.id, {
      type: 'extract',
      selector: 'h1',
      kind: 'text',
    });

    expect(result.blocked).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.sent.length).toBe(1);
    const dispatched = hub.sent[0];
    expect(dispatched).toBeDefined();
    expect(dispatched?.type).toBe('engine.command');
    if (dispatched?.type === 'engine.command') {
      expect(dispatched.data.commandType).toBe('extract');
    }

    store.close();
  });

  it('auto-approves learned click patterns after repeated confirmed successes', () => {
    const { manager, store } = makeManager();
    const session = manager.startSession('test-cli');

    store.updateExtensionState({
      extensionId: 'ext-test',
      activeTabUrl: 'https://vercel.com/projects/comerzio',
    });

    const confirmedOne = manager.enqueueCommand(
      session.id,
      {
        type: 'click',
        selector: 'button[data-testid="save"]',
      },
      session.confirmationToken,
    );
    manager.handleExtensionEvent('ext-test', {
      type: 'extension.result',
      data: {
        commandId: confirmedOne.command.id,
        status: 'success',
      },
    });

    const confirmedTwo = manager.enqueueCommand(
      session.id,
      {
        type: 'click',
        selector: 'button[data-testid="save"]',
      },
      session.confirmationToken,
    );
    manager.handleExtensionEvent('ext-test', {
      type: 'extension.result',
      data: {
        commandId: confirmedTwo.command.id,
        status: 'success',
      },
    });

    const autoApproved = manager.enqueueCommand(session.id, {
      type: 'click',
      selector: 'button[data-testid="save"]',
    });

    expect(autoApproved.blocked).toBe(false);
    expect(autoApproved.command.approvalSource).toBe('memory_auto_approve');

    store.close();
  });

  it('disables memory auto-approve after a memory-approved failure', () => {
    const { manager, store } = makeManager();
    const session = manager.startSession('test-cli');

    store.updateExtensionState({
      extensionId: 'ext-test',
      activeTabUrl: 'https://github.com/CMZCoder/CommerzioS',
    });

    for (let i = 0; i < 2; i += 1) {
      const learned = manager.enqueueCommand(
        session.id,
        {
          type: 'click',
          selector: 'button[data-testid="dialog-save"]',
        },
        session.confirmationToken,
      );
      manager.handleExtensionEvent('ext-test', {
        type: 'extension.result',
        data: {
          commandId: learned.command.id,
          status: 'success',
        },
      });
    }

    const autoApproved = manager.enqueueCommand(session.id, {
      type: 'click',
      selector: 'button[data-testid="dialog-save"]',
    });
    expect(autoApproved.blocked).toBe(false);
    expect(autoApproved.command.approvalSource).toBe('memory_auto_approve');

    manager.handleExtensionEvent('ext-test', {
      type: 'extension.result',
      data: {
        commandId: autoApproved.command.id,
        status: 'error',
        error: 'selector not found',
      },
    });

    const blockedAgain = manager.enqueueCommand(session.id, {
      type: 'click',
      selector: 'button[data-testid="dialog-save"]',
    });
    expect(blockedAgain.blocked).toBe(true);
    expect(blockedAgain.command.approvalSource).toBe('awaiting_confirmation');

    store.close();
  });
});
