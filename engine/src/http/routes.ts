import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { EngineConfig } from '../config.js';
import { enqueueCommandRequestSchema } from '../protocol/commands.js';
import type { PromptBus } from '../prompt/bus.js';
import type { SessionManager } from '../session/manager.js';
import type { BrowserAgentStore } from '../session/store.js';
import type { WsHub } from '../ws/hub.js';
import type { AuditLogger } from '../audit/log.js';
import type { OnePasswordVault } from '../vault/onepassword.js';

interface RouteDeps {
  readonly config: EngineConfig;
  readonly store: BrowserAgentStore;
  readonly sessionManager: SessionManager;
  readonly promptBus: PromptBus;
  readonly wsHub: WsHub;
  readonly audit: AuditLogger;
  readonly secrets: OnePasswordVault;
}

const pairingStartSchema = z.object({
  issuedBy: z.string().min(1).max(120).optional(),
});

const pairingCompleteSchema = z.object({
  code: z.string().trim().length(6),
  extensionId: z.string().trim().min(1),
});

const sessionStartSchema = z.object({
  createdBy: z.string().min(1).max(120).optional(),
});

const promptCreateSchema = z.object({
  source: z.enum(['cli', 'extension']).optional(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().trim().min(1).max(50_000),
  manualCheckpoint: z.boolean().optional(),
});

const promptPullQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  consume: z
    .union([z.literal('1'), z.literal('0'), z.literal('true'), z.literal('false')])
    .optional(),
});

const setSecretRefSchema = z.object({
  secretKey: z.string().trim().min(1),
  opRef: z.string().trim().min(1),
});

const testSecretSchema = z.object({
  secretKey: z.string().trim().min(1),
});

const memoryListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const memoryCardsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  scope: z
    .enum(['ephemeral_session', 'durable_project', 'durable_operator', 'policy', 'outcome'])
    .optional(),
  status: z.enum(['active', 'disabled', 'deleted']).optional(),
  domain: z.string().trim().min(1).optional(),
  query: z.string().trim().min(1).max(300).optional(),
});

const memoryDecisionQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const memoryCardUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().min(1).max(8_000).optional(),
  status: z.enum(['active', 'disabled', 'deleted']).optional(),
});

const memoryNoStoreSchema = z.object({
  enabled: z.boolean(),
});

function parsePromptPullConsume(value: string | undefined): boolean {
  if (!value) {
    return true;
  }

  return value === '1' || value === 'true';
}

function withCors(request: Request, response: Response): void {
  const origin = request.headers.origin;
  if (origin && origin.startsWith('chrome-extension://')) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }

  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function badRequest(response: Response, message: string, details?: unknown): void {
  response.status(400).json({ ok: false, error: message, details });
}

function notFound(response: Response, message: string): void {
  response.status(404).json({ ok: false, error: message });
}

function conflict(response: Response, message: string, details?: unknown): void {
  response.status(409).json({ ok: false, error: message, details });
}

function routeError(response: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown internal error.';
  response.status(500).json({ ok: false, error: message });
}

function requiredSession(store: BrowserAgentStore, sessionId: string): { id: string; status: 'active' | 'stopped' } {
  const session = store.getSession(sessionId);
  if (!session) {
    throw new Error(`Session '${sessionId}' was not found.`);
  }

  return {
    id: session.id,
    status: session.status,
  };
}

export function registerRoutes(app: Express, deps: RouteDeps): void {
  app.use((request, response, next) => {
    withCors(request, response);
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    next();
  });

  app.get('/v1/health', (_request, response) => {
    response.json({
      ok: true,
      service: 'browser-agent-engine',
      now: new Date().toISOString(),
      wsReady: deps.wsHub.hasReadyExtension(),
      activeSessionId: deps.store.getActiveSession()?.id ?? null,
    });
  });

  app.post('/v1/pairing/start', (request, response) => {
    const parsed = pairingStartSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      badRequest(response, 'Invalid pairing start request.', parsed.error.issues);
      return;
    }

    try {
      const issuedBy = parsed.data.issuedBy ?? 'cli';
      const pairing = deps.store.createPairingCode(deps.config.pairingTtlSeconds, issuedBy);
      deps.audit.record('pairing.started', 'Pairing code issued', {
        issuedBy,
        expiresAt: pairing.expiresAt,
      });

      response.status(201).json({
        ok: true,
        pairingCode: pairing.code,
        expiresAt: pairing.expiresAt,
      });
    } catch (error) {
      routeError(response, error);
    }
  });

  app.post('/v1/pairing/complete', (request, response) => {
    const parsed = pairingCompleteSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      badRequest(response, 'Invalid pairing completion request.', parsed.error.issues);
      return;
    }

    const { code, extensionId } = parsed.data;

    try {
      const pairing = deps.store.completePairing(code, extensionId);
      if (!pairing) {
        badRequest(response, 'Pairing code is invalid, expired, or already consumed.');
        return;
      }

      const wsToken = deps.store.issueWsToken(extensionId, deps.config.wsTokenTtlSeconds);
      const host = request.headers.host ?? `${deps.config.host}:${deps.config.port}`;
      const wsUrl = `ws://${host}/v1/ws?extensionId=${encodeURIComponent(extensionId)}&token=${wsToken.token}`;

      deps.audit.record('pairing.completed', 'Extension pairing completed', {
        extensionId,
        expiresAt: wsToken.expiresAt,
      });

      response.status(201).json({
        ok: true,
        extensionId,
        pairedAt: pairing.pairedAt,
        wsToken: wsToken.token,
        wsTokenExpiresAt: wsToken.expiresAt,
        wsUrl,
      });
    } catch (error) {
      routeError(response, error);
    }
  });

  app.get('/v1/sessions/active', (_request, response) => {
    try {
      const session = deps.store.getActiveSession();
      response.json({ ok: true, session });
    } catch (error) {
      routeError(response, error);
    }
  });

  app.post('/v1/sessions/start', (request, response) => {
    const parsed = sessionStartSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      badRequest(response, 'Invalid session start request.', parsed.error.issues);
      return;
    }

    try {
      const createdBy = parsed.data.createdBy ?? 'cli';
      const session = deps.sessionManager.startSession(createdBy);
      response.status(201).json({ ok: true, session });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start session.';
      if (message.includes('already exists')) {
        conflict(response, message);
        return;
      }
      routeError(response, error);
    }
  });

  app.post('/v1/sessions/:sessionId/stop', (request, response) => {
    const sessionId = request.params.sessionId;

    try {
      requiredSession(deps.store, sessionId);
      const session = deps.sessionManager.stopSession(sessionId);
      response.status(200).json({ ok: true, session });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to stop session.';
      if (message.includes('was not found')) {
        notFound(response, message);
        return;
      }
      badRequest(response, message);
    }
  });

  app.post('/v1/sessions/:sessionId/prompts', (request, response) => {
    const sessionId = request.params.sessionId;
    const parsed = promptCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      badRequest(response, 'Invalid prompt create request.', parsed.error.issues);
      return;
    }

    try {
      const session = requiredSession(deps.store, sessionId);
      if (session.status !== 'active') {
        badRequest(response, `Session '${sessionId}' is not active.`);
        return;
      }

      const prompt = deps.promptBus.publishPrompt({
        sessionId,
        source: parsed.data.source ?? 'cli',
        role: parsed.data.role,
        content: parsed.data.content,
        manualCheckpoint: parsed.data.manualCheckpoint,
      });

      deps.audit.record('prompt.published', `Prompt ${prompt.id} recorded`, {
        sessionId,
        source: prompt.source,
        role: prompt.role,
      });

      response.status(201).json({ ok: true, prompt });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to publish prompt.';
      if (message.includes('was not found')) {
        notFound(response, message);
        return;
      }
      routeError(response, error);
    }
  });

  app.get('/v1/sessions/:sessionId/prompts/pull', (request, response) => {
    const sessionId = request.params.sessionId;
    const parsed = promptPullQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      badRequest(response, 'Invalid prompt pull request.', parsed.error.issues);
      return;
    }

    try {
      requiredSession(deps.store, sessionId);
      const limit = parsed.data.limit ?? 50;
      const consume = parsePromptPullConsume(parsed.data.consume);
      const prompts = deps.promptBus.pullPrompts(sessionId, limit, consume);
      response.json({ ok: true, prompts, consume, limit });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to pull prompts.';
      if (message.includes('was not found')) {
        notFound(response, message);
        return;
      }
      routeError(response, error);
    }
  });

  app.post('/v1/sessions/:sessionId/commands', (request, response) => {
    const sessionId = request.params.sessionId;
    const parsed = enqueueCommandRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      badRequest(response, 'Invalid command enqueue request.', parsed.error.issues);
      return;
    }

    try {
      requiredSession(deps.store, sessionId);
      const enqueueResult = deps.sessionManager.enqueueCommand(
        sessionId,
        parsed.data.command,
        parsed.data.confirmationToken,
      );

      if (enqueueResult.blocked) {
        conflict(response, enqueueResult.reason ?? 'Command blocked by autopilot guard.', {
          command: enqueueResult.command,
        });
        return;
      }

      response.status(201).json({
        ok: true,
        blocked: false,
        command: enqueueResult.command,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to enqueue command.';
      if (message.includes('outside the BrowserAgent domain allowlist')) {
        badRequest(response, message);
        return;
      }
      if (message.includes('was not found')) {
        notFound(response, message);
        return;
      }
      routeError(response, error);
    }
  });

  app.get('/v1/sessions/:sessionId/state', (request, response) => {
    const sessionId = request.params.sessionId;

    try {
      const session = deps.store.getSession(sessionId);
      if (!session) {
        notFound(response, `Session '${sessionId}' was not found.`);
        return;
      }

      const latestExtensionState = deps.store.getLatestExtensionState();
      const prompts = deps.store.listRecentPrompts(sessionId, 50);
      const commands = deps.store.listRecentCommands(sessionId, 100);

      response.json({
        ok: true,
        session,
        activeSessionId: deps.store.getActiveSession()?.id ?? null,
        memory: {
          patterns: deps.store.getMemorySummary(),
          cards: deps.store.getMemoryCardSummary(),
          settings: deps.store.getMemorySettings(),
        },
        extension: {
          primaryExtensionId: deps.wsHub.getPrimaryExtensionId(),
          wsReady: deps.wsHub.hasReadyExtension(),
          latestState: latestExtensionState,
        },
        prompts,
        commands,
      });
    } catch (error) {
      routeError(response, error);
    }
  });

  app.post('/v1/secrets/set-ref', (request, response) => {
    const parsed = setSecretRefSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      badRequest(response, 'Invalid secret mapping request.', parsed.error.issues);
      return;
    }

    try {
      deps.store.setSecretReference(parsed.data.secretKey, parsed.data.opRef);
      deps.audit.record('secret.ref_set', `Secret reference set for ${parsed.data.secretKey}`, {
        secretKey: parsed.data.secretKey,
      });
      response.status(201).json({ ok: true, secretKey: parsed.data.secretKey });
    } catch (error) {
      routeError(response, error);
    }
  });

  app.post('/v1/secrets/test', async (request, response) => {
    const parsed = testSecretSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      badRequest(response, 'Invalid secret test request.', parsed.error.issues);
      return;
    }

    try {
      const result = await deps.secrets.testSecret(parsed.data.secretKey);
      response.json(result);
    } catch (error) {
      routeError(response, error);
    }
  });

  app.get('/v1/memory/patterns', (request, response) => {
    const parsed = memoryListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      badRequest(response, 'Invalid memory list request.', parsed.error.issues);
      return;
    }

    try {
      const limit = parsed.data.limit ?? 200;
      const cards = deps.store.listMemoryCards({ limit, scope: 'policy', status: 'active' });
      response.json({
        ok: true,
        summary: deps.store.getMemorySummary(),
        health: deps.store.getMemoryCardSummary(),
        patterns: deps.store.listMemoryPatterns(limit),
        cards: cards.map((card) => ({
          id: card.id,
          host: card.domain ?? 'global',
          commandType: card.intentKey ?? 'policy',
          successes: card.successCount,
          failures: card.failureCount,
          autoApprove: card.reliability >= 0.78 && card.failureCount === 0,
          reliability: card.reliability,
          confidence: card.confidence,
          summary: card.summary,
          status: card.status,
        })),
      });
    } catch (error) {
      routeError(response, error);
    }
  });

  app.get('/v1/memory/cards', (request, response) => {
    const parsed = memoryCardsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      badRequest(response, 'Invalid memory cards request.', parsed.error.issues);
      return;
    }

    try {
      const limit = parsed.data.limit ?? 120;
      const cards = deps.store.listMemoryCards({
        limit,
        scope: parsed.data.scope,
        status: parsed.data.status,
        domain: parsed.data.domain,
        query: parsed.data.query,
      });

      response.json({
        ok: true,
        settings: deps.store.getMemorySettings(),
        summary: deps.store.getMemoryCardSummary(),
        cards,
      });
    } catch (error) {
      routeError(response, error);
    }
  });

  app.post('/v1/memory/cards/:memoryCardId', (request, response) => {
    const memoryCardId = request.params.memoryCardId;
    const parsed = memoryCardUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      badRequest(response, 'Invalid memory card update request.', parsed.error.issues);
      return;
    }

    try {
      const updated = deps.store.updateMemoryCard({
        id: memoryCardId,
        title: parsed.data.title,
        summary: parsed.data.summary,
        status: parsed.data.status,
      });

      if (!updated) {
        notFound(response, `Memory card '${memoryCardId}' was not found.`);
        return;
      }

      deps.audit.record('memory.card_updated', 'Memory card updated', {
        memoryCardId,
        status: updated.status,
      });

      response.json({
        ok: true,
        card: updated,
      });
    } catch (error) {
      routeError(response, error);
    }
  });

  app.post('/v1/memory/cards/:memoryCardId/delete', (request, response) => {
    const memoryCardId = request.params.memoryCardId;
    try {
      const deleted = deps.store.softDeleteMemoryCard(memoryCardId);
      if (!deleted) {
        notFound(response, `Memory card '${memoryCardId}' was not found.`);
        return;
      }

      deps.audit.record('memory.card_deleted', 'Memory card deleted', { memoryCardId });
      response.json({ ok: true, memoryCardId });
    } catch (error) {
      routeError(response, error);
    }
  });

  app.get('/v1/memory/decisions', (request, response) => {
    const parsed = memoryDecisionQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      badRequest(response, 'Invalid memory decision list request.', parsed.error.issues);
      return;
    }

    try {
      const limit = parsed.data.limit ?? 120;
      response.json({
        ok: true,
        decisions: deps.store.listMemoryDecisions(limit),
      });
    } catch (error) {
      routeError(response, error);
    }
  });

  app.get('/v1/memory/settings', (_request, response) => {
    try {
      response.json({
        ok: true,
        settings: deps.store.getMemorySettings(),
      });
    } catch (error) {
      routeError(response, error);
    }
  });

  app.post('/v1/memory/settings/no-store', (request, response) => {
    const parsed = memoryNoStoreSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      badRequest(response, 'Invalid memory no-store request.', parsed.error.issues);
      return;
    }

    try {
      const settings = deps.store.setMemoryNoStore(parsed.data.enabled);
      deps.audit.record('memory.no_store_set', 'Memory no-store mode updated', settings);
      response.json({
        ok: true,
        settings,
      });
    } catch (error) {
      routeError(response, error);
    }
  });

  app.post('/v1/memory/patterns/reset', (_request, response) => {
    try {
      const deleted = deps.store.clearMemoryAutomation();
      deps.audit.record('memory.reset', 'Autonomous memory cleared', deleted);
      response.json({
        ok: true,
        deleted,
      });
    } catch (error) {
      routeError(response, error);
    }
  });
}
