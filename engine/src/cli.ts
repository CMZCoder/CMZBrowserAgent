#!/usr/bin/env node
import fs from 'node:fs';
import { getEngineConfig } from './config.js';

interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) {
      continue;
    }

    if (value === '--') {
      for (let cursor = index + 1; cursor < argv.length; cursor += 1) {
        const next = argv[cursor];
        if (next !== undefined) {
          positionals.push(next);
        }
      }
      break;
    }

    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }

    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options.set(key, true);
      continue;
    }

    options.set(key, next);
    index += 1;
  }

  return {
    positionals,
    options,
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function getStringOption(options: ReadonlyMap<string, string | boolean>, key: string): string | undefined {
  const raw = options.get(key);
  if (typeof raw !== 'string') {
    return undefined;
  }

  return raw;
}

function getBooleanOption(options: ReadonlyMap<string, string | boolean>, key: string, fallback: boolean): boolean {
  const raw = options.get(key);
  if (raw === undefined) {
    return fallback;
  }

  if (typeof raw === 'boolean') {
    return raw;
  }

  return raw === '1' || raw.toLowerCase() === 'true';
}

function getOptionalBooleanOption(
  options: ReadonlyMap<string, string | boolean>,
  key: string,
): boolean | undefined {
  const raw = options.get(key);
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw === 'boolean') {
    return raw;
  }

  return raw === '1' || raw.toLowerCase() === 'true';
}

function getEngineBaseUrl(options: ReadonlyMap<string, string | boolean>): string {
  const override = getStringOption(options, 'base-url');
  if (override) {
    return override;
  }

  if (process.env.BROWSER_AGENT_BASE_URL) {
    return process.env.BROWSER_AGENT_BASE_URL;
  }

  const config = getEngineConfig();
  return `http://${config.host}:${config.port}`;
}

interface RequestOptions {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
}

async function engineRequest(
  baseUrl: string,
  request: RequestOptions,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${baseUrl}${request.path}`, {
    method: request.method,
    headers: {
      'Content-Type': 'application/json',
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = {
      ok: response.ok,
      status: response.status,
      error: 'Engine returned non-JSON response.',
    };
  }

  return {
    status: response.status,
    json,
  };
}

async function resolveSessionId(
  baseUrl: string,
  options: ReadonlyMap<string, string | boolean>,
): Promise<string> {
  const direct = getStringOption(options, 'session');
  if (direct && direct.trim().length > 0) {
    return direct.trim();
  }

  const active = await engineRequest(baseUrl, {
    method: 'GET',
    path: '/v1/sessions/active',
  });

  const response = active.json as {
    ok?: boolean;
    session?: { id?: string } | null;
    error?: string;
  };

  if (!active.status.toString().startsWith('2') || !response.session?.id) {
    throw new Error(
      response.error ??
        'No active session was found. Start one with `browser-agent session start` or pass --session <id>.',
    );
  }

  return response.session.id;
}

function usage(): string {
  return [
    'BrowserAgent CLI',
    '',
    'Commands:',
    '  browser-agent start',
    '  browser-agent pairing start',
    '  browser-agent session start [--created-by cli]',
    '  browser-agent session stop [--session <id>]',
    '  browser-agent prompt send [--session <id>] --content "..." [--role user|assistant|system] [--source cli|extension] [--manual true|false]',
    '  browser-agent prompt pull [--session <id>] [--limit 50] [--consume true|false]',
    '  browser-agent command enqueue [--session <id>] --json "{...}" [--confirm <token>]',
    '  browser-agent state [--session <id>]',
    '  browser-agent secret set-ref --key <secret-key> --op-ref <op://vault/item/field>',
    '  browser-agent secret test --key <secret-key>',
    '',
    'Global options:',
    '  --base-url <http://127.0.0.1:8787>',
  ].join('\n');
}

async function run(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, subcommand, action] = parsed.positionals;

  if (!command) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === 'start') {
    const { startEngineServer } = await import('./index.js');
    await startEngineServer();
    return;
  }

  const baseUrl = getEngineBaseUrl(parsed.options);

  if (command === 'pairing' && subcommand === 'start') {
    const issuedBy = getStringOption(parsed.options, 'issued-by') ?? 'cli';
    const response = await engineRequest(baseUrl, {
      method: 'POST',
      path: '/v1/pairing/start',
      body: { issuedBy },
    });

    printJson(response.json);
    if (!String(response.status).startsWith('2')) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'session' && subcommand === 'start') {
    const createdBy = getStringOption(parsed.options, 'created-by') ?? 'cli';
    const response = await engineRequest(baseUrl, {
      method: 'POST',
      path: '/v1/sessions/start',
      body: { createdBy },
    });

    printJson(response.json);
    if (!String(response.status).startsWith('2')) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'session' && subcommand === 'stop') {
    const sessionId = await resolveSessionId(baseUrl, parsed.options);
    const response = await engineRequest(baseUrl, {
      method: 'POST',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/stop`,
      body: {},
    });

    printJson(response.json);
    if (!String(response.status).startsWith('2')) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'prompt' && subcommand === 'send') {
    const sessionId = await resolveSessionId(baseUrl, parsed.options);
    const source = getStringOption(parsed.options, 'source') ?? 'cli';
    const role = getStringOption(parsed.options, 'role') ?? 'user';
    const manualCheckpoint = getOptionalBooleanOption(parsed.options, 'manual');
    const contentFromOption = getStringOption(parsed.options, 'content');
    const fallbackContent = parsed.positionals.slice(2).join(' ').trim();
    const content = contentFromOption?.trim() || fallbackContent;

    if (!content) {
      throw new Error('Missing prompt content. Provide --content "...".');
    }

    const response = await engineRequest(baseUrl, {
      method: 'POST',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/prompts`,
      body: {
        source,
        role,
        content,
        manualCheckpoint,
      },
    });

    printJson(response.json);
    if (!String(response.status).startsWith('2')) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'prompt' && subcommand === 'pull') {
    const sessionId = await resolveSessionId(baseUrl, parsed.options);
    const limit = getStringOption(parsed.options, 'limit') ?? '50';
    const consume = getBooleanOption(parsed.options, 'consume', true);

    const response = await engineRequest(baseUrl, {
      method: 'GET',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/prompts/pull?limit=${encodeURIComponent(limit)}&consume=${consume ? 'true' : 'false'}`,
    });

    printJson(response.json);
    if (!String(response.status).startsWith('2')) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'command' && subcommand === 'enqueue') {
    const sessionId = await resolveSessionId(baseUrl, parsed.options);
    const inlineJson = getStringOption(parsed.options, 'json');
    const jsonFile = getStringOption(parsed.options, 'json-file');

    let rawCommandJson = inlineJson;
    if (!rawCommandJson && jsonFile) {
      rawCommandJson = fs.readFileSync(jsonFile, 'utf8');
    }

    if (!rawCommandJson) {
      throw new Error('Missing command payload. Provide --json "{...}" or --json-file <path>.');
    }

    let commandPayload: unknown;
    try {
      commandPayload = JSON.parse(rawCommandJson);
    } catch (error) {
      throw new Error(`Invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`);
    }

    const confirmationToken = getStringOption(parsed.options, 'confirm');
    const response = await engineRequest(baseUrl, {
      method: 'POST',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
      body: {
        command: commandPayload,
        confirmationToken,
      },
    });

    printJson(response.json);
    if (!String(response.status).startsWith('2')) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'state') {
    const sessionId = await resolveSessionId(baseUrl, parsed.options);
    const response = await engineRequest(baseUrl, {
      method: 'GET',
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/state`,
    });

    printJson(response.json);
    if (!String(response.status).startsWith('2')) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'secret' && subcommand === 'set-ref') {
    const secretKey = getStringOption(parsed.options, 'key');
    const opRef = getStringOption(parsed.options, 'op-ref');

    if (!secretKey || !opRef) {
      throw new Error('Missing required options. Use --key <secret-key> --op-ref <op://...>.');
    }

    const response = await engineRequest(baseUrl, {
      method: 'POST',
      path: '/v1/secrets/set-ref',
      body: {
        secretKey,
        opRef,
      },
    });

    printJson(response.json);
    if (!String(response.status).startsWith('2')) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'secret' && subcommand === 'test') {
    const secretKey = getStringOption(parsed.options, 'key');
    if (!secretKey) {
      throw new Error('Missing required option --key <secret-key>.');
    }

    const response = await engineRequest(baseUrl, {
      method: 'POST',
      path: '/v1/secrets/test',
      body: {
        secretKey,
      },
    });

    printJson(response.json);
    if (!String(response.status).startsWith('2')) {
      process.exitCode = 1;
    }
    return;
  }

  process.stdout.write(`${usage()}\n`);
  process.exitCode = 1;
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
