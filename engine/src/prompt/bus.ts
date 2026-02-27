import { EventEmitter } from 'node:events';
import { MemoryAutomationService } from '../memory/memory-automation-service.js';
import type { BrowserAgentStore, PromptRecord } from '../session/store.js';
import { normalizePromptContentForManualCheckpoint } from './manual-checkpoint.js';

export interface PromptBusEvents {
  readonly prompt: (prompt: PromptRecord) => void;
}

export class PromptBus {
  private readonly emitter = new EventEmitter();
  private readonly memory: MemoryAutomationService;

  public constructor(private readonly store: BrowserAgentStore, memory?: MemoryAutomationService) {
    this.memory = memory ?? new MemoryAutomationService(store);
  }

  public publishPrompt(input: {
    sessionId: string;
    source: 'cli' | 'extension';
    role: 'user' | 'assistant' | 'system';
    content: string;
    manualCheckpoint?: boolean;
  }): PromptRecord {
    const normalizedContent = normalizePromptContentForManualCheckpoint({
      source: input.source,
      role: input.role,
      content: input.content,
      manualCheckpoint: input.manualCheckpoint,
    });

    const prompt = this.store.insertPrompt({
      sessionId: input.sessionId,
      source: input.source,
      role: input.role,
      content: normalizedContent,
    });
    this.memory.capturePrompt({
      sessionId: input.sessionId,
      source: input.source,
      role: input.role,
      content: normalizedContent,
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
