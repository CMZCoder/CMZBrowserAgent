import { z } from 'zod';
import type { BrowserCommandType } from './commands.js';

export interface EngineCommandEvent {
  readonly type: 'engine.command';
  readonly data: {
    readonly commandId: string;
    readonly sessionId: string;
    readonly commandType: BrowserCommandType;
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

export type EngineToExtensionEvent =
  | EngineCommandEvent
  | EngineCancelEvent
  | EnginePingEvent;

const extensionReadySchema = z.object({
  type: z.literal('extension.ready'),
  data: z.object({
    extensionId: z.string().min(1),
    version: z.string().min(1).optional(),
  }),
});

const extensionResultSchema = z.object({
  type: z.literal('extension.result'),
  data: z.object({
    commandId: z.string().min(1),
    status: z.enum(['success', 'error']),
    result: z.record(z.unknown()).optional(),
    error: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
  }),
});

const extensionStateSchema = z.object({
  type: z.literal('extension.state'),
  data: z.object({
    activeTabId: z.number().int().positive().optional(),
    activeTabUrl: z.string().optional(),
    panelOpen: z.boolean().optional(),
    status: z.string().optional(),
    timestamp: z.string().optional(),
  }),
});

const extensionErrorSchema = z.object({
  type: z.literal('extension.error'),
  data: z.object({
    code: z.string().optional(),
    message: z.string().min(1),
    commandId: z.string().optional(),
    details: z.record(z.unknown()).optional(),
  }),
});

const extensionPongSchema = z.object({
  type: z.literal('extension.pong'),
  data: z.object({
    timestamp: z.string(),
  }),
});

export const extensionToEngineEventSchema = z.discriminatedUnion('type', [
  extensionReadySchema,
  extensionResultSchema,
  extensionStateSchema,
  extensionErrorSchema,
  extensionPongSchema,
]);

export type ExtensionToEngineEvent = z.infer<typeof extensionToEngineEventSchema>;
