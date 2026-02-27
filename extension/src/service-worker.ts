import { isAllowedUrl } from './allowlist.js';
import type {
  BrowserCommand,
  CommandType,
  EngineToExtensionEvent,
  ExtensionMessage,
  ExtensionMessageResponse,
  ExtensionToEngineEvent,
} from './types.js';

interface PersistedState {
  engineBaseUrl: string | null;
  wsUrl: string | null;
  wsToken: string | null;
  wsTokenExpiresAt: string | null;
  extensionId: string | null;
  pairedAt: string | null;
  sessionId: string | null;
  boundTabId: number | null;
  boundWindowId: number | null;
  panelOpen: boolean;
  paused: boolean;
  pendingCommand: Record<string, unknown> | null;
}

interface RuntimeFlags {
  wsConnected: boolean;
  wsConnecting: boolean;
  reconnectScheduled: boolean;
  lastError: string | null;
  confirmationToken: string | null;
}

interface CommandExecutionSuccess {
  ok: true;
  result: Record<string, unknown>;
}

interface CommandExecutionFailure {
  ok: false;
  error: string;
}

const STORAGE_KEYS = [
  'engineBaseUrl',
  'wsUrl',
  'wsToken',
  'wsTokenExpiresAt',
  'extensionId',
  'pairedAt',
  'sessionId',
  'boundTabId',
  'boundWindowId',
  'panelOpen',
  'paused',
  'pendingCommand',
] as const;

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
const flags: RuntimeFlags = {
  wsConnected: false,
  wsConnecting: false,
  reconnectScheduled: false,
  lastError: null,
  confirmationToken: null,
};

let pausedRuntime = false;
let pendingCommandEvent: Extract<EngineToExtensionEvent, { type: 'engine.command' }> | null = null;

interface WorkflowPlan {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly BrowserCommand[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function storageGet(keys: readonly string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    chrome.storage.local.get([...keys], (items) => {
      resolve(items as Record<string, unknown>);
    });
  });
}

function storageSet(values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function tabsGet(tabId: number): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      if (!tab) {
        reject(new Error(`Tab ${tabId} was not found.`));
        return;
      }

      resolve(tab);
    });
  });
}

function tabsQuery(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(query, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(tabs ?? []);
    });
  });
}

function tabsCreate(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(properties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      if (!tab) {
        reject(new Error('Failed to create browser tab.'));
        return;
      }

      resolve(tab);
    });
  });
}

function tabsUpdate(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      if (!tab) {
        reject(new Error(`Failed to update tab ${tabId}.`));
        return;
      }

      resolve(tab);
    });
  });
}

function windowsUpdate(windowId: number, updateInfo: chrome.windows.UpdateInfo): Promise<chrome.windows.Window> {
  return new Promise((resolve, reject) => {
    chrome.windows.update(windowId, updateInfo, (windowValue) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      if (!windowValue) {
        reject(new Error(`Failed to update window ${windowId}.`));
        return;
      }

      resolve(windowValue);
    });
  });
}

function tabsSendMessage(tabId: number, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

function scriptingExecuteScript(target: chrome.scripting.InjectionTarget, files: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target, files: [...files] }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function captureVisibleTab(windowId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      if (!dataUrl) {
        reject(new Error('Failed to capture visible tab screenshot.'));
        return;
      }

      resolve(dataUrl);
    });
  });
}

function sendRuntimeMessage(payload: unknown): void {
  try {
    chrome.runtime.sendMessage(payload, () => {
      // Side panel/options listeners are ephemeral. Ignore missing-receiver errors.
      void chrome.runtime.lastError;
    });
  } catch {
    // no listeners available
  }
}

function sendRuntimeNotice(kind: 'info' | 'ok' | 'err', message: string): void {
  sendRuntimeMessage({
    type: 'agent.runtime.notice',
    payload: {
      kind,
      message,
      timestamp: new Date().toISOString(),
    },
  });
}

async function configureActionSidePanelBehavior(): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // Ignore capability/version mismatches. Explicit open handler is also wired.
  }
}

async function openSidePanelForActionClick(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.windowId === undefined) {
    return;
  }

  try {
    if (tab.id !== undefined) {
      await chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: 'sidepanel.html',
        enabled: true,
      });
      await chrome.sidePanel.open({ tabId: tab.id });
      return;
    }

    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) {
    flags.lastError = error instanceof Error ? error.message : String(error);
    const state = await getPersistedState();
    sendRuntimeMessage({ type: 'agent.runtime.state', payload: runtimeStateSnapshot(state) });
  }
}

function parseString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

async function getPersistedState(): Promise<PersistedState> {
  const raw = await storageGet(STORAGE_KEYS);

  return {
    engineBaseUrl: parseString(raw.engineBaseUrl),
    wsUrl: parseString(raw.wsUrl),
    wsToken: parseString(raw.wsToken),
    wsTokenExpiresAt: parseString(raw.wsTokenExpiresAt),
    extensionId: parseString(raw.extensionId),
    pairedAt: parseString(raw.pairedAt),
    sessionId: parseString(raw.sessionId),
    boundTabId: parseNumber(raw.boundTabId),
    boundWindowId: parseNumber(raw.boundWindowId),
    panelOpen: parseBoolean(raw.panelOpen, false),
    paused: parseBoolean(raw.paused, false),
    pendingCommand: isRecord(raw.pendingCommand) ? raw.pendingCommand : null,
  };
}

async function patchPersistedState(patch: Partial<PersistedState>): Promise<void> {
  await storageSet(patch as Record<string, unknown>);
}

function runtimeStateSnapshot(state: PersistedState): Record<string, unknown> {
  return {
    wsConnected: flags.wsConnected,
    wsConnecting: flags.wsConnecting,
    reconnectScheduled: flags.reconnectScheduled,
    lastError: flags.lastError,
    sessionId: state.sessionId,
    confirmationToken: flags.confirmationToken,
    boundTabId: state.boundTabId,
    boundWindowId: state.boundWindowId,
    panelOpen: state.panelOpen,
    engineBaseUrl: state.engineBaseUrl,
    pairedAt: state.pairedAt,
    extensionId: state.extensionId,
    wsTokenExpiresAt: state.wsTokenExpiresAt,
    paused: state.paused,
    pendingCommand: state.pendingCommand ? 'queued' : null,
  };
}

async function emitState(status: string): Promise<void> {
  const state = await getPersistedState();

  const activeTab = await resolveActiveTabForState(state);

  const event: ExtensionToEngineEvent = {
    type: 'extension.state',
    data: {
      activeTabId: activeTab?.id,
      activeTabUrl: activeTab?.url,
      panelOpen: state.panelOpen,
      status,
      timestamp: new Date().toISOString(),
    },
  };

  sendWsEvent(event);
  sendRuntimeMessage({
    type: 'agent.runtime.state',
    payload: runtimeStateSnapshot(state),
  });
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    self.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  flags.reconnectScheduled = false;
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) {
    return;
  }

  flags.reconnectScheduled = true;
  reconnectTimer = self.setTimeout(() => {
    reconnectTimer = null;
    flags.reconnectScheduled = false;
    void connectWebSocket();
  }, 2500);
}

function sendWsEvent(event: ExtensionToEngineEvent): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    socket.send(JSON.stringify(event));
    return true;
  } catch {
    return false;
  }
}

function isTokenExpired(expiresAtIso: string | null): boolean {
  if (!expiresAtIso) {
    return false;
  }

  const expiresAt = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresAt)) {
    return false;
  }

  // Treat near-expiry as expired to avoid handshake races.
  return expiresAt <= Date.now() + 5_000;
}

function toWsUrl(baseUrl: string, extensionId: string, token: string): string {
  const httpUrl = new URL(baseUrl);
  const protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = new URL(`${protocol}//${httpUrl.host}/v1/ws`);
  wsUrl.searchParams.set('extensionId', extensionId);
  wsUrl.searchParams.set('token', token);
  return wsUrl.toString();
}

async function connectWebSocket(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  let state = await getPersistedState();
  pausedRuntime = state.paused;
  if (!state.engineBaseUrl) {
    flags.lastError = 'Engine URL is not configured. Save engine URL first.';
    sendRuntimeMessage({ type: 'agent.runtime.state', payload: runtimeStateSnapshot(state) });
    return;
  }

  if (isTokenExpired(state.wsTokenExpiresAt)) {
    await patchPersistedState({
      wsUrl: null,
      wsToken: null,
      wsTokenExpiresAt: null,
      pairedAt: null,
    });
    state = await getPersistedState();
    sendRuntimeNotice('info', 'Bridge token expired. Re-pairing automatically.');
  }

  if (!state.wsToken) {
    const autoPairBaseUrl = state.engineBaseUrl;
    if (!autoPairBaseUrl) {
      flags.lastError = 'Engine URL is not configured. Save engine URL first.';
      sendRuntimeMessage({ type: 'agent.runtime.state', payload: runtimeStateSnapshot(state) });
      return;
    }

    try {
      await autoPairExtension(autoPairBaseUrl);
      state = await getPersistedState();
    } catch (error) {
      flags.lastError = error instanceof Error ? error.message : String(error);
      sendRuntimeNotice('err', flags.lastError);
      sendRuntimeMessage({ type: 'agent.runtime.state', payload: runtimeStateSnapshot(state) });
      return;
    }
  }

  if (!state.wsToken) {
    flags.lastError = 'Automatic pairing failed: ws token not available.';
    sendRuntimeNotice('err', flags.lastError);
    sendRuntimeMessage({ type: 'agent.runtime.state', payload: runtimeStateSnapshot(state) });
    return;
  }

  const extensionId = chrome.runtime.id;
  const engineBaseUrl = state.engineBaseUrl;
  const wsToken = state.wsToken;
  if (!engineBaseUrl || !wsToken) {
    flags.lastError = 'Automatic pairing failed: missing engine URL or token.';
    sendRuntimeNotice('err', flags.lastError);
    sendRuntimeMessage({ type: 'agent.runtime.state', payload: runtimeStateSnapshot(state) });
    return;
  }
  const wsUrl = state.wsUrl ?? toWsUrl(engineBaseUrl, extensionId, wsToken);

  await patchPersistedState({ wsUrl, extensionId });

  flags.wsConnecting = true;
  flags.wsConnected = false;
  flags.lastError = null;
  clearReconnectTimer();

  const ws = new WebSocket(wsUrl);
  let opened = false;
  socket = ws;

  ws.onopen = () => {
    opened = true;
    flags.wsConnecting = false;
    flags.wsConnected = true;
    flags.lastError = null;
    sendRuntimeNotice('ok', 'Bridge connected.');

    const readyEvent: ExtensionToEngineEvent = {
      type: 'extension.ready',
      data: {
        extensionId,
        version: chrome.runtime.getManifest().version,
      },
    };

    sendWsEvent(readyEvent);
    void emitState('connected');
    void flushPendingCommandIfResumed();
  };

  ws.onmessage = (event) => {
    void handleEngineWsMessage(event.data);
  };

  ws.onerror = () => {
    flags.lastError = 'WebSocket connection error.';
    sendRuntimeNotice('err', 'Bridge connection error.');
  };

  ws.onclose = () => {
    flags.wsConnecting = false;
    flags.wsConnected = false;
    if (socket === ws) {
      socket = null;
    }

    if (!opened) {
      void patchPersistedState({
        wsUrl: null,
        wsToken: null,
        wsTokenExpiresAt: null,
        pairedAt: null,
      });
      sendRuntimeNotice('info', 'Bridge authentication refreshed. Reconnecting...');
    }

    void emitState('disconnected');
    sendRuntimeNotice('err', 'Bridge disconnected. Reconnecting...');
    scheduleReconnect();
  };
}

async function autoPairExtension(engineBaseUrl: string): Promise<void> {
  const state = await getPersistedState();
  if (state.wsToken && state.wsUrl) {
    return;
  }

  const pairingStart = await engineRequest('POST', '/v1/pairing/start', {
    issuedBy: 'extension-auto',
  });

  const pairingCode = parseString(pairingStart.pairingCode);
  if (!pairingCode) {
    throw new Error('Engine did not return a pairing code for automatic pairing.');
  }

  const pairingComplete = await engineRequest('POST', '/v1/pairing/complete', {
    code: pairingCode,
    extensionId: chrome.runtime.id,
  });

  const wsToken = parseString(pairingComplete.wsToken);
  if (!wsToken) {
    throw new Error('Engine did not return wsToken during automatic pairing.');
  }

  const wsUrl =
    parseString(pairingComplete.wsUrl) ?? toWsUrl(engineBaseUrl, chrome.runtime.id, wsToken);
  const wsTokenExpiresAt = parseString(pairingComplete.wsTokenExpiresAt);
  const pairedAt = parseString(pairingComplete.pairedAt) ?? new Date().toISOString();

  await patchPersistedState({
    extensionId: chrome.runtime.id,
    pairedAt,
    wsUrl,
    wsToken,
    wsTokenExpiresAt,
  });

  sendRuntimeNotice('ok', 'Paired automatically.');
}

async function ensurePairedAndConnected(): Promise<void> {
  const state = await getPersistedState();
  if (!state.engineBaseUrl) {
    throw new Error('Engine URL is not configured. Save engine URL first.');
  }

  if (!state.wsToken) {
    await autoPairExtension(state.engineBaseUrl);
  }

  await connectWebSocket();
}

async function syncSessionFromEngineActive(): Promise<{ sessionId: string; confirmationToken: string | null } | null> {
  const response = await engineRequest('GET', '/v1/sessions/active');
  const session = isRecord(response.session) ? response.session : null;
  const sessionId = session && typeof session.id === 'string' ? session.id : null;
  const confirmationToken = session && typeof session.confirmationToken === 'string' ? session.confirmationToken : null;

  if (!sessionId) {
    flags.confirmationToken = null;
    pausedRuntime = false;
    pendingCommandEvent = null;
    await patchPersistedState({ sessionId: null, paused: false, pendingCommand: null });
    await emitState('session-none');
    return null;
  }

  flags.confirmationToken = confirmationToken;
  pausedRuntime = false;
  pendingCommandEvent = null;
  await patchPersistedState({ sessionId, paused: false, pendingCommand: null });
  await emitState('session-synced');

  return { sessionId, confirmationToken };
}

async function persistPauseState(paused: boolean): Promise<void> {
  pausedRuntime = paused;
  await patchPersistedState({ paused });
  await emitState(paused ? 'paused' : 'resumed');
  sendRuntimeNotice('info', paused ? 'Session paused. Commands will wait.' : 'Session resumed.');
}

async function loadPendingCommandFromState(): Promise<void> {
  if (pendingCommandEvent) {
    return;
  }

  const state = await getPersistedState();
  if (!isRecord(state.pendingCommand)) {
    return;
  }

  if (
    state.pendingCommand.type === 'engine.command' &&
    isRecord(state.pendingCommand.data)
  ) {
    const rawData = state.pendingCommand.data;
    if (
      typeof rawData.commandId === 'string' &&
      typeof rawData.sessionId === 'string' &&
      typeof rawData.commandType === 'string' &&
      isRecord(rawData.payload) &&
      typeof rawData.createdAt === 'string'
    ) {
      pendingCommandEvent = {
        type: 'engine.command',
        data: {
          commandId: rawData.commandId,
          sessionId: rawData.sessionId,
          commandType: rawData.commandType as CommandType,
          payload: rawData.payload,
          createdAt: rawData.createdAt,
        },
      };
    }
  }
}

async function flushPendingCommandIfResumed(): Promise<void> {
  if (pausedRuntime) {
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  await loadPendingCommandFromState();
  if (!pendingCommandEvent) {
    return;
  }

  const event = pendingCommandEvent;
  pendingCommandEvent = null;
  await patchPersistedState({ pendingCommand: null });
  if (pausedRuntime) {
    pendingCommandEvent = event;
    await patchPersistedState({ pendingCommand: event as unknown as Record<string, unknown> });
    await emitState('paused-waiting');
    return;
  }

  await handleEngineCommand(event);
}

function parseEngineEvent(raw: unknown): EngineToExtensionEvent | null {
  if (typeof raw !== 'string') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const type = parsed.type;
  const data = parsed.data;
  if (typeof type !== 'string' || !isRecord(data)) {
    return null;
  }

  if (type === 'engine.command') {
    if (
      typeof data.commandId === 'string' &&
      typeof data.sessionId === 'string' &&
      typeof data.commandType === 'string' &&
      isRecord(data.payload) &&
      typeof data.createdAt === 'string'
    ) {
      return {
        type,
        data: {
          commandId: data.commandId,
          sessionId: data.sessionId,
          commandType: data.commandType as CommandType,
          payload: data.payload,
          createdAt: data.createdAt,
        },
      };
    }

    return null;
  }

  if (type === 'engine.cancel') {
    if (typeof data.commandId === 'string' && typeof data.sessionId === 'string') {
      return {
        type,
        data: {
          commandId: data.commandId,
          sessionId: data.sessionId,
        },
      };
    }

    return null;
  }

  if (type === 'engine.ping') {
    if (typeof data.timestamp === 'string') {
      return {
        type,
        data: {
          timestamp: data.timestamp,
        },
      };
    }

    return null;
  }

  return null;
}

async function waitForTabLoad(tabId: number, timeoutMs = 45_000): Promise<void> {
  const existing = await tabsGet(tabId);
  if (existing.status === 'complete') {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const timeoutHandle = self.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out waiting for tab ${tabId} to finish loading.`));
    }, timeoutMs);

    const listener = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo): void => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete' || settled) {
        return;
      }

      settled = true;
      self.clearTimeout(timeoutHandle);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function resolveActiveTabForState(state: PersistedState): Promise<chrome.tabs.Tab | null> {
  if (state.boundTabId !== null) {
    try {
      return await tabsGet(state.boundTabId);
    } catch {
      await patchPersistedState({ boundTabId: null, boundWindowId: null });
    }
  }

  const tabs = await tabsQuery({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

async function ensureBoundTab(preferredUrl?: string): Promise<chrome.tabs.Tab> {
  const state = await getPersistedState();

  if (state.boundTabId !== null) {
    try {
      const current = await tabsGet(state.boundTabId);
      if (current.id !== undefined && current.windowId !== undefined) {
        return current;
      }
    } catch {
      await patchPersistedState({ boundTabId: null, boundWindowId: null });
    }
  }

  const activeTabs = await tabsQuery({ active: true, currentWindow: true });
  const activeAllowed = activeTabs.find((tab) => typeof tab.url === 'string' && isAllowedUrl(tab.url));
  if (activeAllowed?.id !== undefined && activeAllowed.windowId !== undefined) {
    await patchPersistedState({
      boundTabId: activeAllowed.id,
      boundWindowId: activeAllowed.windowId,
    });

    return activeAllowed;
  }

  const fallbackUrl = preferredUrl && isAllowedUrl(preferredUrl) ? preferredUrl : 'https://github.com';
  const created = await tabsCreate({ url: fallbackUrl, active: true });
  if (created.id === undefined || created.windowId === undefined) {
    throw new Error('Failed to create an automation tab for BrowserAgent.');
  }

  await patchPersistedState({
    boundTabId: created.id,
    boundWindowId: created.windowId,
  });

  return created;
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await tabsSendMessage(tabId, { type: 'browser-agent.ping' });
  } catch {
    await scriptingExecuteScript({ tabId }, ['content-script.runtime.js']);
  }
}

async function executeContentCommand(tabId: number, command: BrowserCommand): Promise<Record<string, unknown>> {
  await ensureContentScript(tabId);

  const raw = await tabsSendMessage(tabId, {
    type: 'browser-agent.execute',
    command,
  });

  if (!isRecord(raw)) {
    throw new Error('Content script returned an invalid response payload.');
  }

  const ok = raw.ok;
  if (ok !== true) {
    const message = typeof raw.error === 'string' ? raw.error : 'Unknown content-script command failure.';
    throw new Error(message);
  }

  const result = raw.result;
  if (!isRecord(result)) {
    return {};
  }

  return result;
}

function sanitizeCommandPayload(payload: Record<string, unknown>): BrowserCommand {
  return payload as unknown as BrowserCommand;
}

function parseGitHubRepoContext(url: string | null | undefined): { owner: string; repo: string } | null {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('github.com')) {
      return null;
    }

    const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
    if (!owner || !repo) {
      return null;
    }

    return { owner, repo: repo.replace(/\.git$/i, '') };
  } catch {
    return null;
  }
}

function parseVercelProjectContext(url: string | null | undefined): { team: string; project: string } | null {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('vercel.com')) {
      return null;
    }

    const [team, project] = parsed.pathname.split('/').filter(Boolean);
    if (!team || !project) {
      return null;
    }

    return { team, project };
  } catch {
    return null;
  }
}

function buildWorkflowPlan(workflowId: string, activeTabUrl: string | null): WorkflowPlan {
  const githubRepo = parseGitHubRepoContext(activeTabUrl);
  const vercelProject = parseVercelProjectContext(activeTabUrl);

  if (workflowId === 'github_repo_actions') {
    if (!githubRepo) {
      throw new Error('Open a GitHub repository tab first, then run "GitHub Actions (Repo)".');
    }
    return {
      id: workflowId,
      label: 'GitHub Actions (Repo)',
      commands: [{ type: 'navigate', url: `https://github.com/${githubRepo.owner}/${githubRepo.repo}/actions` }],
    };
  }

  if (workflowId === 'github_repo_secrets') {
    if (!githubRepo) {
      throw new Error('Open a GitHub repository tab first, then run "GitHub Secrets (Repo)".');
    }
    return {
      id: workflowId,
      label: 'GitHub Secrets (Repo)',
      commands: [{ type: 'navigate', url: `https://github.com/${githubRepo.owner}/${githubRepo.repo}/settings/secrets/actions` }],
    };
  }

  if (workflowId === 'vercel_project_settings') {
    if (vercelProject) {
      return {
        id: workflowId,
        label: 'Vercel Project Settings',
        commands: [{ type: 'navigate', url: `https://vercel.com/${vercelProject.team}/${vercelProject.project}/settings` }],
      };
    }

    return {
      id: workflowId,
      label: 'Vercel Dashboard',
      commands: [{ type: 'navigate', url: 'https://vercel.com/dashboard' }],
    };
  }

  if (workflowId === 'ops_control_room') {
    return {
      id: workflowId,
      label: 'Ops Control Room',
      commands: [
        { type: 'tab_open', url: 'https://github.com/notifications', active: false },
        { type: 'tab_open', url: 'https://vercel.com/dashboard', active: false },
        { type: 'tab_open', url: 'https://dash.cloudflare.com', active: false },
        { type: 'tab_open', url: 'https://console.neon.tech/app/projects', active: false },
        { type: 'tab_focus' },
      ],
    };
  }

  throw new Error(`Unknown workflow '${workflowId}'.`);
}

async function resolveSessionIdForControlPlane(): Promise<string | null> {
  const state = await getPersistedState();
  if (state.sessionId) {
    return state.sessionId;
  }

  const synced = await syncSessionFromEngineActive();
  return synced?.sessionId ?? null;
}

async function executeCommand(commandRaw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const command = sanitizeCommandPayload(commandRaw);

  if (command.type === 'navigate') {
    if (!isAllowedUrl(command.url)) {
      throw new Error('Navigate command URL is outside GitHub/Vercel allowlist.');
    }

    const tab = await ensureBoundTab(command.url);
    if (tab.id === undefined) {
      throw new Error('Bound tab has no id.');
    }

    await tabsUpdate(tab.id, { url: command.url, active: true });
    await waitForTabLoad(tab.id);

    const updated = await tabsGet(tab.id);
    if (updated.windowId !== undefined) {
      await patchPersistedState({ boundWindowId: updated.windowId });
    }

    return {
      tabId: updated.id,
      url: updated.url,
      title: updated.title,
    };
  }

  if (command.type === 'tab_open') {
    if (!isAllowedUrl(command.url)) {
      throw new Error('tab_open URL is outside GitHub/Vercel allowlist.');
    }

    const tab = await ensureBoundTab(command.url);
    if (tab.id === undefined) {
      throw new Error('Bound tab has no id.');
    }

    await tabsUpdate(tab.id, {
      url: command.url,
      active: command.active ?? true,
    });
    await waitForTabLoad(tab.id);

    return {
      tabId: tab.id,
      url: command.url,
    };
  }

  if (command.type === 'tab_focus') {
    const targetTabId = command.tabId ?? (await getPersistedState()).boundTabId;
    if (!targetTabId) {
      throw new Error('No bound tab exists for tab_focus command.');
    }

    const targetTab = await tabsGet(targetTabId);
    if (targetTab.windowId === undefined) {
      throw new Error('Focused tab does not include a windowId.');
    }

    await windowsUpdate(targetTab.windowId, { focused: true });
    await tabsUpdate(targetTabId, { active: true });

    await patchPersistedState({
      boundTabId: targetTabId,
      boundWindowId: targetTab.windowId,
    });

    return {
      tabId: targetTabId,
      windowId: targetTab.windowId,
      focused: true,
    };
  }

  if (command.type === 'screenshot') {
    const tab = await ensureBoundTab();
    if (tab.windowId === undefined) {
      throw new Error('Cannot capture screenshot because window id is missing.');
    }

    const dataUrl = await captureVisibleTab(tab.windowId);

    return {
      tabId: tab.id,
      windowId: tab.windowId,
      dataUrl,
    };
  }

  const tab = await ensureBoundTab();
  if (tab.id === undefined) {
    throw new Error('No bound tab id available for command execution.');
  }

  const tabUrl = tab.url ?? '';
  if (!isAllowedUrl(tabUrl)) {
    throw new Error('Active tab is outside GitHub/Vercel allowlist.');
  }

  const result = await executeContentCommand(tab.id, command);
  return {
    tabId: tab.id,
    ...result,
  };
}

async function reportCommandResult(
  commandId: string,
  status: 'success' | 'error',
  durationMs: number,
  result?: Record<string, unknown>,
  error?: string,
): Promise<void> {
  const event: ExtensionToEngineEvent = {
    type: 'extension.result',
    data: {
      commandId,
      status,
      durationMs,
      result,
      error,
    },
  };

  sendWsEvent(event);
}

async function handleEngineCommand(event: Extract<EngineToExtensionEvent, { type: 'engine.command' }>): Promise<void> {
  const startedAt = Date.now();

  await patchPersistedState({ sessionId: event.data.sessionId });

  try {
    const result = await executeCommand(event.data.payload);
    const durationMs = Date.now() - startedAt;
    await reportCommandResult(event.data.commandId, 'success', durationMs, result);
    sendRuntimeNotice('ok', `Done: ${event.data.commandType}`);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    await reportCommandResult(event.data.commandId, 'error', durationMs, undefined, message);
    sendRuntimeNotice('err', `Failed: ${event.data.commandType} (${message})`);
  }

  await emitState('idle');
}

async function handleEngineWsMessage(raw: unknown): Promise<void> {
  const event = parseEngineEvent(raw);
  if (!event) {
    return;
  }

  if (event.type === 'engine.ping') {
    sendWsEvent({
      type: 'extension.pong',
      data: {
        timestamp: new Date().toISOString(),
      },
    });

    return;
  }

  if (event.type === 'engine.cancel') {
    sendRuntimeNotice('info', 'Engine requested cancel. In-flight cancel is not supported in v1.');
    sendWsEvent({
      type: 'extension.error',
      data: {
        commandId: event.data.commandId,
        code: 'cancel_not_supported',
        message: 'Cancellation is not implemented for in-flight commands in v1.',
      },
    });

    return;
  }

  if (pausedRuntime) {
    pendingCommandEvent = event;
    await patchPersistedState({ pendingCommand: event as unknown as Record<string, unknown> });
    await emitState('paused-waiting');
    sendRuntimeNotice('info', 'Paused: one command queued. Resume to continue.');
    return;
  }

  await handleEngineCommand(event);
}

async function engineRequest(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const state = await getPersistedState();
  if (!state.engineBaseUrl) {
    throw new Error('Engine URL is not configured. Save engine URL first.');
  }

  const response = await fetch(`${state.engineBaseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    if (isRecord(parsed) && typeof parsed.error === 'string') {
      throw new Error(parsed.error);
    }

    throw new Error(`Engine request failed with status ${response.status}.`);
  }

  if (!isRecord(parsed)) {
    throw new Error('Engine returned a non-object JSON payload.');
  }

  return parsed;
}

async function handleMessage(message: ExtensionMessage): Promise<ExtensionMessageResponse> {
  if (!message.type) {
    return { ok: false, error: 'Missing message type.' };
  }

  if (message.type === 'agent.get.runtime') {
    const state = await getPersistedState();
    return {
      ok: true,
      data: runtimeStateSnapshot(state),
    };
  }

  if (message.type === 'agent.panel.open') {
    await patchPersistedState({ panelOpen: true });
    await emitState('panel-open');
    return { ok: true };
  }

  if (message.type === 'agent.panel.close') {
    await patchPersistedState({ panelOpen: false });
    await emitState('panel-close');
    return { ok: true };
  }

  if (message.type === 'agent.engine.set_url') {
    const engineBaseUrl = message.payload?.engineBaseUrl;
    if (typeof engineBaseUrl !== 'string' || engineBaseUrl.trim().length === 0) {
      return { ok: false, error: 'engineBaseUrl must be a non-empty string.' };
    }

    await patchPersistedState({ engineBaseUrl: engineBaseUrl.trim() });
    return { ok: true, data: { engineBaseUrl: engineBaseUrl.trim() } };
  }

  if (message.type === 'agent.pairing.start') {
    const response = await engineRequest('POST', '/v1/pairing/start', {
      issuedBy: 'extension-sidepanel',
    });
    return { ok: true, data: response };
  }

  if (message.type === 'agent.pairing.complete') {
    const code = message.payload?.code;
    if (typeof code !== 'string' || code.trim().length !== 6) {
      return { ok: false, error: 'Pairing code must be a 6-digit string.' };
    }

    const response = await engineRequest('POST', '/v1/pairing/complete', {
      code: code.trim(),
      extensionId: chrome.runtime.id,
    });

    const wsUrl = parseString(response.wsUrl);
    const wsToken = parseString(response.wsToken);
    const wsTokenExpiresAt = parseString(response.wsTokenExpiresAt);
    const pairedAt = parseString(response.pairedAt);

    if (!wsUrl || !wsToken) {
      return { ok: false, error: 'Pairing completed but wsUrl/wsToken missing in response.' };
    }

    await patchPersistedState({
      extensionId: chrome.runtime.id,
      pairedAt,
      wsUrl,
      wsToken,
      wsTokenExpiresAt,
    });

    await connectWebSocket();

    return {
      ok: true,
      data: {
        extensionId: chrome.runtime.id,
        wsUrl,
        wsTokenExpiresAt,
      },
    };
  }

  if (message.type === 'agent.pairing.auto') {
    const state = await getPersistedState();
    if (!state.engineBaseUrl) {
      return { ok: false, error: 'Engine URL is not configured. Save engine URL first.' };
    }

    await autoPairExtension(state.engineBaseUrl);
    await connectWebSocket();
    const updated = await getPersistedState();

    return {
      ok: true,
      data: {
        extensionId: chrome.runtime.id,
        pairedAt: updated.pairedAt,
        wsUrl: updated.wsUrl,
        wsTokenExpiresAt: updated.wsTokenExpiresAt,
      },
    };
  }

  if (message.type === 'agent.ws.connect') {
    await ensurePairedAndConnected();
    return { ok: true };
  }

  if (message.type === 'agent.session.start') {
    await ensurePairedAndConnected();
    try {
      const response = await engineRequest('POST', '/v1/sessions/start', { createdBy: 'extension' });
      const session = isRecord(response.session) ? response.session : null;
      const sessionId = session && typeof session.id === 'string' ? session.id : null;
      const confirmationToken = session && typeof session.confirmationToken === 'string' ? session.confirmationToken : null;

      if (!sessionId) {
        return { ok: false, error: 'Engine response did not include session.id.' };
      }

      flags.confirmationToken = confirmationToken;
      pausedRuntime = false;
      pendingCommandEvent = null;
      await patchPersistedState({ sessionId, paused: false, pendingCommand: null });
      await emitState('session-started');

      return {
        ok: true,
        data: response,
      };
    } catch (error) {
      const synced = await syncSessionFromEngineActive();
      if (synced) {
        sendRuntimeNotice('info', `Attached existing session ${synced.sessionId}.`);
        return {
          ok: true,
          data: {
            attachedExisting: true,
            session: {
              id: synced.sessionId,
              confirmationToken: synced.confirmationToken,
            },
          },
        };
      }

      throw error;
    }
  }

  if (message.type === 'agent.session.attach') {
    await ensurePairedAndConnected();
    const synced = await syncSessionFromEngineActive();
    if (!synced) {
      return { ok: false, error: 'No active engine session exists to attach.' };
    }

    sendRuntimeNotice('ok', `Attached existing session ${synced.sessionId}.`);
    return {
      ok: true,
      data: {
        attachedExisting: true,
        session: {
          id: synced.sessionId,
          confirmationToken: synced.confirmationToken,
        },
      },
    };
  }

  if (message.type === 'agent.pause.set') {
    const paused = message.payload?.paused === true;
    await persistPauseState(paused);
    if (!paused) {
      await flushPendingCommandIfResumed();
    }

    return {
      ok: true,
      data: { paused },
    };
  }

  if (message.type === 'agent.session.stop') {
    let state = await getPersistedState();
    if (!state.sessionId) {
      await syncSessionFromEngineActive();
      state = await getPersistedState();
      if (!state.sessionId) {
        return { ok: false, error: 'No active session id exists.' };
      }
    }

    const response = await engineRequest('POST', `/v1/sessions/${encodeURIComponent(state.sessionId)}/stop`, {});
    flags.confirmationToken = null;
    pausedRuntime = false;
    pendingCommandEvent = null;
    await patchPersistedState({ sessionId: null, paused: false, pendingCommand: null });
    await emitState('session-stopped');

    return {
      ok: true,
      data: response,
    };
  }

  if (message.type === 'agent.prompt.send') {
    const state = await getPersistedState();
    if (!state.sessionId) {
      return { ok: false, error: 'No active session id stored. Start session first.' };
    }

    const content = message.payload?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return { ok: false, error: 'Prompt content must be non-empty.' };
    }

    const role = message.payload?.role;
    const response = await engineRequest('POST', `/v1/sessions/${encodeURIComponent(state.sessionId)}/prompts`, {
      source: 'extension',
      role: role === 'assistant' || role === 'system' ? role : 'user',
      content: content.trim(),
    });

    return {
      ok: true,
      data: response,
    };
  }

  if (message.type === 'agent.prompt.pull') {
    const state = await getPersistedState();
    if (!state.sessionId) {
      return { ok: false, error: 'No active session id stored. Start session first.' };
    }

    const limitRaw = message.payload?.limit;
    const consumeRaw = message.payload?.consume;
    const limit = typeof limitRaw === 'number' && Number.isInteger(limitRaw) ? limitRaw : 50;
    const consume = typeof consumeRaw === 'boolean' ? consumeRaw : true;

    const response = await engineRequest(
      'GET',
      `/v1/sessions/${encodeURIComponent(state.sessionId)}/prompts/pull?limit=${limit}&consume=${consume ? 'true' : 'false'}`,
    );

    return {
      ok: true,
      data: response,
    };
  }

  if (message.type === 'agent.workflow.run') {
    await ensurePairedAndConnected();

    const sessionId = await resolveSessionIdForControlPlane();
    if (!sessionId) {
      return { ok: false, error: 'No active session found. Start or attach a session first.' };
    }

    const workflowId = typeof message.payload?.workflowId === 'string' ? message.payload.workflowId.trim() : '';
    if (!workflowId) {
      return { ok: false, error: 'workflowId is required.' };
    }

    const state = await getPersistedState();
    const activeTab = await resolveActiveTabForState(state);
    const plan = buildWorkflowPlan(workflowId, activeTab?.url ?? null);
    const queued: string[] = [];

    for (const command of plan.commands) {
      const response = await engineRequest('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/commands`, {
        command,
        confirmationToken: flags.confirmationToken ?? undefined,
      });
      const commandRecord = isRecord(response.command) ? response.command : null;
      const queuedId = commandRecord && typeof commandRecord.id === 'string' ? commandRecord.id : null;
      if (queuedId) {
        queued.push(queuedId);
      }
    }

    sendRuntimeNotice('ok', `Workflow queued: ${plan.label} (${plan.commands.length} steps).`);

    return {
      ok: true,
      data: {
        workflowId: plan.id,
        label: plan.label,
        steps: plan.commands.length,
        queued,
      },
    };
  }

  if (message.type === 'agent.memory.list') {
    const limitRaw = message.payload?.limit;
    const limit = typeof limitRaw === 'number' && Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 25;
    const response = await engineRequest('GET', `/v1/memory/patterns?limit=${encodeURIComponent(limit)}`);
    return { ok: true, data: response };
  }

  if (message.type === 'agent.memory.reset') {
    const response = await engineRequest('POST', '/v1/memory/patterns/reset', {});
    sendRuntimeNotice('info', 'Autonomous memory has been reset.');
    return { ok: true, data: response };
  }

  if (message.type === 'agent.command.enqueue') {
    const state = await getPersistedState();
    if (!state.sessionId) {
      return { ok: false, error: 'No active session id stored. Start session first.' };
    }

    const command = message.payload?.command;
    if (!isRecord(command) || typeof command.type !== 'string') {
      return { ok: false, error: 'Command payload must be an object with type.' };
    }

    const confirmationToken = message.payload?.confirmationToken;
    const response = await engineRequest('POST', `/v1/sessions/${encodeURIComponent(state.sessionId)}/commands`, {
      command,
      confirmationToken: typeof confirmationToken === 'string' ? confirmationToken : undefined,
    });

    return {
      ok: true,
      data: response,
    };
  }

  if (message.type === 'agent.state') {
    let state = await getPersistedState();
    if (!state.sessionId) {
      await syncSessionFromEngineActive();
      state = await getPersistedState();
    }

    if (!state.sessionId) {
      return {
        ok: true,
        data: {
          runtime: runtimeStateSnapshot(state),
          engineState: null,
        },
      };
    }

    const response = await engineRequest('GET', `/v1/sessions/${encodeURIComponent(state.sessionId)}/state`);
    const session = isRecord(response.session) ? response.session : null;
    const confirmationToken = session && typeof session.confirmationToken === 'string' ? session.confirmationToken : null;
    flags.confirmationToken = confirmationToken;

    return {
      ok: true,
      data: {
        runtime: runtimeStateSnapshot(state),
        engineState: response,
      },
    };
  }

  return {
    ok: false,
    error: `Unsupported message type '${message.type}'.`,
  };
}

chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
  const message = (rawMessage ?? {}) as ExtensionMessage;
  void handleMessage(message)
    .then((response) => {
      sendResponse(response);
    })
    .catch((error) => {
      const messageText = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, error: messageText } satisfies ExtensionMessageResponse);
    });

  return true;
});

chrome.runtime.onStartup.addListener(() => {
  void configureActionSidePanelBehavior();
  void connectWebSocket();
});

chrome.runtime.onInstalled.addListener(() => {
  void configureActionSidePanelBehavior();
  void patchPersistedState({
    engineBaseUrl: 'http://127.0.0.1:8787',
    panelOpen: false,
    extensionId: chrome.runtime.id,
    paused: false,
    pendingCommand: null,
  });
});

chrome.action.onClicked.addListener((tab) => {
  void openSidePanelForActionClick(tab);
});

void configureActionSidePanelBehavior();
void connectWebSocket();
void loadPendingCommandFromState();
void flushPendingCommandIfResumed();
