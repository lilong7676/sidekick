// The ledger. All state lives here, not in any session (plan §3): swap the model, restart the
// daemon, come back tomorrow, and the same ledger gives the same answer.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type TaskStatus =
  | "queued" | "running" | "needs_approval" | "needs_me" | "paused"
  | "done" | "closed" | "failed" | "cancelled";

export const OPEN_STATUSES: TaskStatus[] = ["queued", "running", "needs_approval", "needs_me", "paused"];

export interface EventRow {
  id: number;
  source: string;
  kind: string;
  dedupe_key: string;
  channel: string | null;
  channel_name: string | null;
  ts: string | null;
  thread_ts: string | null;
  user_id: string | null;
  user_name: string | null;
  text: string | null;
  received_at: number;
  task_id: string | null;
}

export interface TaskRow {
  id: string;
  source: string;
  kind: string;
  title: string;
  status: TaskStatus;
  event_id: number | null;
  session_id: string | null;
  /** Text appended to the next run (approval results, my feedback). Cleared when consumed. */
  next_prompt: string | null;
  outcome: string | null;
  summary: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
  /** Last status I was notified about, so each needs_me / failed is announced once. */
  notified_status: string | null;
  /**
   * When I took its session into the Claude desktop app (queries.ts continueInClaude). That session is
   * mine from then on: the task's next run starts a session of its own instead of resuming it.
   */
  handed_off_at: number | null;
  /** Off-hours Slack work waits until then (intake.ts, settings workHours); null: runs when its turn comes. */
  not_before: number | null;
}

export interface RunRow {
  id: string;
  task_id: string | null;
  /** Kind of run ("agent"). */
  stage: string;
  session_id: string | null;
  pid: number | null;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  cost_usd: number | null;
  turns: number | null;
  log_path: string | null;
  error: string | null;
}

export interface ApprovalRow {
  id: string;
  task_id: string;
  run_id: string | null;
  kind: "tool" | "outbound";
  /** Same tool + same input → same key; used to auto-allow on resume and to dedupe retries. */
  key: string;
  payload: string;
  status: "pending" | "approved" | "denied" | "executed" | "failed";
  decision_note: string | null;
  created_at: number;
  decided_at: number | null;
  /** "inline" when the waiting run got the answer itself; "requeued" / "executed: …" once the daemon acted on it. */
  result: string | null;
  notified: number;
}

export function openDb(stateDir: string): Database {
  mkdirSync(stateDir, { recursive: true });
  const db = new Database(join(stateDir, "sidekick.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source          TEXT NOT NULL,
      kind            TEXT NOT NULL,
      dedupe_key      TEXT NOT NULL UNIQUE,
      channel         TEXT,
      channel_name    TEXT,
      ts              TEXT,
      thread_ts       TEXT,
      user_id         TEXT,
      user_name       TEXT,
      text            TEXT,
      received_at     INTEGER NOT NULL,
      task_id         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, received_at);

    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL,
      kind        TEXT NOT NULL,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL,
      event_id    INTEGER,
      session_id  TEXT,
      next_prompt TEXT,
      outcome     TEXT,
      summary     TEXT,
      attempts    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      notified_status TEXT,
      handed_off_at INTEGER,
      not_before  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updated_at);

    CREATE TABLE IF NOT EXISTS runs (
      id          TEXT PRIMARY KEY,
      task_id     TEXT,
      stage       TEXT NOT NULL,
      session_id  TEXT,
      pid         INTEGER,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      exit_code   INTEGER,
      cost_usd    REAL,
      turns       INTEGER,
      log_path    TEXT,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, started_at);

    CREATE TABLE IF NOT EXISTS approvals (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL,
      run_id        TEXT,
      kind          TEXT NOT NULL,
      key           TEXT NOT NULL,
      payload       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      decision_note TEXT,
      created_at    INTEGER NOT NULL,
      decided_at    INTEGER,
      result        TEXT,
      notified      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_key ON approvals(task_id, key);

    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  // Columns added after the first release: CREATE TABLE IF NOT EXISTS leaves an older ledger without them.
  const taskColumns = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const col of ["handed_off_at", "not_before"]) {
    if (!taskColumns.includes(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} INTEGER`);
  }
  return db;
}

export function getMeta(db: Database, k: string): string | null {
  return (db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | null)?.v ?? null;
}

export function setMeta(db: Database, k: string, v: string): void {
  db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

export function setTaskStatus(db: Database, id: string, status: TaskStatus, extra: Partial<Pick<TaskRow, "outcome" | "summary" | "next_prompt" | "session_id" | "handed_off_at" | "not_before">> = {}): void {
  const sets = ["status = ?", "updated_at = ?"];
  const args: unknown[] = [status, Date.now()];
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    args.push(v);
  }
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...(args as never[]), id);
}

export function getTask(db: Database, id: string): TaskRow | null {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null;
}
