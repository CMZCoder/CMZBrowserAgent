import { describe, expect, it } from 'vitest';
import { browserCommandSchema, isMutatingCommand } from '../protocol/commands.js';

describe('browser command schema', () => {
  it('accepts evaluate command payloads', () => {
    const parsed = browserCommandSchema.parse({
      type: 'evaluate',
      script: '(...args) => ({ value: args[0] })',
      args: ['ok'],
    });

    expect(parsed.type).toBe('evaluate');
  });

  it('treats evaluate as mutating command', () => {
    const parsed = browserCommandSchema.parse({
      type: 'evaluate',
      script: '() => 1',
    });

    expect(isMutatingCommand(parsed)).toBe(true);
  });
});
