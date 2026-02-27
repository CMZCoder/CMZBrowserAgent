import { describe, expect, it } from 'vitest';
import { normalizePromptContentForManualCheckpoint } from '../prompt/manual-checkpoint.js';

describe('manual checkpoint prompt tagging', () => {
  it('adds USER_ACTION_REQUIRED tags when manualCheckpoint is explicitly true', () => {
    const normalized = normalizePromptContentForManualCheckpoint({
      source: 'cli',
      role: 'assistant',
      content: 'Please log in to GitHub and then tell me done.',
      manualCheckpoint: true,
    });

    expect(normalized).toContain('[USER_ACTION_REQUIRED]');
    expect(normalized).toContain('Please log in to GitHub and then tell me done.');
    expect(normalized).toContain('[/USER_ACTION_REQUIRED]');
  });

  it('does not double-wrap prompts already tagged', () => {
    const tagged = '[USER_ACTION_REQUIRED]\nLog in now.\n[/USER_ACTION_REQUIRED]';
    const normalized = normalizePromptContentForManualCheckpoint({
      source: 'cli',
      role: 'assistant',
      content: tagged,
      manualCheckpoint: true,
    });

    expect(normalized).toBe(tagged);
  });

  it('auto-tags likely manual checkpoints from cli assistant prompts', () => {
    const normalized = normalizePromptContentForManualCheckpoint({
      source: 'cli',
      role: 'assistant',
      content: 'Please sign in on Vercel and enter the verification code.',
    });

    expect(normalized).toContain('[USER_ACTION_REQUIRED]');
  });

  it('does not auto-tag when manual flag is explicitly false', () => {
    const normalized = normalizePromptContentForManualCheckpoint({
      source: 'cli',
      role: 'assistant',
      content: 'Please sign in on Vercel and enter the verification code.',
      manualCheckpoint: false,
    });

    expect(normalized).not.toContain('[USER_ACTION_REQUIRED]');
  });

  it('does not tag user role prompts', () => {
    const normalized = normalizePromptContentForManualCheckpoint({
      source: 'cli',
      role: 'user',
      content: 'Please sign in on Vercel and enter the verification code.',
      manualCheckpoint: true,
    });

    expect(normalized).not.toContain('[USER_ACTION_REQUIRED]');
  });
});
