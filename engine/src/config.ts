import os from 'node:os';
import path from 'node:path';

export interface EngineConfig {
  readonly host: string;
  readonly port: number;
  readonly pairingTtlSeconds: number;
  readonly wsTokenTtlSeconds: number;
  readonly dbPath: string;
  readonly allowedDomains: readonly string[];
}

const DEFAULT_ALLOWED_DOMAINS: readonly string[] = [
  'github.com',
  'vercel.com',
  'cloudflare.com',
  'neon.tech',
  'comerzio.ch',
];

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAllowedDomains(value: string | undefined): readonly string[] {
  if (!value) {
    return DEFAULT_ALLOWED_DOMAINS;
  }

  const domains = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  return domains.length > 0 ? domains : DEFAULT_ALLOWED_DOMAINS;
}

function resolveStateHome(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  if (xdgStateHome && path.isAbsolute(xdgStateHome)) {
    return xdgStateHome;
  }

  const homeDir = process.env.HOME?.trim() || os.homedir().trim();
  if (homeDir.length > 0 && path.isAbsolute(homeDir)) {
    return path.join(homeDir, '.local', 'state');
  }

  return path.resolve(process.cwd(), 'engine/state');
}

function resolveDbPath(rawValue: string | undefined): string {
  if (rawValue && rawValue.trim().length > 0) {
    const candidate = rawValue.trim();
    if (path.isAbsolute(candidate)) {
      return candidate;
    }

    return path.resolve(process.cwd(), candidate);
  }

  return path.join(resolveStateHome(), 'browser-agent', 'browser-agent.sqlite');
}

export function getEngineConfig(): EngineConfig {
  return {
    host: process.env.BROWSER_AGENT_HOST?.trim() || '127.0.0.1',
    port: parseNumber(process.env.BROWSER_AGENT_PORT, 8787),
    pairingTtlSeconds: parseNumber(process.env.BROWSER_AGENT_PAIRING_TTL_SECONDS, 300),
    wsTokenTtlSeconds: parseNumber(process.env.BROWSER_AGENT_WS_TOKEN_TTL_SECONDS, 12 * 60 * 60),
    dbPath: resolveDbPath(process.env.BROWSER_AGENT_DB_PATH),
    allowedDomains: parseAllowedDomains(process.env.BROWSER_AGENT_ALLOWED_DOMAINS),
  };
}

export function isAllowedDomain(url: string, allowedDomains: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    return allowedDomains.some((domain) => {
      const normalized = domain.toLowerCase();
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
  } catch {
    return false;
  }
}
