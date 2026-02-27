import http from 'node:http';
import express from 'express';
import { AuditLogger } from './audit/log.js';
import { getEngineConfig, type EngineConfig } from './config.js';
import { registerRoutes } from './http/routes.js';
import { MemoryAutomationService } from './memory/memory-automation-service.js';
import { PromptBus } from './prompt/bus.js';
import { SessionManager } from './session/manager.js';
import { BrowserAgentStore } from './session/store.js';
import { OnePasswordVault } from './vault/onepassword.js';
import { WsHub } from './ws/hub.js';

export interface EngineRuntime {
  readonly config: EngineConfig;
  readonly app: express.Express;
  readonly server: http.Server;
  readonly store: BrowserAgentStore;
  readonly promptBus: PromptBus;
  readonly sessionManager: SessionManager;
  readonly wsHub: WsHub;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createEngineRuntime(config: EngineConfig = getEngineConfig()): EngineRuntime {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const store = new BrowserAgentStore(config.dbPath);
  const audit = new AuditLogger(store);
  const memory = new MemoryAutomationService(store);
  const promptBus = new PromptBus(store, memory);
  const server = http.createServer(app);
  const wsHub = new WsHub(server, store, audit);
  const secrets = new OnePasswordVault(store);
  const sessionManager = new SessionManager(config, store, wsHub, audit, secrets);

  wsHub.onEvent((extensionId, event) => {
    sessionManager.handleExtensionEvent(extensionId, event);
  });

  wsHub.onDisconnect((extensionId) => {
    sessionManager.handleExtensionDisconnect(extensionId);
  });

  registerRoutes(app, {
    config,
    store,
    sessionManager,
    promptBus,
    wsHub,
    audit,
    secrets,
  });

  const start = async (): Promise<void> => {
    wsHub.start();

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    audit.record('engine.started', 'BrowserAgent engine started', {
      host: config.host,
      port: config.port,
      dbPath: config.dbPath,
      allowedDomains: config.allowedDomains,
    });
  };

  const stop = async (): Promise<void> => {
    wsHub.stop();

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });

    audit.record('engine.stopped', 'BrowserAgent engine stopped');
    store.close();
  };

  return {
    config,
    app,
    server,
    store,
    promptBus,
    sessionManager,
    wsHub,
    start,
    stop,
  };
}

export async function startEngineServer(config: EngineConfig = getEngineConfig()): Promise<void> {
  const runtime = createEngineRuntime(config);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }

    stopping = true;
    process.stdout.write(`\nReceived ${signal}. Shutting down BrowserAgent engine...\n`);
    try {
      await runtime.stop();
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await runtime.start();
  process.stdout.write(
    `BrowserAgent engine listening on http://${runtime.config.host}:${runtime.config.port}\n`,
  );
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(process.argv[1], `file://${process.cwd()}/`).href;

if (isMainModule) {
  startEngineServer().catch((error) => {
    process.stderr.write(`Failed to start BrowserAgent engine: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
