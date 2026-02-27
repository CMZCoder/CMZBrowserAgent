import { EventEmitter } from 'node:events';
import type { BrowserAgentStore, PromptRecord } from '../session/store.js';
import { normalizePromptContentForManualCheckpoint } from './manual-checkpoint.js';

export interface PromptBusEvents {
  readonly prompt: (prompt: PromptRecord) => void;
}

export class PromptBus {
  private readonly emitter = new EventEmitter();

  public constructor(private readonly store: BrowserAgentStore) {}

  public publishPrompt(input: {
    sessionId: string;
    source: 'cli' | 'extension';
    role: 'user' | 'assistant' | 'system';
    content: string;
    manualCheckpoint?: boolean;
  }): PromptRecord {
    const prompt = this.store.insertPrompt({
      sessionId: input.sessionId,
      source: input.source,
      role: input.role,
      content: normalizePromptContentForManualCheckpoint({
        source: input.source,
        role: input.role,
        content: input.content,
        manualCheckpoint: input.manualCheckpoint,
      }),
    });
    this.emitter.emit('prompt', prompt);
    return prompt;
  }

  public pullPrompts(sessionId: string, limit: number, consume: boolean): readonly PromptRecord[] {
    return this.store.pullPrompts(sessionId, limit, consume);
  }

  public onPrompt(listener: (prompt: PromptRecord) => void): () => void {
    this.emitter.on('prompt', listener);
    return () => {
      this.emitter.off('prompt', listener);
    };
  }
}
