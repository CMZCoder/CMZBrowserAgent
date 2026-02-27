export type CommandType =
  | 'navigate'
  | 'click'
  | 'type'
  | 'select'
  | 'wait_for'
  | 'extract'
  | 'screenshot'
  | 'tab_focus'
  | 'tab_open'
  | 'auth_fill_secret'
  | 'evaluate';

export type BrowserCommand =
  | {
      type: 'navigate';
      url: string;
    }
  | {
      type: 'click';
      selector: string;
      waitForNavigation?: boolean;
    }
  | {
      type: 'type';
      selector: string;
      text: string;
      clear?: boolean;
      submit?: boolean;
    }
  | {
      type: 'select';
      selector: string;
      value: string;
    }
  | {
      type: 'wait_for';
      selector?: string;
      text?: string;
      timeoutMs?: number;
    }
  | {
      type: 'extract';
      selector: string;
      kind?: 'text' | 'html' | 'value' | 'attribute' | 'console_errors' | 'diagnostics';
      attribute?: string;
    }
  | {
      type: 'screenshot';
      fullPage?: boolean;
    }
  | {
      type: 'tab_focus';
      tabId?: number;
    }
  | {
      type: 'tab_open';
      url: string;
      active?: boolean;
    }
  | {
      type: 'auth_fill_secret';
      selector: string;
      secretKey?: string;
      secretValue?: string;
      submit?: boolean;
    }
  | {
      type: 'evaluate';
      script: string;
      args?: unknown[];
    };

export interface EngineCommandEvent {
  readonly type: 'engine.command';
  readonly data: {
    readonly commandId: string;
    readonly sessionId: string;
    readonly commandType: CommandType;
    readonly payload: Record<string, unknown>;
    readonly createdAt: string;
  };
}

export interface EngineCancelEvent {
  readonly type: 'engine.cancel';
  readonly data: {
    readonly commandId: string;
    readonly sessionId: string;
  };
}

export interface EnginePingEvent {
  readonly type: 'engine.ping';
  readonly data: {
    readonly timestamp: string;
  };
}

export type EngineToExtensionEvent = EngineCommandEvent | EngineCancelEvent | EnginePingEvent;

export interface ExtensionReadyEvent {
  readonly type: 'extension.ready';
  readonly data: {
    readonly extensionId: string;
    readonly version: string;
  };
}

export interface ExtensionResultEvent {
  readonly type: 'extension.result';
  readonly data: {
    readonly commandId: string;
    readonly status: 'success' | 'error';
    readonly result?: Record<string, unknown>;
    readonly error?: string;
    readonly durationMs?: number;
  };
}

export interface ExtensionStateEvent {
  readonly type: 'extension.state';
  readonly data: {
    readonly activeTabId?: number;
    readonly activeTabUrl?: string;
    readonly panelOpen?: boolean;
    readonly status?: string;
    readonly timestamp?: string;
  };
}

export interface ExtensionErrorEvent {
  readonly type: 'extension.error';
  readonly data: {
    readonly code?: string;
    readonly message: string;
    readonly commandId?: string;
    readonly details?: Record<string, unknown>;
  };
}

export interface ExtensionPongEvent {
  readonly type: 'extension.pong';
  readonly data: {
    readonly timestamp: string;
  };
}

export type ExtensionToEngineEvent =
  | ExtensionReadyEvent
  | ExtensionResultEvent
  | ExtensionStateEvent
  | ExtensionErrorEvent
  | ExtensionPongEvent;

export interface BridgeStorageState {
  readonly engineBaseUrl: string;
  readonly wsUrl: string;
  readonly wsToken: string;
  readonly wsTokenExpiresAt: string;
  readonly extensionId: string;
  readonly pairedAt: string;
  readonly sessionId: string;
  readonly boundTabId: number;
  readonly boundWindowId: number;
  readonly panelOpen: boolean;
}

export interface BridgeRuntimeState {
  readonly wsConnected: boolean;
  readonly wsConnecting: boolean;
  readonly reconnectScheduled: boolean;
  readonly sessionId: string | null;
  readonly boundTabId: number | null;
  readonly boundWindowId: number | null;
  readonly panelOpen: boolean;
  readonly lastError: string | null;
}

export interface ExtensionMessage {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
}

export interface ExtensionMessageResponse {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}
