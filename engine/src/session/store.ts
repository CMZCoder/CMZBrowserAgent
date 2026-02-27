import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { BrowserCommand, BrowserCommandType } from '../protocol/commands.js';

export type CommandApprovalSource =
  | 'none'
  | 'user_confirmation'
  | 'memory_auto_approve'
  | 'awaiting_confirmation';

export interface SessionRecord {
  readonly id: string;
  readonly status: 'active' | 'stopped';
  readonly createdAt: string;
  readonly startedAt: string;
  readonly stoppedAt: string | null;
  readonly createdBy: string;
  readonly confirmationToken: string;
}

export interface PromptRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly source: 'cli' | 'extension';
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly createdAt: string;
  readonly consumedAt: string | null;
}

export interface CommandRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly commandType: BrowserCommandType;
  readonly payload: BrowserCommand;
  readonly requiresConfirmation: boolean;
  readonly approvalSource: CommandApprovalSource;
  readonly status: 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'awaiting_confirmation' | 'cancelled';
  readonly createdAt: string;
  readonly dispatchedAt: string | null;
  readonly completedAt: string | null;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
  readonly durationMs: number | null;
}

export interface MemoryPatternRecord {
  readonly id: number;
  readonly host: string;
  readonly commandType: BrowserCommandType;
  readonly fingerprint: string;
  readonly payload: Record<string, unknown>;
  readonly autoApprove: boolean;
  readonly successCount: number;
  readonly failureCount: number;
  readonly confirmedSuccessCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
}

interface PairingRow {
  readonly code: string;
  readonly expiresAt: string;
}

interface AuditInsert {
  readonly eventType: string;
  readonly message: string;
  readonly payloadJson: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

export class BrowserAgentStore {
  private readonly db: DatabaseSync;

  public constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  public close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pairings (
        code TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        issued_by TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trusted_extensions (
        extension_id TEXT PRIMARY KEY,
        paired_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ws_tokens (
        token TEXT PRIMARY KEY,
        extension_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (extension_id) REFERENCES trusted_extensions (extension_id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        stopped_at TEXT,
        created_by TEXT NOT NULL,
        confirmation_token TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS sessions_single_active_idx
      ON sessions ((status))
      WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions (id)
      );

      CREATE INDEX IF NOT EXISTS prompts_session_created_idx
      ON prompts (session_id, created_at);

      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        command_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        requires_confirmation INTEGER NOT NULL,
        approval_source TEXT NOT NULL DEFAULT 'none',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        completed_at TEXT,
        result_json TEXT,
        error TEXT,
        duration_ms INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions (id)
      );

      CREATE INDEX IF NOT EXISTS commands_session_status_created_idx
      ON commands (session_id, status, created_at);

      CREATE TABLE IF NOT EXISTS memory_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host TEXT NOT NULL,
        command_type TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        auto_approve INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        confirmed_success_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS memory_patterns_unique_idx
      ON memory_patterns (host, command_type, fingerprint);

      CREATE INDEX IF NOT EXISTS memory_patterns_host_type_idx
      ON memory_patterns (host, command_type, auto_approve, updated_at);

      CREATE TABLE IF NOT EXISTS secrets (
        secret_key TEXT PRIMARY KEY,
        op_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS extension_states (
        extension_id TEXT PRIMARY KEY,
        active_tab_id INTEGER,
        active_tab_url TEXT,
        panel_open INTEGER,
        status TEXT,
        timestamp TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
    `);

    const commandColumns = this.db.prepare(`PRAGMA table_info(commands)`).all() as Array<{ name: string }>;
    if (!commandColumns.some((column) => column.name === 'approval_source')) {
      this.db.exec(`ALTER TABLE commands ADD COLUMN approval_source TEXT NOT NULL DEFAULT 'none';`);
    }
  }

  public createPairingCode(pairingTtlSeconds: number, issuedBy: string): PairingRow {
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + pairingTtlSeconds * 1000).toISOString();

    let code = '';
    const insert = this.db.prepare(`
      INSERT INTO pairings (code, created_at, expires_at, consumed_at, issued_by)
      VALUES (?, ?, ?, NULL, ?)
    `);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      code = String(Math.floor(100000 + Math.random() * 900000));
      try {
        insert.run(code, createdAt, expiresAt, issuedBy);
        return { code, expiresAt };
      } catch {
        continue;
      }
    }

    throw new Error('Unable to generate unique pairing code.');
  }

  public completePairing(code: string, extensionId: string): { pairedAt: string } | null {
    const row = this.db.prepare(`
      SELECT code, expires_at, consumed_at
      FROM pairings
      WHERE code = ?
      LIMIT 1
    `).get(code) as { code: string; expires_at: string; consumed_at: string | null } | undefined;

    if (!row) return null;
    if (row.consumed_at) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;

    const pairedAt = nowIso();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE pairings
        SET consumed_at = ?
        WHERE code = ?
      `).run(pairedAt, code);

      this.db.prepare(`
        INSERT INTO trusted_extensions (extension_id, paired_at, last_seen_at, status)
        VALUES (?, ?, ?, 'active')
        ON CONFLICT(extension_id) DO UPDATE SET
          paired_at = excluded.paired_at,
          last_seen_at = excluded.last_seen_at,
          status = 'active'
      `).run(extensionId, pairedAt, pairedAt);

      this.db.exec('COMMIT');
      return { pairedAt };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public issueWsToken(extensionId: string, ttlSeconds: number): { token: string; expiresAt: string } {
    const token = crypto.randomBytes(32).toString('hex');
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    this.db.prepare(`
      INSERT INTO ws_tokens (token, extension_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(token, extensionId, createdAt, expiresAt);

    return { token, expiresAt };
  }

  public validateWsToken(token: string, extensionId: string): boolean {
    const row = this.db.prepare(`
      SELECT ws.token
      FROM ws_tokens ws
      INNER JOIN trusted_extensions te
      ON te.extension_id = ws.extension_id
      WHERE ws.token = ?
        AND ws.extension_id = ?
        AND ws.expires_at > ?
        AND te.status = 'active'
      LIMIT 1
    `).get(token, extensionId, nowIso()) as { token: string } | undefined;

    return Boolean(row);
  }

  public isTrustedExtensionActive(extensionId: string): boolean {
    const row = this.db.prepare(`
      SELECT extension_id
      FROM trusted_extensions
      WHERE extension_id = ?
        AND status = 'active'
      LIMIT 1
    `).get(extensionId) as { extension_id: string } | undefined;

    return Boolean(row);
  }

  public touchTrustedExtension(extensionId: string): void {
    this.db.prepare(`
      UPDATE trusted_extensions
      SET last_seen_at = ?
      WHERE extension_id = ?
    `).run(nowIso(), extensionId);
  }

  public createSession(createdBy: string): SessionRecord {
    const id = randomId('session');
    const createdAt = nowIso();
    const confirmationToken = crypto.randomBytes(18).toString('hex');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db.prepare(`
        SELECT id FROM sessions WHERE status = 'active' LIMIT 1
      `).get() as { id: string } | undefined;

      if (active) {
        throw new Error(`An active session already exists (${active.id}). Stop it before creating a new session.`);
      }

      this.db.prepare(`
        INSERT INTO sessions (id, status, created_at, started_at, stopped_at, created_by, confirmation_token)
        VALUES (?, 'active', ?, ?, NULL, ?, ?)
      `).run(id, createdAt, createdAt, createdBy, confirmationToken);

      this.db.exec('COMMIT');
      return {
        id,
        status: 'active',
        createdAt,
        startedAt: createdAt,
        stoppedAt: null,
        createdBy,
        confirmationToken,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public stopSession(sessionId: string): SessionRecord | null {
    const stoppedAt = nowIso();

    const result = this.db.prepare(`
      UPDATE sessions
      SET status = 'stopped', stopped_at = ?
      WHERE id = ? AND status = 'active'
    `).run(stoppedAt, sessionId);

    if (result.changes < 1) {
      return null;
    }

    return this.getSession(sessionId);
  }

  public getSession(sessionId: string): SessionRecord | null {
    const row = this.db.prepare(`
      SELECT id, status, created_at, started_at, stopped_at, created_by, confirmation_token
      FROM sessions
      WHERE id = ?
      LIMIT 1
    `).get(sessionId) as {
      id: string;
      status: 'active' | 'stopped';
      created_at: string;
      started_at: string;
      stopped_at: string | null;
      created_by: string;
      confirmation_token: string;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      startedAt: row.started_at,
      stoppedAt: row.stopped_at,
      createdBy: row.created_by,
      confirmationToken: row.confirmation_token,
    };
  }

  public getActiveSession(): SessionRecord | null {
    const row = this.db.prepare(`
      SELECT id
      FROM sessions
      WHERE status = 'active'
      LIMIT 1
    `).get() as { id: string } | undefined;

    if (!row) return null;
    return this.getSession(row.id);
  }

  public insertPrompt(input: {
    sessionId: string;
    source: 'cli' | 'extension';
    role: 'user' | 'assistant' | 'system';
    content: string;
  }): PromptRecord {
    const id = randomId('prompt');
    const createdAt = nowIso();

    this.db.prepare(`
      INSERT INTO prompts (id, session_id, source, role, content, created_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(id, input.sessionId, input.source, input.role, input.content, createdAt);

    return {
      id,
      sessionId: input.sessionId,
      source: input.source,
      role: input.role,
      content: input.content,
      createdAt,
      consumedAt: null,
    };
  }

  public pullPrompts(sessionId: string, limit: number, consume: boolean): readonly PromptRecord[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, source, role, content, created_at, consumed_at
      FROM prompts
      WHERE session_id = ?
        AND consumed_at IS NULL
      ORDER BY created_at ASC
      LIMIT ?
    `).all(sessionId, limit) as Array<{
      id: string;
      session_id: string;
      source: 'cli' | 'extension';
      role: 'user' | 'assistant' | 'system';
      content: string;
      created_at: string;
      consumed_at: string | null;
    }>;

    if (consume && rows.length > 0) {
      const consumedAt = nowIso();
      const ids = rows.map((row) => row.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(`
        UPDATE prompts
        SET consumed_at = ?
        WHERE id IN (${placeholders})
      `).run(consumedAt, ...ids);
    }

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      source: row.source,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      consumedAt: row.consumed_at,
    }));
  }

  public listRecentPrompts(sessionId: string, limit: number): readonly PromptRecord[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, source, role, content, created_at, consumed_at
      FROM prompts
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, limit) as Array<{
      id: string;
      session_id: string;
      source: 'cli' | 'extension';
      role: 'user' | 'assistant' | 'system';
      content: string;
      created_at: string;
      consumed_at: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      source: row.source,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      consumedAt: row.consumed_at,
    }));
  }

  public insertCommand(input: {
    sessionId: string;
    command: BrowserCommand;
    requiresConfirmation: boolean;
    approvalSource: CommandApprovalSource;
    status: CommandRecord['status'];
  }): CommandRecord {
    const id = randomId('command');
    const createdAt = nowIso();

    this.db.prepare(`
      INSERT INTO commands (
        id,
        session_id,
        command_type,
        payload_json,
        requires_confirmation,
        approval_source,
        status,
        created_at,
        dispatched_at,
        completed_at,
        result_json,
        error,
        duration_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
    `).run(
      id,
      input.sessionId,
      input.command.type,
      JSON.stringify(input.command),
      input.requiresConfirmation ? 1 : 0,
      input.approvalSource,
      input.status,
      createdAt,
    );

    return {
      id,
      sessionId: input.sessionId,
      commandType: input.command.type,
      payload: input.command,
      requiresConfirmation: input.requiresConfirmation,
      approvalSource: input.approvalSource,
      status: input.status,
      createdAt,
      dispatchedAt: null,
      completedAt: null,
      result: null,
      error: null,
      durationMs: null,
    };
  }

  public getNextQueuedCommand(sessionId: string): CommandRecord | null {
    const row = this.db.prepare(`
      SELECT id, session_id, command_type, payload_json, requires_confirmation, status,
             approval_source, created_at, dispatched_at, completed_at, result_json, error, duration_ms
      FROM commands
      WHERE session_id = ?
        AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `).get(sessionId) as {
      id: string;
      session_id: string;
      command_type: BrowserCommandType;
      payload_json: string;
      requires_confirmation: number;
      approval_source: CommandApprovalSource;
      status: CommandRecord['status'];
      created_at: string;
      dispatched_at: string | null;
      completed_at: string | null;
      result_json: string | null;
      error: string | null;
      duration_ms: number | null;
    } | undefined;

    if (!row) return null;
    const payload = parseJson<BrowserCommand>(row.payload_json);
    if (!payload) return null;

    return {
      id: row.id,
      sessionId: row.session_id,
      commandType: row.command_type,
      payload,
      requiresConfirmation: row.requires_confirmation === 1,
      approvalSource: row.approval_source,
      status: row.status,
      createdAt: row.created_at,
      dispatchedAt: row.dispatched_at,
      completedAt: row.completed_at,
      result: parseJson<Record<string, unknown>>(row.result_json),
      error: row.error,
      durationMs: row.duration_ms,
    };
  }

  public markCommandDispatched(commandId: string): void {
    this.db.prepare(`
      UPDATE commands
      SET status = 'dispatched', dispatched_at = ?
      WHERE id = ?
    `).run(nowIso(), commandId);
  }

  public markCommandSucceeded(commandId: string, result: Record<string, unknown>, durationMs?: number): void {
    this.db.prepare(`
      UPDATE commands
      SET status = 'succeeded', completed_at = ?, result_json = ?, error = NULL, duration_ms = ?
      WHERE id = ?
    `).run(nowIso(), JSON.stringify(result), durationMs ?? null, commandId);
  }

  public markCommandFailed(commandId: string, errorMessage: string, durationMs?: number): void {
    this.db.prepare(`
      UPDATE commands
      SET status = 'failed', completed_at = ?, error = ?, duration_ms = ?
      WHERE id = ?
    `).run(nowIso(), errorMessage, durationMs ?? null, commandId);
  }

  public getCommand(commandId: string): CommandRecord | null {
    const row = this.db.prepare(`
      SELECT id, session_id, command_type, payload_json, requires_confirmation, status,
             approval_source, created_at, dispatched_at, completed_at, result_json, error, duration_ms
      FROM commands
      WHERE id = ?
      LIMIT 1
    `).get(commandId) as {
      id: string;
      session_id: string;
      command_type: BrowserCommandType;
      payload_json: string;
      requires_confirmation: number;
      approval_source: CommandApprovalSource;
      status: CommandRecord['status'];
      created_at: string;
      dispatched_at: string | null;
      completed_at: string | null;
      result_json: string | null;
      error: string | null;
      duration_ms: number | null;
    } | undefined;

    if (!row) return null;
    const payload = parseJson<BrowserCommand>(row.payload_json);
    if (!payload) return null;

    return {
      id: row.id,
      sessionId: row.session_id,
      commandType: row.command_type,
      payload,
      requiresConfirmation: row.requires_confirmation === 1,
      approvalSource: row.approval_source,
      status: row.status,
      createdAt: row.created_at,
      dispatchedAt: row.dispatched_at,
      completedAt: row.completed_at,
      result: parseJson<Record<string, unknown>>(row.result_json),
      error: row.error,
      durationMs: row.duration_ms,
    };
  }

  public listRecentCommands(sessionId: string, limit: number): readonly CommandRecord[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, command_type, payload_json, requires_confirmation, status,
             approval_source, created_at, dispatched_at, completed_at, result_json, error, duration_ms
      FROM commands
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, limit) as Array<{
      id: string;
      session_id: string;
      command_type: BrowserCommandType;
      payload_json: string;
      requires_confirmation: number;
      approval_source: CommandApprovalSource;
      status: CommandRecord['status'];
      created_at: string;
      dispatched_at: string | null;
      completed_at: string | null;
      result_json: string | null;
      error: string | null;
      duration_ms: number | null;
    }>;

    return rows
      .map((row) => {
        const payload = parseJson<BrowserCommand>(row.payload_json);
        if (!payload) {
          return null;
        }

        return {
          id: row.id,
          sessionId: row.session_id,
          commandType: row.command_type,
          payload,
          requiresConfirmation: row.requires_confirmation === 1,
          approvalSource: row.approval_source,
          status: row.status,
          createdAt: row.created_at,
          dispatchedAt: row.dispatched_at,
          completedAt: row.completed_at,
          result: parseJson<Record<string, unknown>>(row.result_json),
          error: row.error,
          durationMs: row.duration_ms,
        } satisfies CommandRecord;
      })
      .filter((entry): entry is CommandRecord => entry !== null);
  }

  public setSecretReference(secretKey: string, opRef: string): void {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO secrets (secret_key, op_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(secret_key) DO UPDATE SET
        op_ref = excluded.op_ref,
        updated_at = excluded.updated_at
    `).run(secretKey, opRef, timestamp, timestamp);
  }

  public getSecretReference(secretKey: string): string | null {
    const row = this.db.prepare(`
      SELECT op_ref
      FROM secrets
      WHERE secret_key = ?
      LIMIT 1
    `).get(secretKey) as { op_ref: string } | undefined;

    return row?.op_ref ?? null;
  }

  public updateExtensionState(input: {
    extensionId: string;
    activeTabId?: number;
    activeTabUrl?: string;
    panelOpen?: boolean;
    status?: string;
    timestamp?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO extension_states (
        extension_id,
        active_tab_id,
        active_tab_url,
        panel_open,
        status,
        timestamp,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(extension_id) DO UPDATE SET
        active_tab_id = excluded.active_tab_id,
        active_tab_url = excluded.active_tab_url,
        panel_open = excluded.panel_open,
        status = excluded.status,
        timestamp = excluded.timestamp,
        updated_at = excluded.updated_at
    `).run(
      input.extensionId,
      input.activeTabId ?? null,
      input.activeTabUrl ?? null,
      input.panelOpen === undefined ? null : input.panelOpen ? 1 : 0,
      input.status ?? null,
      input.timestamp ?? null,
      nowIso(),
    );
  }

  public getLatestExtensionState(): {
    extensionId: string;
    activeTabId: number | null;
    activeTabUrl: string | null;
    panelOpen: boolean | null;
    status: string | null;
    timestamp: string | null;
    updatedAt: string;
  } | null {
    const row = this.db.prepare(`
      SELECT extension_id, active_tab_id, active_tab_url, panel_open, status, timestamp, updated_at
      FROM extension_states
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as {
      extension_id: string;
      active_tab_id: number | null;
      active_tab_url: string | null;
      panel_open: number | null;
      status: string | null;
      timestamp: string | null;
      updated_at: string;
    } | undefined;

    if (!row) return null;

    return {
      extensionId: row.extension_id,
      activeTabId: row.active_tab_id,
      activeTabUrl: row.active_tab_url,
      panelOpen: row.panel_open === null ? null : row.panel_open === 1,
      status: row.status,
      timestamp: row.timestamp,
      updatedAt: row.updated_at,
    };
  }

  public getMemoryPattern(host: string, commandType: BrowserCommandType, fingerprint: string): MemoryPatternRecord | null {
    const row = this.db.prepare(`
      SELECT id, host, command_type, fingerprint, payload_json, auto_approve,
             success_count, failure_count, confirmed_success_count,
             created_at, updated_at, last_used_at
      FROM memory_patterns
      WHERE host = ? AND command_type = ? AND fingerprint = ?
      LIMIT 1
    `).get(host, commandType, fingerprint) as {
      id: number;
      host: string;
      command_type: BrowserCommandType;
      fingerprint: string;
      payload_json: string;
      auto_approve: number;
      success_count: number;
      failure_count: number;
      confirmed_success_count: number;
      created_at: string;
      updated_at: string;
      last_used_at: string | null;
    } | undefined;

    if (!row) {
      return null;
    }

    const payload = parseJson<Record<string, unknown>>(row.payload_json) ?? {};
    return {
      id: row.id,
      host: row.host,
      commandType: row.command_type,
      fingerprint: row.fingerprint,
      payload,
      autoApprove: row.auto_approve === 1,
      successCount: row.success_count,
      failureCount: row.failure_count,
      confirmedSuccessCount: row.confirmed_success_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
    };
  }

  public touchMemoryPattern(memoryPatternId: number): void {
    this.db.prepare(`
      UPDATE memory_patterns
      SET last_used_at = ?, updated_at = ?
      WHERE id = ?
    `).run(nowIso(), nowIso(), memoryPatternId);
  }

  public recordMemoryPatternOutcome(input: {
    host: string;
    commandType: BrowserCommandType;
    fingerprint: string;
    payload: Record<string, unknown>;
    success: boolean;
    approvalSource: CommandApprovalSource;
    autoApproveEligible: boolean;
  }): void {
    const now = nowIso();
    const existing = this.getMemoryPattern(input.host, input.commandType, input.fingerprint);

    if (!existing) {
      const successCount = input.success ? 1 : 0;
      const failureCount = input.success ? 0 : 1;
      const confirmedSuccessCount =
        input.success && input.approvalSource === 'user_confirmation' ? 1 : 0;

      this.db.prepare(`
        INSERT INTO memory_patterns (
          host, command_type, fingerprint, payload_json,
          auto_approve, success_count, failure_count, confirmed_success_count,
          created_at, updated_at, last_used_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.host,
        input.commandType,
        input.fingerprint,
        JSON.stringify(input.payload),
        0,
        successCount,
        failureCount,
        confirmedSuccessCount,
        now,
        now,
        now,
      );
      return;
    }

    const successCount = existing.successCount + (input.success ? 1 : 0);
    const failureCount = existing.failureCount + (input.success ? 0 : 1);
    const confirmedSuccessCount =
      existing.confirmedSuccessCount +
      (input.success && input.approvalSource === 'user_confirmation' ? 1 : 0);

    let autoApprove = existing.autoApprove;
    if (!input.success && input.approvalSource === 'memory_auto_approve') {
      autoApprove = false;
    }

    if (
      input.success &&
      input.autoApproveEligible &&
      confirmedSuccessCount >= 2 &&
      failureCount === 0
    ) {
      autoApprove = true;
    }

    this.db.prepare(`
      UPDATE memory_patterns
      SET payload_json = ?,
          auto_approve = ?,
          success_count = ?,
          failure_count = ?,
          confirmed_success_count = ?,
          updated_at = ?,
          last_used_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(input.payload),
      autoApprove ? 1 : 0,
      successCount,
      failureCount,
      confirmedSuccessCount,
      now,
      now,
      existing.id,
    );
  }

  public listMemoryPatterns(limit: number): readonly MemoryPatternRecord[] {
    const rows = this.db.prepare(`
      SELECT id, host, command_type, fingerprint, payload_json, auto_approve,
             success_count, failure_count, confirmed_success_count,
             created_at, updated_at, last_used_at
      FROM memory_patterns
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: number;
      host: string;
      command_type: BrowserCommandType;
      fingerprint: string;
      payload_json: string;
      auto_approve: number;
      success_count: number;
      failure_count: number;
      confirmed_success_count: number;
      created_at: string;
      updated_at: string;
      last_used_at: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      host: row.host,
      commandType: row.command_type,
      fingerprint: row.fingerprint,
      payload: parseJson<Record<string, unknown>>(row.payload_json) ?? {},
      autoApprove: row.auto_approve === 1,
      successCount: row.success_count,
      failureCount: row.failure_count,
      confirmedSuccessCount: row.confirmed_success_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  public clearMemoryPatterns(): number {
    const result = this.db.prepare(`DELETE FROM memory_patterns`).run();
    return Number(result.changes);
  }

  public getMemorySummary(): {
    totalPatterns: number;
    autoApprovePatterns: number;
    recentlyUsedPatterns: number;
  } {
    const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const totals = this.db.prepare(`
      SELECT
        COUNT(*) as total_patterns,
        SUM(CASE WHEN auto_approve = 1 THEN 1 ELSE 0 END) as auto_approve_patterns,
        SUM(CASE WHEN last_used_at IS NOT NULL AND last_used_at >= ? THEN 1 ELSE 0 END) as recently_used_patterns
      FROM memory_patterns
    `).get(sevenDaysAgoIso) as {
      total_patterns: number | null;
      auto_approve_patterns: number | null;
      recently_used_patterns: number | null;
    };

    return {
      totalPatterns: totals.total_patterns ?? 0,
      autoApprovePatterns: totals.auto_approve_patterns ?? 0,
      recentlyUsedPatterns: totals.recently_used_patterns ?? 0,
    };
  }

  public insertAuditLog(input: AuditInsert): void {
    this.db.prepare(`
      INSERT INTO audit_logs (event_type, message, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      input.eventType,
      input.message,
      input.payloadJson === null ? null : JSON.stringify(input.payloadJson),
      nowIso(),
    );
  }
}
