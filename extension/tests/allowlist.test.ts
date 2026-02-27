import { describe, expect, it } from 'vitest';
import { isAllowedHost, isAllowedUrl } from '../src/allowlist';

describe('BrowserAgent extension allowlist', () => {
  it('allows BrowserAgent control-plane hostnames', () => {
    expect(isAllowedHost('github.com')).toBe(true);
    expect(isAllowedHost('docs.github.com')).toBe(true);
    expect(isAllowedHost('vercel.com')).toBe(true);
    expect(isAllowedHost('dashboard.vercel.com')).toBe(true);
    expect(isAllowedHost('dash.cloudflare.com')).toBe(true);
    expect(isAllowedHost('api.cloudflare.com')).toBe(true);
    expect(isAllowedHost('console.neon.tech')).toBe(true);
    expect(isAllowedHost('comerzio.ch')).toBe(true);
  });

  it('rejects other domains and non-https urls', () => {
    expect(isAllowedHost('example.com')).toBe(false);
    expect(isAllowedUrl('https://example.com')).toBe(false);
    expect(isAllowedUrl('http://github.com')).toBe(false);
    expect(isAllowedUrl('not a url')).toBe(false);
  });
});
