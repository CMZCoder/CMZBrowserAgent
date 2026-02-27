import type { ExtensionMessageResponse } from './types.js';

interface RuntimeState {
  readonly sessionId?: string | null;
  readonly confirmationToken?: string | null;
  readonly engineBaseUrl?: string | null;
  readonly wsConnected?: boolean;
  readonly wsConnecting?: boolean;
  readonly boundTabId?: number | null;
  readonly panelOpen?: boolean;
  readonly lastError?: string | null;
  readonly paused?: boolean;
  readonly pendingCommand?: string | null;
}

type PromptRole = 'assistant' | 'user' | 'system';

interface PromptEntry {
  readonly role: PromptRole;
  readonly source: string;
  readonly content: string;
  readonly createdAt: string;
}

interface CommandTimelineEntry {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly error: string | null;
}

interface MemoryCardEntry {
  readonly id: string;
  readonly scope: string;
  readonly status: string;
  readonly title: string;
  readonly summary: string;
  readonly domain: string | null;
  readonly intentKey: string | null;
  readonly confidence: number;
  readonly reliability: number;
  readonly successCount: number;
  readonly failureCount: number;
}

interface MemoryDecisionEntry {
  readonly reason: string;
  readonly decisionType: string;
  readonly commandType: string | null;
  readonly host: string | null;
  readonly createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sendMessage(type: string, payload?: Record<string, unknown>): Promise<ExtensionMessageResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve((response ?? { ok: false, error: 'No response from service worker.' }) as ExtensionMessageResponse);
    });
  });
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing DOM element #${id}`);
  }

  return element as T;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const engineUrlInput = getElement<HTMLInputElement>('engine-url');
const promptContentInput = getElement<HTMLTextAreaElement>('prompt-content');
const commandJsonInput = getElement<HTMLTextAreaElement>('command-json');
const confirmationInput = getElement<HTMLInputElement>('confirmation-input');
const statusOutput = getElement<HTMLPreElement>('status-output');
const sessionIdOutput = getElement<HTMLParagraphElement>('session-id');
const confirmationOutput = getElement<HTMLParagraphElement>('confirmation-token');
const feedbackBanner = getElement<HTMLParagraphElement>('feedback-banner');
const connectionPill = getElement<HTMLParagraphElement>('connection-pill');
const promptFeed = getElement<HTMLDivElement>('prompt-feed');
const commandFeed = getElement<HTMLDivElement>('command-feed');
const memoryFeed = getElement<HTMLDivElement>('memory-feed');
const memoryWhyFeed = getElement<HTMLDivElement>('memory-why-feed');
const memoryHealth = getElement<HTMLParagraphElement>('memory-health');
const toastHost = getElement<HTMLDivElement>('toast-host');
const actionCard = getElement<HTMLElement>('action-card');
const actionRequestText = getElement<HTMLParagraphElement>('action-request-text');
const actionReplyInput = getElement<HTMLInputElement>('action-reply-input');

const saveEngineButton = getElement<HTMLButtonElement>('save-engine');
const pairExtensionButton = getElement<HTMLButtonElement>('pair-extension');
const connectWsButton = getElement<HTMLButtonElement>('connect-ws');
const sessionStartButton = getElement<HTMLButtonElement>('session-start');
const sessionAttachButton = getElement<HTMLButtonElement>('session-attach');
const sessionStopButton = getElement<HTMLButtonElement>('session-stop');
const sessionPauseButton = getElement<HTMLButtonElement>('session-pause');
const refreshStateButton = getElement<HTMLButtonElement>('refresh-state');
const promptSendButton = getElement<HTMLButtonElement>('prompt-send');
const promptPullButton = getElement<HTMLButtonElement>('prompt-pull');
const sessionExportButton = getElement<HTMLButtonElement>('session-export');
const commandEnqueueButton = getElement<HTMLButtonElement>('command-enqueue');
const actionDoneButton = getElement<HTMLButtonElement>('action-done');
const actionHelpButton = getElement<HTMLButtonElement>('action-help');
const memoryRefreshButton = getElement<HTMLButtonElement>('memory-refresh');
const memoryResetButton = getElement<HTMLButtonElement>('memory-reset');
const memoryNoStoreToggle = getElement<HTMLInputElement>('memory-no-store');
const quickSnapshotButton = getElement<HTMLButtonElement>('quick-snapshot');
const quickDiagnosticsButton = getElement<HTMLButtonElement>('quick-diagnostics');
const quickFocusButton = getElement<HTMLButtonElement>('quick-focus');
const workflowButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.workflow-btn'));

let currentPaused = false;
let feedbackTimer: number | null = null;
let autoRefreshTimer: number | null = null;
let toastCounter = 0;
let lastRuntimeError: string | null = null;
let currentSessionId: string | null = null;
let pendingActionRequest: string | null = null;
let lastPrompts: PromptEntry[] = [];
let lastTimeline: CommandTimelineEntry[] = [];

sessionPauseButton.disabled = true;
sessionStopButton.disabled = true;
promptSendButton.disabled = true;
actionDoneButton.disabled = true;
actionHelpButton.disabled = true;
sessionAttachButton.disabled = true;
sessionExportButton.disabled = true;
memoryRefreshButton.disabled = true;
memoryResetButton.disabled = true;
quickSnapshotButton.disabled = true;
quickDiagnosticsButton.disabled = true;
quickFocusButton.disabled = true;
for (const button of workflowButtons) {
  button.disabled = true;
}

function format(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toRuntimeState(payload: unknown): RuntimeState {
  if (!isRecord(payload)) {
    return {};
  }

  return payload as RuntimeState;
}

function setBanner(kind: 'info' | 'ok' | 'err', message: string): void {
  feedbackBanner.className = `banner banner-${kind}`;
  feedbackBanner.textContent = message;

  if (feedbackTimer !== null) {
    window.clearTimeout(feedbackTimer);
    feedbackTimer = null;
  }

  if (kind !== 'info') {
    feedbackTimer = window.setTimeout(() => {
      feedbackBanner.className = 'banner banner-info';
      feedbackBanner.textContent = 'Ready.';
      feedbackTimer = null;
    }, 3200);
  }
}

function setConnectionPill(runtime: RuntimeState): void {
  const wsConnected = runtime.wsConnected === true;
  const wsConnecting = runtime.wsConnecting === true;

  if (wsConnected) {
    connectionPill.className = 'pill pill-online';
    connectionPill.textContent = 'Connected';
    return;
  }

  if (wsConnecting) {
    connectionPill.className = 'pill pill-connecting';
    connectionPill.textContent = 'Connecting...';
    return;
  }

  connectionPill.className = 'pill pill-offline';
  connectionPill.textContent = 'Offline';
}

function pushToast(kind: 'info' | 'ok' | 'err', message: string): void {
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.dataset.toastId = String(++toastCounter);
  node.textContent = message;
  toastHost.prepend(node);

  const remove = () => {
    if (node.parentElement) {
      node.parentElement.removeChild(node);
    }
  };

  window.setTimeout(remove, 3600);
}

function sanitizePromptRole(role: unknown): PromptRole {
  if (role === 'assistant' || role === 'user' || role === 'system') {
    return role;
  }
  return 'system';
}

function parsePrompts(prompts: unknown): PromptEntry[] {
  if (!Array.isArray(prompts)) {
    return [];
  }

  return prompts
    .map((entry): PromptEntry | null => {
      if (!isRecord(entry)) {
        return null;
      }

      const role = sanitizePromptRole(entry.role);
      const source = typeof entry.source === 'string' ? entry.source : 'unknown';
      const content = typeof entry.content === 'string' ? entry.content : '';
      const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : '';
      return { role, source, content, createdAt };
    })
    .filter((entry): entry is PromptEntry => entry !== null);
}

function parseTimeline(commands: unknown): CommandTimelineEntry[] {
  if (!Array.isArray(commands)) {
    return [];
  }

  return commands
    .map((entry): CommandTimelineEntry | null => {
      if (!isRecord(entry)) {
        return null;
      }
      const id = typeof entry.id === 'string' ? entry.id : '';
      const type = typeof entry.type === 'string' ? entry.type : 'unknown';
      const status = typeof entry.status === 'string' ? entry.status : 'unknown';
      const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : '';
      const startedAt = typeof entry.startedAt === 'string' ? entry.startedAt : null;
      const completedAt = typeof entry.completedAt === 'string' ? entry.completedAt : null;
      const error = typeof entry.error === 'string' ? entry.error : null;
      if (!id) {
        return null;
      }
      return { id, type, status, createdAt, startedAt, completedAt, error };
    })
    .filter((entry): entry is CommandTimelineEntry => entry !== null)
    .sort((a, b) => {
      const at = Date.parse(a.createdAt);
      const bt = Date.parse(b.createdAt);
      if (!Number.isFinite(at) || !Number.isFinite(bt)) {
        return 0;
      }
      return bt - at;
    });
}

function parseMemoryCards(raw: unknown): MemoryCardEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry): MemoryCardEntry | null => {
      if (!isRecord(entry)) {
        return null;
      }

      const id = typeof entry.id === 'string' ? entry.id : '';
      if (!id) {
        return null;
      }

      return {
        id,
        scope: typeof entry.scope === 'string' ? entry.scope : 'unknown',
        status: typeof entry.status === 'string' ? entry.status : 'unknown',
        title: typeof entry.title === 'string' ? entry.title : 'Memory',
        summary: typeof entry.summary === 'string' ? entry.summary : '',
        domain: typeof entry.domain === 'string' ? entry.domain : null,
        intentKey: typeof entry.intentKey === 'string' ? entry.intentKey : null,
        confidence: typeof entry.confidence === 'number' ? entry.confidence : 0,
        reliability: typeof entry.reliability === 'number' ? entry.reliability : 0,
        successCount: typeof entry.successCount === 'number' ? entry.successCount : 0,
        failureCount: typeof entry.failureCount === 'number' ? entry.failureCount : 0,
      };
    })
    .filter((entry): entry is MemoryCardEntry => entry !== null)
    .sort((a, b) => b.reliability - a.reliability);
}

function parseMemoryDecisions(raw: unknown): MemoryDecisionEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry): MemoryDecisionEntry | null => {
      if (!isRecord(entry)) {
        return null;
      }

      const reason = typeof entry.reason === 'string' ? entry.reason : '';
      const decisionType = typeof entry.decisionType === 'string' ? entry.decisionType : 'decision';
      const commandType = typeof entry.commandType === 'string' ? entry.commandType : null;
      const host = typeof entry.host === 'string' ? entry.host : null;
      const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : '';
      if (!reason) {
        return null;
      }
      return { reason, decisionType, commandType, host, createdAt };
    })
    .filter((entry): entry is MemoryDecisionEntry => entry !== null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function summarizeActionRequest(content: string): string | null {
  const raw = content.trim();
  if (raw.length === 0) {
    return null;
  }

  const taggedBlockMatch = raw.match(/\[USER_ACTION_REQUIRED\]([\s\S]*?)\[\/USER_ACTION_REQUIRED\]/i);
  const openEndedTagMatch = raw.match(/\[USER_ACTION_REQUIRED\]([\s\S]*)/i);
  if (!taggedBlockMatch && !openEndedTagMatch) {
    return null;
  }

  let candidate = taggedBlockMatch?.[1] ?? openEndedTagMatch?.[1] ?? '';
  candidate = candidate.replace(/\[\/?USER_ACTION_REQUIRED\]/gi, '').trim();
  if (candidate.length === 0) {
    return null;
  }

  if (candidate.length > 280) {
    return `${candidate.slice(0, 277)}...`;
  }
  return candidate;
}

function findLatestManualAction(prompts: readonly PromptEntry[]): string | null {
  const ordered = [...prompts].sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
      return 0;
    }
    return aTime - bTime;
  });

  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const prompt = ordered[i];
    if (!prompt) {
      continue;
    }
    if (prompt.role !== 'assistant' && prompt.role !== 'system') {
      continue;
    }
    const summary = summarizeActionRequest(prompt.content);
    if (summary) {
      return summary;
    }
  }
  return null;
}

function updateActionCardVisibility(): void {
  const hasSession = currentSessionId !== null;
  const hasAction = pendingActionRequest !== null;
  actionDoneButton.disabled = !hasSession || !hasAction;
  actionHelpButton.disabled = !hasSession || !hasAction;

  if (!hasAction) {
    actionCard.classList.add('action-card-hidden');
    actionRequestText.textContent = 'No manual action required.';
    return;
  }

  actionCard.classList.remove('action-card-hidden');
  actionRequestText.textContent = pendingActionRequest;
}

function setButtonBusy(button: HTMLButtonElement, busy: boolean, busyText = 'Working...'): () => void {
  const originalText = button.textContent ?? '';
  button.disabled = busy;
  if (busy) {
    button.textContent = busyText;
  }

  return () => {
    button.disabled = false;
    button.textContent = originalText;
  };
}

function renderPrompts(prompts: unknown): void {
  const parsedPrompts = parsePrompts(prompts);
  lastPrompts = parsedPrompts;
  pendingActionRequest = findLatestManualAction(parsedPrompts);
  updateActionCardVisibility();

  if (parsedPrompts.length === 0) {
    promptFeed.innerHTML = '<p class="feed-empty">No messages yet.</p>';
    return;
  }

  const rows = parsedPrompts
    .slice()
    .reverse()
    .map((entry) => {
      const safeContent = escapeHtml(entry.content);
      const meta = `${entry.role} · ${entry.source}${entry.createdAt ? ` · ${new Date(entry.createdAt).toLocaleTimeString()}` : ''}`;
      return `<article class="feed-item feed-item-${entry.role}"><div class="feed-meta">${escapeHtml(meta)}</div><div>${safeContent}</div></article>`;
    });

  promptFeed.innerHTML = rows.join('');
}

function statusChipClass(status: string): string {
  if (status === 'queued') return 'status-chip status-chip-queued';
  if (status === 'running') return 'status-chip status-chip-running';
  if (status === 'success') return 'status-chip status-chip-success';
  if (status === 'error') return 'status-chip status-chip-error';
  return 'status-chip';
}

function renderTimeline(commands: unknown): void {
  const timeline = parseTimeline(commands);
  lastTimeline = timeline;

  if (timeline.length === 0) {
    commandFeed.innerHTML = '<p class="feed-empty">No commands yet.</p>';
    return;
  }

  const rows = timeline.slice(0, 60).map((entry) => {
    const elapsed = entry.startedAt && entry.completedAt
      ? `${Math.max(0, Date.parse(entry.completedAt) - Date.parse(entry.startedAt))}ms`
      : entry.startedAt
        ? 'running...'
        : '';
    const meta = `${entry.type}${entry.createdAt ? ` · ${new Date(entry.createdAt).toLocaleTimeString()}` : ''}${elapsed ? ` · ${elapsed}` : ''}`;
    const error = entry.error ? `<div class="feed-meta">${escapeHtml(entry.error)}</div>` : '';
    return `<article class="feed-item feed-item-command"><div class="feed-meta"><span class="${statusChipClass(entry.status)}">${escapeHtml(entry.status)}</span>${escapeHtml(meta)}</div><div>${escapeHtml(entry.id)}</div>${error}</article>`;
  });

  commandFeed.innerHTML = rows.join('');
}

function renderMemoryCards(cards: readonly MemoryCardEntry[]): void {
  if (cards.length === 0) {
    memoryFeed.innerHTML = '<p class="feed-empty">No learned patterns.</p>';
    return;
  }

  const rows = cards.slice(0, 60).map((entry) => {
    const domain = entry.domain ?? 'global';
    const score = `conf:${entry.confidence.toFixed(2)} · rel:${entry.reliability.toFixed(2)} · ok:${entry.successCount}/fail:${entry.failureCount}`;
    const meta = `${entry.scope} · ${domain}${entry.intentKey ? ` · ${entry.intentKey}` : ''} · ${entry.status}`;
    return `<article class="feed-item feed-item-memory"><div class="feed-meta">${escapeHtml(meta)}</div><div><strong>${escapeHtml(entry.title)}</strong></div><div>${escapeHtml(entry.summary)}</div><div class="feed-meta">${escapeHtml(score)}</div></article>`;
  });
  memoryFeed.innerHTML = rows.join('');
}

function renderMemoryDecisions(decisions: readonly MemoryDecisionEntry[]): void {
  if (decisions.length === 0) {
    memoryWhyFeed.innerHTML = '<p class="feed-empty">No memory decisions yet.</p>';
    return;
  }

  const rows = decisions.slice(0, 40).map((entry) => {
    const when = entry.createdAt ? new Date(entry.createdAt).toLocaleTimeString() : 'unknown-time';
    const meta = `${entry.decisionType}${entry.commandType ? ` · ${entry.commandType}` : ''}${entry.host ? ` · ${entry.host}` : ''} · ${when}`;
    return `<article class="feed-item feed-item-decision"><div class="feed-meta">${escapeHtml(meta)}</div><div>${escapeHtml(entry.reason)}</div></article>`;
  });
  memoryWhyFeed.innerHTML = rows.join('');
}

function renderMemoryHealth(summaryRaw: unknown, settingsRaw: unknown): void {
  const summary = isRecord(summaryRaw) ? summaryRaw : {};
  const settings = isRecord(settingsRaw) ? settingsRaw : {};
  const totalCards = typeof summary.totalCards === 'number' ? summary.totalCards : 0;
  const activeCards = typeof summary.activeCards === 'number' ? summary.activeCards : 0;
  const policyCards = typeof summary.policyCards === 'number' ? summary.policyCards : 0;
  const outcomeCards = typeof summary.outcomeCards === 'number' ? summary.outcomeCards : 0;
  const disabledCards = typeof summary.disabledCards === 'number' ? summary.disabledCards : 0;
  const noStore = settings.noStore === true;

  memoryNoStoreToggle.checked = noStore;
  memoryHealth.textContent =
    `Health: ${activeCards}/${totalCards} active · policy:${policyCards} · outcome:${outcomeCards} · disabled:${disabledCards}${noStore ? ' · no-store ON' : ''}`;
}

function updateHeader(runtime: RuntimeState): void {
  currentSessionId = typeof runtime.sessionId === 'string' && runtime.sessionId.length > 0 ? runtime.sessionId : null;
  currentPaused = runtime.paused === true;
  sessionIdOutput.textContent = `Session: ${runtime.sessionId ?? 'none'}`;
  confirmationOutput.textContent = `Confirmation: ${runtime.confirmationToken ?? 'unavailable'}`;
  sessionPauseButton.textContent = currentPaused ? 'Resume' : 'Pause';
  setConnectionPill(runtime);

  if (typeof runtime.engineBaseUrl === 'string') {
    engineUrlInput.value = runtime.engineBaseUrl;
  }

  const hasSession = currentSessionId !== null;
  sessionPauseButton.disabled = !hasSession;
  sessionStopButton.disabled = !hasSession;
  sessionAttachButton.disabled = hasSession;
  promptSendButton.disabled = !hasSession;
  sessionExportButton.disabled = !hasSession;
  memoryRefreshButton.disabled = !hasSession;
  memoryResetButton.disabled = !hasSession;
  quickSnapshotButton.disabled = !hasSession;
  quickDiagnosticsButton.disabled = !hasSession;
  quickFocusButton.disabled = !hasSession;
  for (const button of workflowButtons) {
    button.disabled = !hasSession;
  }
  updateActionCardVisibility();
}

async function refreshMemoryLab(): Promise<void> {
  try {
    const response = await sendMessage('agent.memory.list', { limit: 30 });
    if (!response.ok) {
      renderMemoryHealth({}, {});
      renderMemoryCards([]);
      renderMemoryDecisions([]);
      return;
    }
    if (!isRecord(response.data)) {
      renderMemoryHealth({}, {});
      renderMemoryCards([]);
      renderMemoryDecisions([]);
      return;
    }

    renderMemoryHealth(response.data.summary, response.data.settings);
    renderMemoryCards(parseMemoryCards(response.data.cards));
    renderMemoryDecisions(parseMemoryDecisions(response.data.decisions));
  } catch {
    renderMemoryHealth({}, {});
    renderMemoryCards([]);
    renderMemoryDecisions([]);
    return;
  }
}

async function refreshState(pullPrompts = true): Promise<void> {
  const runtimeResponse = await sendMessage('agent.get.runtime');
  if (!runtimeResponse.ok) {
    const message = runtimeResponse.error ?? 'Failed to load runtime state.';
    statusOutput.textContent = message;
    setConnectionPill({});
    return;
  }

  const runtime = toRuntimeState(runtimeResponse.data);
  updateHeader(runtime);

  const stateResponse = await sendMessage('agent.state');
  if (!stateResponse.ok) {
    statusOutput.textContent = format({ runtime, error: stateResponse.error ?? 'Failed to load engine state.' });
    return;
  }

  statusOutput.textContent = format(stateResponse.data);
  if (isRecord(stateResponse.data) && isRecord(stateResponse.data.engineState)) {
    renderTimeline(stateResponse.data.engineState.commands);
  } else {
    renderTimeline([]);
  }

  if (pullPrompts && runtime.sessionId) {
    const promptResponse = await sendMessage('agent.prompt.pull', { limit: 40, consume: false });
    if (promptResponse.ok && isRecord(promptResponse.data)) {
      renderPrompts(promptResponse.data.prompts);
    }
  } else {
    pendingActionRequest = null;
    updateActionCardVisibility();
  }

  if (runtime.sessionId) {
    await refreshMemoryLab();
  } else {
    renderMemoryHealth({}, {});
    renderMemoryCards([]);
    renderMemoryDecisions([]);
  }
}

async function exportSessionMarkdown(): Promise<void> {
  if (!currentSessionId) {
    throw new Error('No active session to export.');
  }

  const stateResponse = await sendMessage('agent.state');
  if (!stateResponse.ok || !isRecord(stateResponse.data)) {
    throw new Error(stateResponse.error ?? 'Failed to load state for export.');
  }

  const promptResponse = await sendMessage('agent.prompt.pull', { limit: 250, consume: false });
  const prompts = promptResponse.ok && isRecord(promptResponse.data) ? parsePrompts(promptResponse.data.prompts) : lastPrompts;
  const engineState = isRecord(stateResponse.data.engineState) ? stateResponse.data.engineState : null;
  const timeline = engineState ? parseTimeline(engineState.commands) : lastTimeline;

  const lines: string[] = [];
  lines.push('# BrowserAgent Session Export');
  lines.push('');
  lines.push(`- Session: ${currentSessionId}`);
  lines.push(`- Exported at: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Conversation');
  lines.push('');

  if (prompts.length === 0) {
    lines.push('_No prompts._');
    lines.push('');
  } else {
    for (const prompt of prompts) {
      const when = prompt.createdAt ? new Date(prompt.createdAt).toISOString() : 'unknown-time';
      lines.push(`### ${prompt.role} (${prompt.source}) · ${when}`);
      lines.push('');
      lines.push(prompt.content.trim() || '_empty_');
      lines.push('');
    }
  }

  lines.push('## Command Timeline');
  lines.push('');
  if (timeline.length === 0) {
    lines.push('_No commands._');
    lines.push('');
  } else {
    for (const cmd of timeline) {
      lines.push(`- ${cmd.status.toUpperCase()} · ${cmd.type} · ${cmd.id}`);
      if (cmd.error) {
        lines.push(`  - error: ${cmd.error}`);
      }
      if (cmd.createdAt) {
        lines.push(`  - created: ${cmd.createdAt}`);
      }
      if (cmd.startedAt) {
        lines.push(`  - started: ${cmd.startedAt}`);
      }
      if (cmd.completedAt) {
        lines.push(`  - completed: ${cmd.completedAt}`);
      }
    }
    lines.push('');
  }

  const markdown = `${lines.join('\n').trim()}\n`;
  const filename = `browseragent-session-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(markdown);
      pushToast('ok', 'Session export copied to clipboard and downloaded.');
    } catch {
      pushToast('ok', 'Session export downloaded.');
    }
  }
}

async function handleButton(
  button: HTMLButtonElement,
  busyText: string,
  callback: () => Promise<ExtensionMessageResponse>,
  successMessage: string,
  onSuccess?: (response: ExtensionMessageResponse) => void,
): Promise<void> {
  const release = setButtonBusy(button, true, busyText);
  setBanner('info', busyText);
  try {
    const response = await callback();
    if (!response.ok) {
      const errorMessage = response.error ?? 'Action failed.';
      setBanner('err', errorMessage);
      pushToast('err', errorMessage);
      statusOutput.textContent = errorMessage;
      return;
    }

    if (onSuccess) {
      onSuccess(response);
    }

    setBanner('ok', successMessage);
    pushToast('ok', successMessage);
    await refreshState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setBanner('err', message);
    pushToast('err', message);
    statusOutput.textContent = message;
  } finally {
    release();
  }
}

saveEngineButton.addEventListener('click', () => {
  void handleButton(
    saveEngineButton,
    'Saving...',
    () => sendMessage('agent.engine.set_url', { engineBaseUrl: engineUrlInput.value.trim() }),
    'Engine URL saved.',
  );
});

pairExtensionButton.addEventListener('click', () => {
  void handleButton(
    pairExtensionButton,
    'Pairing...',
    async () => {
      const baseUrl = engineUrlInput.value.trim();
      if (!baseUrl) {
        return { ok: false, error: 'Engine URL is required before pairing.' };
      }
      const setUrl = await sendMessage('agent.engine.set_url', { engineBaseUrl: baseUrl });
      if (!setUrl.ok) {
        return setUrl;
      }
      return sendMessage('agent.pairing.auto');
    },
    'Extension paired automatically.',
  );
});

connectWsButton.addEventListener('click', () => {
  void handleButton(connectWsButton, 'Connecting...', () => sendMessage('agent.ws.connect'), 'WebSocket connected.');
});

sessionStartButton.addEventListener('click', () => {
  void handleButton(sessionStartButton, 'Starting...', () => sendMessage('agent.session.start'), 'Session started and bridge connected.');
});

sessionAttachButton.addEventListener('click', () => {
  void handleButton(sessionAttachButton, 'Attaching...', () => sendMessage('agent.session.attach'), 'Attached existing session.');
});

sessionStopButton.addEventListener('click', () => {
  void handleButton(sessionStopButton, 'Stopping...', () => sendMessage('agent.session.stop'), 'Session stopped.');
});

sessionPauseButton.addEventListener('click', () => {
  void handleButton(
    sessionPauseButton,
    currentPaused ? 'Resuming...' : 'Pausing...',
    () => sendMessage('agent.pause.set', { paused: !currentPaused }),
    currentPaused ? 'Session resumed.' : 'Session paused.',
    () => {
      currentPaused = !currentPaused;
      sessionPauseButton.textContent = currentPaused ? 'Resume' : 'Pause';
    },
  );
});

refreshStateButton.addEventListener('click', () => {
  void handleButton(refreshStateButton, 'Refreshing...', async () => ({ ok: true, data: {} }), 'State refreshed.');
});

promptSendButton.addEventListener('click', () => {
  void handleButton(
    promptSendButton,
    'Sending...',
    async () => {
      const content = promptContentInput.value.trim();
      if (!content) {
        return { ok: false, error: 'Message is required.' };
      }
      const response = await sendMessage('agent.prompt.send', { content, role: 'user' });
      if (response.ok) {
        promptContentInput.value = '';
      }
      return response;
    },
    'Message sent to Codex.',
  );
});

promptPullButton.addEventListener('click', () => {
  void handleButton(
    promptPullButton,
    'Pulling...',
    async () => {
      const response = await sendMessage('agent.prompt.pull', { limit: 50, consume: false });
      if (response.ok && isRecord(response.data)) {
        renderPrompts(response.data.prompts);
      }
      return response;
    },
    'Messages refreshed.',
  );
});

sessionExportButton.addEventListener('click', () => {
  void handleButton(
    sessionExportButton,
    'Exporting...',
    async () => {
      await exportSessionMarkdown();
      return { ok: true };
    },
    'Session export generated.',
  );
});

for (const button of workflowButtons) {
  button.addEventListener('click', () => {
    const workflowId = button.dataset.workflowId;
    void handleButton(
      button,
      'Queueing...',
      () => sendMessage('agent.workflow.run', { workflowId }),
      'Workflow queued.',
    );
  });
}

quickSnapshotButton.addEventListener('click', () => {
  void handleButton(
    quickSnapshotButton,
    'Queueing...',
    () => sendMessage('agent.command.enqueue', { command: { type: 'screenshot', fullPage: true } }),
    'Snapshot command queued.',
  );
});

quickDiagnosticsButton.addEventListener('click', () => {
  void handleButton(
    quickDiagnosticsButton,
    'Queueing...',
    () =>
      sendMessage('agent.command.enqueue', {
        command: { type: 'extract', selector: 'body', kind: 'diagnostics' },
      }),
    'Diagnostics extract queued.',
  );
});

quickFocusButton.addEventListener('click', () => {
  void handleButton(
    quickFocusButton,
    'Queueing...',
    () => sendMessage('agent.command.enqueue', { command: { type: 'tab_focus' } }),
    'Focus command queued.',
  );
});

memoryRefreshButton.addEventListener('click', () => {
  void handleButton(
    memoryRefreshButton,
    'Refreshing...',
    async () => {
      await refreshMemoryLab();
      return { ok: true };
    },
    'Memory refreshed.',
  );
});

memoryResetButton.addEventListener('click', () => {
  void handleButton(
    memoryResetButton,
    'Resetting...',
    () => sendMessage('agent.memory.reset'),
    'Memory reset.',
    () => {
      renderMemoryHealth({}, {});
      renderMemoryCards([]);
      renderMemoryDecisions([]);
    },
  );
});

memoryNoStoreToggle.addEventListener('change', () => {
  const enabled = memoryNoStoreToggle.checked;
  setBanner('info', enabled ? 'Enabling no-store...' : 'Disabling no-store...');
  void sendMessage('agent.memory.no_store', { enabled })
    .then(async (response) => {
      if (!response.ok) {
        memoryNoStoreToggle.checked = !enabled;
        const errorText = response.error ?? 'Failed to update no-store mode.';
        setBanner('err', errorText);
        pushToast('err', errorText);
        return;
      }

      setBanner('ok', enabled ? 'No-store mode enabled.' : 'No-store mode disabled.');
      pushToast('ok', enabled ? 'No-store mode enabled.' : 'No-store mode disabled.');
      await refreshMemoryLab();
    })
    .catch((error) => {
      memoryNoStoreToggle.checked = !enabled;
      const message = error instanceof Error ? error.message : String(error);
      setBanner('err', message);
      pushToast('err', message);
    });
});

actionDoneButton.addEventListener('click', () => {
  void handleButton(
    actionDoneButton,
    'Sending...',
    async () => {
      if (!pendingActionRequest) {
        return { ok: false, error: 'No pending manual action found.' };
      }
      const reply = actionReplyInput.value.trim();
      const content = reply
        ? `Completed requested action: ${pendingActionRequest}\nNote: ${reply}`
        : `Completed requested action: ${pendingActionRequest}`;
      return sendMessage('agent.prompt.send', { content, role: 'user' });
    },
    'Completion sent.',
    () => {
      pendingActionRequest = null;
      actionReplyInput.value = '';
      updateActionCardVisibility();
    },
  );
});

actionHelpButton.addEventListener('click', () => {
  void handleButton(
    actionHelpButton,
    'Sending...',
    async () => {
      if (!pendingActionRequest) {
        return { ok: false, error: 'No pending manual action found.' };
      }
      const reply = actionReplyInput.value.trim();
      const content = reply
        ? `Need help with requested action: ${pendingActionRequest}\nContext: ${reply}`
        : `Need help with requested action: ${pendingActionRequest}. Please guide me step-by-step.`;
      return sendMessage('agent.prompt.send', { content, role: 'user' });
    },
    'Help request sent.',
  );
});

promptContentInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    promptSendButton.click();
  }
});

commandEnqueueButton.addEventListener('click', () => {
  void handleButton(
    commandEnqueueButton,
    'Queueing...',
    async () => {
      const raw = commandJsonInput.value.trim();
      if (!raw) {
        return { ok: false, error: 'Command JSON is required.' };
      }

      let command: unknown;
      try {
        command = JSON.parse(raw);
      } catch (error) {
        return { ok: false, error: `Invalid command JSON: ${error instanceof Error ? error.message : String(error)}` };
      }

      if (!isRecord(command)) {
        return { ok: false, error: 'Command JSON must be an object.' };
      }

      const confirmationToken = confirmationInput.value.trim();
      return sendMessage('agent.command.enqueue', {
        command,
        confirmationToken: confirmationToken.length > 0 ? confirmationToken : undefined,
      });
    },
    'Command enqueued.',
  );
});

chrome.runtime.onMessage.addListener((rawMessage) => {
  if (!isRecord(rawMessage)) {
    return;
  }

  if (rawMessage.type === 'agent.runtime.notice' && isRecord(rawMessage.payload)) {
    const kindRaw = rawMessage.payload.kind;
    const messageRaw = rawMessage.payload.message;
    const kind = kindRaw === 'ok' || kindRaw === 'err' ? kindRaw : 'info';
    if (typeof messageRaw === 'string' && messageRaw.trim().length > 0) {
      pushToast(kind, messageRaw.trim());
      setBanner(kind, messageRaw.trim());
    }
    return;
  }

  if (rawMessage.type !== 'agent.runtime.state') {
    return;
  }

  const runtime = toRuntimeState(rawMessage.payload);
  updateHeader(runtime);

  if (runtime.lastError && runtime.lastError !== lastRuntimeError) {
    lastRuntimeError = runtime.lastError;
    setBanner('err', runtime.lastError);
    pushToast('err', runtime.lastError);
  } else if (!runtime.lastError) {
    lastRuntimeError = null;
  }
});

window.addEventListener('beforeunload', () => {
  if (autoRefreshTimer !== null) {
    window.clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  void sendMessage('agent.panel.close');
});

updateActionCardVisibility();
void sendMessage('agent.panel.open');
void refreshState();
autoRefreshTimer = window.setInterval(() => {
  void refreshState();
}, 4000);
