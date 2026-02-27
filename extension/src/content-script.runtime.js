function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

const DIAGNOSTICS_KEY = '__browserAgentDiagnostics';
const DIAGNOSTICS_LIMIT = 250;

function stringifyValue(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getDiagnosticsStore() {
  const target = window;
  if (!isRecord(target[DIAGNOSTICS_KEY])) {
    target[DIAGNOSTICS_KEY] = {
      startedAt: new Date().toISOString(),
      console: [],
      pageErrors: [],
      resourceErrors: [],
      unhandledRejections: [],
    };
  }

  return target[DIAGNOSTICS_KEY];
}

function pushDiagnosticEntry(collection, entry) {
  collection.push(entry);
  if (collection.length > DIAGNOSTICS_LIMIT) {
    collection.splice(0, collection.length - DIAGNOSTICS_LIMIT);
  }
}

function installDiagnosticsHooks() {
  const target = window;
  if (target.__browserAgentDiagnosticsInstalled === true) {
    return;
  }

  target.__browserAgentDiagnosticsInstalled = true;
  const store = getDiagnosticsStore();

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  console.error = (...args) => {
    pushDiagnosticEntry(store.console, {
      level: 'error',
      timestamp: new Date().toISOString(),
      args: args.map((value) => stringifyValue(value)),
    });
    return originalError(...args);
  };

  console.warn = (...args) => {
    pushDiagnosticEntry(store.console, {
      level: 'warn',
      timestamp: new Date().toISOString(),
      args: args.map((value) => stringifyValue(value)),
    });
    return originalWarn(...args);
  };

  window.addEventListener(
    'error',
    (event) => {
      const eventTarget = event.target;
      if (eventTarget && eventTarget !== window) {
        const source = eventTarget.src || eventTarget.href || eventTarget.currentSrc || null;
        pushDiagnosticEntry(store.resourceErrors, {
          timestamp: new Date().toISOString(),
          source,
          tagName: eventTarget.tagName || null,
          message: event.message || 'Resource failed to load.',
        });
        return;
      }

      pushDiagnosticEntry(store.pageErrors, {
        timestamp: new Date().toISOString(),
        message: event.message || 'Unknown runtime error.',
        filename: event.filename || null,
        lineno: event.lineno || null,
        colno: event.colno || null,
        stack: event.error && event.error.stack ? String(event.error.stack) : null,
      });
    },
    true,
  );

  window.addEventListener('unhandledrejection', (event) => {
    pushDiagnosticEntry(store.unhandledRejections, {
      timestamp: new Date().toISOString(),
      reason: stringifyValue(event.reason),
    });
  });
}

installDiagnosticsHooks();

function getElement(selector) {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Selector not found: ${selector}`);
  }
  return element;
}

function dispatchValueInput(target) {
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
}

function ensureWritableControl(element) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element;
  }

  throw new Error('Target element is not an input or textarea control.');
}

function setControlValue(control, value) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value');
  if (descriptor && typeof descriptor.set === 'function') {
    descriptor.set.call(control, value);
  } else {
    control.value = value;
  }

  dispatchValueInput(control);
}

function toSerializable(value, depth = 0) {
  if (depth > 6) {
    return '[max-depth]';
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'undefined') {
    return null;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack || null,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toSerializable(entry, depth + 1));
  }

  if (typeof value === 'object') {
    if (value instanceof Element) {
      return {
        tagName: value.tagName,
        id: value.id || null,
        className: value.className || null,
      };
    }

    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = toSerializable(entry, depth + 1);
    }
    return output;
  }

  return String(value);
}

async function waitForPredicate(predicate, timeoutMs, errorMessage) {
  if (predicate()) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error(errorMessage));
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      if (!predicate()) {
        return;
      }

      window.clearTimeout(timeoutId);
      observer.disconnect();
      resolve();
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

async function execute(command) {
  if (command.type === 'click') {
    const target = getElement(command.selector);
    target.click();
    return {
      selector: command.selector,
      clicked: true,
    };
  }

  if (command.type === 'type') {
    const control = ensureWritableControl(getElement(command.selector));
    if (command.clear) {
      setControlValue(control, '');
    }

    setControlValue(control, command.text);
    if (command.submit) {
      if (control.form) {
        control.form.requestSubmit();
      }
    }

    return {
      selector: command.selector,
      typedLength: command.text.length,
      submitted: command.submit === true,
    };
  }

  if (command.type === 'select') {
    const element = getElement(command.selector);
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error(`Selector ${command.selector} does not match a <select> element.`);
    }

    element.value = command.value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));

    return {
      selector: command.selector,
      value: element.value,
    };
  }

  if (command.type === 'wait_for') {
    const timeoutMs = command.timeoutMs || 30000;

    if (command.selector) {
      await waitForPredicate(
        () => Boolean(document.querySelector(command.selector)),
        timeoutMs,
        `Timed out waiting for selector '${command.selector}'`,
      );

      return {
        selector: command.selector,
        satisfied: true,
      };
    }

    if (command.text) {
      await waitForPredicate(
        () => (document.body ? document.body.innerText.includes(command.text) : false),
        timeoutMs,
        `Timed out waiting for text '${command.text}'`,
      );

      return {
        text: command.text,
        satisfied: true,
      };
    }

    throw new Error('wait_for command requires selector or text.');
  }

  if (command.type === 'extract') {
    const element = getElement(command.selector);
    const kind = command.kind || 'text';

    if (kind === 'text') {
      return {
        selector: command.selector,
        kind,
        value: element.textContent || '',
      };
    }

    if (kind === 'html') {
      return {
        selector: command.selector,
        kind,
        value: element.innerHTML,
      };
    }

    if (kind === 'value') {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        return {
          selector: command.selector,
          kind,
          value: element.value,
        };
      }

      throw new Error(`Selector ${command.selector} is not a value-capable form element.`);
    }

    if (kind === 'attribute') {
      if (!command.attribute) {
        throw new Error('extract kind=attribute requires attribute name.');
      }

      return {
        selector: command.selector,
        kind,
        attribute: command.attribute,
        value: element.getAttribute(command.attribute),
      };
    }

    if (kind === 'console_errors') {
      const store = getDiagnosticsStore();
      return {
        selector: command.selector,
        kind,
        value: store.console.filter((entry) => entry.level === 'error'),
      };
    }

    if (kind === 'diagnostics') {
      return {
        selector: command.selector,
        kind,
        value: getDiagnosticsStore(),
      };
    }

    throw new Error(`Unsupported extract kind '${kind}'.`);
  }

  if (command.type === 'auth_fill_secret') {
    const secretValue = command.secretValue;
    if (typeof secretValue !== 'string') {
      throw new Error('auth_fill_secret command missing secretValue payload.');
    }

    const control = ensureWritableControl(getElement(command.selector));
    setControlValue(control, secretValue);

    if (command.submit && control.form) {
      control.form.requestSubmit();
    }

    return {
      selector: command.selector,
      typedLength: secretValue.length,
      submitted: command.submit === true,
    };
  }

  if (command.type === 'evaluate') {
    if (typeof command.script !== 'string' || command.script.trim().length === 0) {
      throw new Error('evaluate command requires a non-empty script string.');
    }

    const args = Array.isArray(command.args) ? command.args : [];
    const runner = new Function(
      'args',
      `"use strict";
      const __candidate = (${command.script});
      if (typeof __candidate !== "function") {
        throw new Error("evaluate script must return a function.");
      }
      return __candidate(...args);`,
    );

    const rawResult = runner(args);
    const resolved = rawResult instanceof Promise ? await rawResult : rawResult;
    return {
      kind: 'evaluate',
      value: toSerializable(resolved),
    };
  }

  throw new Error(`Command type '${command.type}' is not supported by content script.`);
}

function isPingRequest(value) {
  return isRecord(value) && value.type === 'browser-agent.ping';
}

function isExecuteRequest(value) {
  return isRecord(value) && value.type === 'browser-agent.execute' && isRecord(value.command);
}

chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
  if (isPingRequest(rawMessage)) {
    sendResponse({ ok: true });
    return;
  }

  if (!isExecuteRequest(rawMessage)) {
    return;
  }

  void execute(rawMessage.command)
    .then((result) => {
      sendResponse({ ok: true, result });
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, error: message });
    });

  return true;
});
