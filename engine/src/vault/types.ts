export interface SecretProvider {
  resolveSecret(secretKey: string): Promise<string>;
  testSecret(secretKey: string): Promise<{ ok: true } | { ok: false; error: string }>;
}
