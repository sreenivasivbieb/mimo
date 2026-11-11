import { describe, expect, it } from 'vitest';
import { fallbackFor, modelForTier } from '../src/models.js';

describe('model per tier', () => {
  it('reads time with Claude Haiku 5.5 and everything else with Claude Opus 5.5 by default', () => {
    expect(modelForTier('time', {} as NodeJS.ProcessEnv)).toBe('claude-haiku-5-5');
    for (const t of ['fast', 'main', 'deep'] as const) expect(modelForTier(t, {} as NodeJS.ProcessEnv)).toBe('claude-opus-5-5');
  });
  it('MODEL_TIME / MODEL_FAST override their tier only', () => {
    const env = { MODEL_TIME: 'claude-sonnet-5-5', MODEL_FAST: 'claude-haiku-5-5' } as NodeJS.ProcessEnv;
    expect(modelForTier('time', env)).toBe('claude-sonnet-5-5');
    expect(modelForTier('fast', env)).toBe('claude-haiku-5-5');
    expect(modelForTier('main', env)).toBe('claude-opus-5-5');
  });
  it('sends the server-side refusal fallback except to Haiku, which has none', () => {
    expect(fallbackFor('claude-haiku-5-5')).toEqual({});
    expect(fallbackFor('claude-opus-5-5')).toMatchObject({ fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
  });
});
