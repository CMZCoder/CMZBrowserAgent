import type { ExtensionMessageResponse } from './types.js';

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

const engineUrlInput = getElement<HTMLInputElement>('engine-url');
const saveButton = getElement<HTMLButtonElement>('save');
const result = getElement<HTMLParagraphElement>('result');

async function loadCurrentState(): Promise<void> {
  const state = await sendMessage('agent.get.runtime');
  if (!state.ok) {
    result.textContent = state.error ?? 'Failed to load runtime state.';
    return;
  }

  const data = state.data as { engineBaseUrl?: string | null };
  if (typeof data.engineBaseUrl === 'string') {
    engineUrlInput.value = data.engineBaseUrl;
  }
}

saveButton.addEventListener('click', () => {
  void (async () => {
    const baseUrl = engineUrlInput.value.trim();
    if (!baseUrl) {
      result.textContent = 'Engine URL is required.';
      return;
    }

    const response = await sendMessage('agent.engine.set_url', {
      engineBaseUrl: baseUrl,
    });

    result.textContent = response.ok ? 'Saved.' : response.error ?? 'Save failed.';
  })();
});

void loadCurrentState();
