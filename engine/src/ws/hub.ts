import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AuditLogger } from '../audit/log.js';
import { extensionToEngineEventSchema, type EngineToExtensionEvent, type ExtensionToEngineEvent } from '../protocol/events.js';
import type { BrowserAgentStore } from '../session/store.js';

export type ExtensionEventHandler = (extensionId: string, event: ExtensionToEngineEvent) => void;
export type ExtensionDisconnectHandler = (extensionId: string) => void;

interface ExtensionSocket {
  readonly extensionId: string;
  readonly socket: WebSocket;
  ready: boolean;
  readonly connectedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseWsUrl(request: IncomingMessage): URL {
  const rawHost = request.headers.host ?? '127.0.0.1';
  const rawUrl = request.url ?? '/';
  return new URL(rawUrl, `http://${rawHost}`);
}

function safeSend(socket: WebSocket, payload: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly eventHandlers = new Set<ExtensionEventHandler>();
  private readonly disconnectHandlers = new Set<ExtensionDisconnectHandler>();
  private readonly sockets = new Map<string, ExtensionSocket>();
  private primaryExtensionId: string | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly server: HttpServer,
    private readonly store: BrowserAgentStore,
    private readonly audit: AuditLogger,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  public start(): void {
    this.server.on('upgrade', (request, socket, head) => {
      const requestUrl = parseWsUrl(request);
      if (requestUrl.pathname !== '/v1/ws') {
        return;
      }

      const extensionId = requestUrl.searchParams.get('extensionId')?.trim() ?? '';
      const token = requestUrl.searchParams.get('token')?.trim() ?? '';
      const hasValidToken = Boolean(token) && this.store.validateWsToken(token, extensionId);
      const isTrustedExtension = Boolean(extensionId) && this.store.isTrustedExtensionActive(extensionId);

      if (!extensionId || (!hasValidToken && !isTrustedExtension)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const origin = request.headers.origin;
      if (origin && origin !== `chrome-extension://${extensionId}`) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      if (!hasValidToken && isTrustedExtension) {
        this.audit.record(
          'ws.auth_fallback',
          `WebSocket accepted for trusted extension ${extensionId} without a valid token`,
          { extensionId },
        );
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (socket, request) => {
      const requestUrl = parseWsUrl(request);
      const extensionId = requestUrl.searchParams.get('extensionId')?.trim() ?? '';
      if (!extensionId) {
        socket.close(1008, 'missing-extension-id');
        return;
      }

      const existing = this.sockets.get(extensionId);
      if (existing && existing.socket.readyState === WebSocket.OPEN) {
        existing.socket.close(1012, 'replaced-by-new-connection');
      }

      const record: ExtensionSocket = {
        extensionId,
        socket,
        ready: false,
        connectedAt: nowIso(),
      };

      this.sockets.set(extensionId, record);
      this.primaryExtensionId = extensionId;
      this.store.touchTrustedExtension(extensionId);

      this.audit.record('ws.connected', `Extension ${extensionId} connected via WebSocket`, {
        extensionId,
      });

      socket.on('message', (raw) => {
        const text = raw.toString('utf8');
        let parsedUnknown: unknown;
        try {
          parsedUnknown = JSON.parse(text);
        } catch {
          this.audit.record('ws.bad_json', 'Received non-JSON WebSocket message', { extensionId });
          return;
        }

        const parsed = extensionToEngineEventSchema.safeParse(parsedUnknown);
        if (!parsed.success) {
          this.audit.record('ws.bad_event', 'Received invalid extension event payload', {
            extensionId,
            issues: parsed.error.issues,
          });
          return;
        }

        const event = parsed.data;
        if (event.type === 'extension.ready') {
          record.ready = true;
        }

        for (const handler of this.eventHandlers) {
          handler(extensionId, event);
        }
      });

      socket.on('close', () => {
        this.sockets.delete(extensionId);
        if (this.primaryExtensionId === extensionId) {
          this.primaryExtensionId = this.pickPrimaryExtensionId();
        }

        this.audit.record('ws.disconnected', `Extension ${extensionId} disconnected`, {
          extensionId,
        });

        for (const handler of this.disconnectHandlers) {
          handler(extensionId);
        }
      });

      socket.on('error', (error) => {
        this.audit.record('ws.error', `WebSocket error for ${extensionId}: ${error.message}`, {
          extensionId,
          message: error.message,
        });
      });
    });

    this.pingTimer = setInterval(() => {
      const payload: EngineToExtensionEvent = {
        type: 'engine.ping',
        data: {
          timestamp: nowIso(),
        },
      };
      this.sendToPrimary(payload);
    }, 25_000);

    if (typeof this.pingTimer.unref === 'function') {
      this.pingTimer.unref();
    }
  }

  public stop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    for (const entry of this.sockets.values()) {
      try {
        entry.socket.close(1001, 'engine-shutdown');
      } catch {
        // no-op
      }
    }

    this.sockets.clear();
    this.primaryExtensionId = null;
    this.wss.close();
  }

  public onEvent(handler: ExtensionEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  public onDisconnect(handler: ExtensionDisconnectHandler): () => void {
    this.disconnectHandlers.add(handler);
    return () => {
      this.disconnectHandlers.delete(handler);
    };
  }

  public hasReadyExtension(): boolean {
    if (!this.primaryExtensionId) {
      return false;
    }

    const record = this.sockets.get(this.primaryExtensionId);
    return Boolean(record && record.ready && record.socket.readyState === WebSocket.OPEN);
  }

  public sendToPrimary(event: EngineToExtensionEvent): boolean {
    if (!this.primaryExtensionId) {
      return false;
    }

    const record = this.sockets.get(this.primaryExtensionId);
    if (!record) {
      return false;
    }

    return safeSend(record.socket, event);
  }

  public getPrimaryExtensionId(): string | null {
    return this.primaryExtensionId;
  }

  private pickPrimaryExtensionId(): string | null {
    for (const [extensionId, record] of this.sockets.entries()) {
      if (record.socket.readyState === WebSocket.OPEN) {
        return extensionId;
      }
    }
    return null;
  }
}
