import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Plan } from "../core/planning/plan.js";
import type { Message, TokenUsage } from "../providers/types.js";
import { emptyTotals, type UsageTotals } from "../telemetry/cost.js";

export interface SessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  provider: string;
  model: string;
  profile: string;
  title: string | null;
  status: string;
}

export interface StoredMessage {
  seq: number;
  message: Message;
  createdAt: string;
}

export interface CompactionRecord {
  boundarySeq: number;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  createdAt: string;
}

export interface ToolInvocationRecord {
  sessionId: string;
  toolCallId: string;
  name: string;
  arguments: string;
  status: "ok" | "error" | "denied" | "cancelled";
  output: string;
  data?: Record<string, unknown>;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface Checkpoint {
  status: string;
  turn: number;
  iteration: number;
  fileState?: Record<string, unknown>;
  note?: string;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     workspace TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
     profile TEXT NOT NULL, title TEXT, status TEXT NOT NULL DEFAULT 'idle');
   CREATE INDEX sessions_workspace ON sessions(workspace, updated_at);
   CREATE TABLE messages (
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL,
     created_at TEXT NOT NULL, PRIMARY KEY (session_id, seq));
   CREATE TABLE tool_invocations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     tool_call_id TEXT NOT NULL, name TEXT NOT NULL, arguments TEXT NOT NULL,
     status TEXT NOT NULL, output TEXT NOT NULL, data_json TEXT,
     started_at TEXT NOT NULL, ended_at TEXT NOT NULL, duration_ms INTEGER NOT NULL);
   CREATE INDEX tool_invocations_session ON tool_invocations(session_id);
   CREATE TABLE checkpoints (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     state_json TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE plans (
     session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
     plan_json TEXT, updated_at TEXT NOT NULL);
   CREATE TABLE compactions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     boundary_seq INTEGER NOT NULL, summary TEXT NOT NULL,
     tokens_before INTEGER NOT NULL, tokens_after INTEGER NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
     reasoning_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
     latency_ms INTEGER NOT NULL, cost_usd REAL, created_at TEXT NOT NULL);
   CREATE TABLE tool_latency (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     latency_ms INTEGER NOT NULL);`,
];

/**
 * Local session persistence (SQLite via Node's built-in `node:sqlite`, so no
 * native addon has to be compiled). The database file is created with mode
 * 0600 because it holds full transcripts, including private reasoning content
 * required for protocol-correct resumption.
 */
export class SessionStore {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const isNew = file !== ":memory:" && !existsSync(file);
    this.db = new DatabaseSync(file);
    if (isNew) chmodSync(file, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  createSession(s: { workspace: string; provider: string; model: string; profile: string; id?: string }): SessionRecord {
    const now = new Date().toISOString();
    const rec: SessionRecord = { id: s.id ?? randomUUID(), createdAt: now, updatedAt: now, workspace: s.workspace, provider: s.provider, model: s.model, profile: s.profile, title: null, status: "idle" };
    this.db
      .prepare("INSERT INTO sessions (id, created_at, updated_at, workspace, provider, model, profile, title, status) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(rec.id, rec.createdAt, rec.updatedAt, rec.workspace, rec.provider, rec.model, rec.profile, null, rec.status);
    return rec;
  }

  getSession(id: string): SessionRecord | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ? OR id LIKE ? ORDER BY updated_at DESC LIMIT 2").all(id, `${id}%`) as Record<string, unknown>[];
    if (r.length !== 1) return r.find((x) => x.id === id) ? mapSession(r.find((x) => x.id === id)!) : null;
    return mapSession(r[0]!);
  }

  latestSession(workspace: string): SessionRecord | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE workspace = ? ORDER BY updated_at DESC LIMIT 1").get(workspace) as Record<string, unknown> | undefined;
    return r ? mapSession(r) : null;
  }

  listSessions(workspace?: string, limit = 20): SessionRecord[] {
    const rows = workspace
      ? this.db.prepare("SELECT * FROM sessions WHERE workspace = ? ORDER BY updated_at DESC LIMIT ?").all(workspace, limit)
      : this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?").all(limit);
    return (rows as Record<string, unknown>[]).map(mapSession);
  }

  updateSession(id: string, patch: Partial<Pick<SessionRecord, "model" | "profile" | "title" | "status">>): void {
    const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
    const sets = [...fields.map(([k]) => `${k} = ?`), "updated_at = ?"].join(", ");
    this.db.prepare(`UPDATE sessions SET ${sets} WHERE id = ?`).run(...fields.map(([, v]) => v as string), new Date().toISOString(), id);
  }

  appendMessage(sessionId: string, message: Message): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE session_id = ?").get(sessionId) as { m: number };
    const seq = row.m + 1;
    this.db.prepare("INSERT INTO messages (session_id, seq, role, content_json, created_at) VALUES (?,?,?,?,?)").run(sessionId, seq, message.role, JSON.stringify(message), new Date().toISOString());
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
    return seq;
  }

  /** Messages with seq > afterSeq, in order. */
  loadMessages(sessionId: string, afterSeq = 0): StoredMessage[] {
    const rows = this.db.prepare("SELECT seq, content_json, created_at FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq").all(sessionId, afterSeq) as {
      seq: number;
      content_json: string;
      created_at: string;
    }[];
    return rows.map((r) => ({ seq: r.seq, message: JSON.parse(r.content_json) as Message, createdAt: r.created_at }));
  }

  lastSeq(sessionId: string): number {
    return (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE session_id = ?").get(sessionId) as { m: number }).m;
  }

  recordToolInvocation(r: ToolInvocationRecord): void {
    this.db
      .prepare("INSERT INTO tool_invocations (session_id, tool_call_id, name, arguments, status, output, data_json, started_at, ended_at, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(r.sessionId, r.toolCallId, r.name, r.arguments, r.status, r.output, r.data ? JSON.stringify(r.data) : null, r.startedAt, r.endedAt, r.durationMs);
    this.db.prepare("INSERT INTO tool_latency (session_id, latency_ms) VALUES (?, ?)").run(r.sessionId, r.durationMs);
  }

  listToolInvocations(sessionId: string): ToolInvocationRecord[] {
    const rows = this.db.prepare("SELECT * FROM tool_invocations WHERE session_id = ? ORDER BY id").all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      sessionId: r.session_id as string,
      toolCallId: r.tool_call_id as string,
      name: r.name as string,
      arguments: r.arguments as string,
      status: r.status as ToolInvocationRecord["status"],
      output: r.output as string,
      ...(r.data_json ? { data: JSON.parse(r.data_json as string) as Record<string, unknown> } : {}),
      startedAt: r.started_at as string,
      endedAt: r.ended_at as string,
      durationMs: r.duration_ms as number,
    }));
  }

  recordUsage(sessionId: string, model: string, usage: TokenUsage | null, latencyMs: number, costUsd: number | null): void {
    const u = usage ?? { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };
    this.db
      .prepare("INSERT INTO usage (session_id, model, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, latency_ms, cost_usd, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(sessionId, model, u.inputTokens, u.outputTokens, u.reasoningTokens, u.cachedInputTokens, Math.round(latencyMs), costUsd, new Date().toISOString());
  }

  usageTotals(sessionId: string): UsageTotals {
    const t = emptyTotals();
    const u = this.db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, COALESCE(SUM(reasoning_tokens),0) AS r, COALESCE(SUM(cached_input_tokens),0) AS c, COALESCE(SUM(latency_ms),0) AS l, COALESCE(SUM(cost_usd),0) AS cost, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown FROM usage WHERE session_id = ?",
      )
      .get(sessionId) as Record<string, number>;
    const tl = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(latency_ms),0) AS l FROM tool_latency WHERE session_id = ?").get(sessionId) as Record<string, number>;
    t.requests = u.n ?? 0;
    t.inputTokens = u.i ?? 0;
    t.outputTokens = u.o ?? 0;
    t.reasoningTokens = u.r ?? 0;
    t.cachedInputTokens = u.c ?? 0;
    t.modelLatencyMs = u.l ?? 0;
    t.costUsd = u.cost ?? 0;
    t.costIncomplete = (u.unknown ?? 0) > 0;
    t.toolCalls = tl.n ?? 0;
    t.toolLatencyMs = tl.l ?? 0;
    return t;
  }

  saveCheckpoint(sessionId: string, cp: Checkpoint): void {
    this.db.prepare("INSERT INTO checkpoints (session_id, state_json, created_at) VALUES (?,?,?)").run(sessionId, JSON.stringify(cp), new Date().toISOString());
    // Keep only recent checkpoints.
    this.db.prepare("DELETE FROM checkpoints WHERE session_id = ? AND id NOT IN (SELECT id FROM checkpoints WHERE session_id = ? ORDER BY id DESC LIMIT 20)").run(sessionId, sessionId);
  }

  latestCheckpoint(sessionId: string): Checkpoint | null {
    const r = this.db.prepare("SELECT state_json FROM checkpoints WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId) as { state_json: string } | undefined;
    return r ? (JSON.parse(r.state_json) as Checkpoint) : null;
  }

  savePlan(sessionId: string, plan: Plan | null): void {
    this.db
      .prepare("INSERT INTO plans (session_id, plan_json, updated_at) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET plan_json = excluded.plan_json, updated_at = excluded.updated_at")
      .run(sessionId, plan ? JSON.stringify(plan) : null, new Date().toISOString());
  }

  loadPlan(sessionId: string): Plan | null {
    const r = this.db.prepare("SELECT plan_json FROM plans WHERE session_id = ?").get(sessionId) as { plan_json: string | null } | undefined;
    return r?.plan_json ? (JSON.parse(r.plan_json) as Plan) : null;
  }

  saveCompaction(sessionId: string, c: Omit<CompactionRecord, "createdAt">): void {
    this.db
      .prepare("INSERT INTO compactions (session_id, boundary_seq, summary, tokens_before, tokens_after, created_at) VALUES (?,?,?,?,?,?)")
      .run(sessionId, c.boundarySeq, c.summary, c.tokensBefore, c.tokensAfter, new Date().toISOString());
  }

  latestCompaction(sessionId: string): CompactionRecord | null {
    const r = this.db.prepare("SELECT * FROM compactions WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { boundarySeq: r.boundary_seq as number, summary: r.summary as string, tokensBefore: r.tokens_before as number, tokensAfter: r.tokens_after as number, createdAt: r.created_at as string };
  }
}

function mapSession(r: Record<string, unknown>): SessionRecord {
  return {
    id: r.id as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    workspace: r.workspace as string,
    provider: r.provider as string,
    model: r.model as string,
    profile: r.profile as string,
    title: (r.title as string | null) ?? null,
    status: r.status as string,
  };
}
