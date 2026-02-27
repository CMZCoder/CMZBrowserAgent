import { spawn } from 'node:child_process';
import type { SecretProvider } from './types.js';
import type { BrowserAgentStore } from '../session/store.js';

function runOpRead(reference: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('op', ['read', reference], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to execute 1Password CLI: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `op read exited with code ${code ?? 'unknown'}`));
        return;
      }

      resolve(stdout.replace(/\r?\n$/, ''));
    });
  });
}

export class OnePasswordVault implements SecretProvider {
  public constructor(private readonly store: BrowserAgentStore) {}

  public async resolveSecret(secretKey: string): Promise<string> {
    const reference = this.store.getSecretReference(secretKey);
    if (!reference) {
      throw new Error(`Secret key '${secretKey}' is not mapped to an op:// reference.`);
    }

    const value = await runOpRead(reference);
    if (!value) {
      throw new Error(`1Password secret '${secretKey}' resolved to an empty value.`);
    }

    return value;
  }

  public async testSecret(secretKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.resolveSecret(secretKey);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
