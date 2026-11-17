// Read models shared by the CLI and the HTTP API, plus the task actions both can trigger.

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "./config.ts";
import { getTask, OPEN_STATUSES, setTaskStatus, type ApprovalRow, type EventRow, type RunRow, type TaskRow } from "./db.ts";
import { launchSpec } from "./handle.ts";
import { CLAUDE, clip, log, newId, runProcess } from "./util.ts";
import { shellQuote, takeoverArgs, writeMcpConfig } from "./runner.ts";
import { effectiveMode, loadSettings, runSettings } from "./settings.ts";
import { cachedMe, deleteDraft, permalink } from "./slack.ts";

export type TaskFilter = "attention" | "active" | "closed" | "all";

const FILTERS: Record<TaskFilter, string[] | null> = {
  attention: ["needs_approval", "needs_me", "failed"],
  active: ["queued", "running", "paused"],
  closed: ["done", "closed", "cancelled"],
  all: null,
};

export interface TaskSummary extends TaskRow {
  cost_usd: number;
  pending_approvals: number;
  link: string | null;
}

function linkFor(db: Database, task: TaskRow): string | null {
  if (task.source !== "slack" || !task.event_id) return null;
  const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(task.event_id) as EventRow | null;
  if (!ev?.channel || !ev.ts) return null;
  const me = cachedMe(db);
  return me ? permalink(me, ev.channel, ev.ts, ev.thread_ts) : null;
}

export function listTasks(db: Database, filter: TaskFilter = "all", limit = 100): TaskSummary[] {
  const statuses = FILTERS[filter];
  const where = statuses ? `WHERE t.status IN (${statuses.map(() => "?").join(",")})` : "";
  const rows = db.prepare(`
    SELECT t.*,
      COALESCE((SELECT SUM(cost_usd) FROM runs r WHERE r.task_id = t.id), 0) AS cost_usd,
      (SELECT COUNT(*) FROM approvals a WHERE a.task_id = t.id AND a.status = 'pending') AS pending_approvals,
      (SELECT COUNT(*) FROM events e WHERE e.task_id = t.id) AS messages
    FROM tasks t ${where} ORDER BY t.updated_at DESC LIMIT ?`).all(...(statuses ?? []), limit) as Array<TaskRow & { cost_usd: number; pending_approvals: number; messages: number }>;
  return rows.map((t) => ({ ...t, link: linkFor(db, t) }));
}

export interface ApprovalView extends Omit<ApprovalRow, "payload"> { payload: Record<string, any>; task_title: string | null }

export function approvalView(db: Database, a: ApprovalRow): ApprovalView {
  const t = getTask(db, a.task_id);
  return { ...a, payload: JSON.parse(a.payload), task_title: t?.title ?? null };
}

export function pendingApprovals(db: Database): ApprovalView[] {
  return (db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").all() as ApprovalRow[]).map((a) => approvalView(db, a));
}

export function taskDetail(db: Database, id: string) {
  const task = getTask(db, id);
  if (!task) return null;
  return {
    task: { ...task, link: linkFor(db, task) },
    events: db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id").all(id) as EventRow[],
    runs: db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at").all(id) as RunRow[],
    approvals: (db.prepare("SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at").all(id) as ApprovalRow[]).map((a) => approvalView(db, a)),
  };
}

export function stateSummary(db: Database) {
  const counts = Object.fromEntries((db.prepare("SELECT status, COUNT(*) n FROM tasks GROUP BY status").all() as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]));
  const pending = (db.prepare("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'").get() as { n: number }).n;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cost = (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) c FROM runs WHERE started_at >= ?").get(today.getTime()) as { c: number }).c;
  const mode = effectiveMode(loadSettings());
  return { counts, pendingApprovals: pending, costToday: cost, attention: pending + (counts.needs_me ?? 0) + (counts.failed ?? 0), mode: mode.mode, modeUntil: mode.scheduled ? mode.until : null };
}

/** Cheap fingerprint of everything the UI shows; the SSE stream emits when it changes. */
export function fingerprint(db: Database): string {
  const r = db.prepare(`SELECT
    (SELECT COALESCE(MAX(updated_at), 0) FROM tasks) AS t, (SELECT COUNT(*) FROM tasks) AS tn,
    (SELECT COUNT(*) FROM approvals) AS a, (SELECT COALESCE(MAX(decided_at), 0) FROM approvals) AS ad,
    (SELECT COUNT(*) FROM runs) AS r, (SELECT COALESCE(MAX(ended_at), 0) FROM runs) AS re,
    (SELECT COUNT(*) FROM events) AS e`).get() as Record<string, number>;
  return `${Object.values(r).join(":")}:${effectiveMode(loadSettings()).mode}`;
}

// ---- run logs, simplified for display ----------------------------------------------------------------

export type LogItem =
  | { kind: "init"; model?: string; session?: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: string; id?: string }
  | { kind: "tool_result"; text: string; error: boolean; id?: string }
  | { kind: "result"; text: string; cost?: number; turns?: number; error: boolean; denials: number }
  | { kind: "stderr"; text: string };

export function parseLogLine(line: string): LogItem[] {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return [];
  }
  if (ev.type === "system" && ev.subtype === "init") return [{ kind: "init", model: ev.model, session: ev.session_id }];
  if (ev.type === "sidekick_stderr") return [{ kind: "stderr", text: String(ev.text).slice(-2000) }];
  if (ev.type === "result") {
    return [{ kind: "result", text: String(ev.result ?? ""), cost: ev.total_cost_usd, turns: ev.num_turns, error: Boolean(ev.is_error), denials: (ev.permission_denials ?? []).length }];
  }
  const content = ev.message?.content;
  if (!Array.isArray(content)) return [];
  const out: LogItem[] = [];
  for (const c of content) {
    if (ev.type === "assistant" && c.type === "text" && c.text?.trim()) out.push({ kind: "text", text: c.text });
    else if (ev.type === "assistant" && c.type === "tool_use") out.push({ kind: "tool", name: c.name, id: c.id, input: clip(typeof c.input?.command === "string" ? c.input.command : JSON.stringify(c.input), 2000) });
    else if (ev.type === "user" && c.type === "tool_result") {
      const text = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? "").join("\n") : String(c.content ?? "");
      out.push({ kind: "tool_result", id: c.tool_use_id, text: clip(text, 3000), error: Boolean(c.is_error) });
    }
  }
  return out;
}

export function readRunLog(path: string | null): LogItem[] {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap(parseLogLine);
}

// ---- actions the CLI and the UI share ----------------------------------------------------------------

export function addManualTask(db: Database, text: string): string {
  const id = newId("t");
  const now = Date.now();
  db.prepare("INSERT INTO tasks (id, source, kind, title, status, next_prompt, created_at, updated_at) VALUES (?, 'manual', 'manual', ?, 'queued', ?, ?, ?)")
    .run(id, clip(text, 80).replace(/\s+/g, " "), text, now, now);
  return id;
}

export function handback(db: Database, id: string, message?: string): void {
  const t = getTask(db, id);
  if (!t) throw new Error("没有这个任务");
  const msg = message?.trim() || "使用者在终端里接管过这个会话，刚交还给你。看一下最新进展，继续处理。";
  db.prepare("UPDATE tasks SET next_prompt = COALESCE(next_prompt || char(10), '') || ? WHERE id = ?").run(msg, id);
  setTaskStatus(db, id, "queued");
}

/** Stop the claude processes of a task's live runs. The run's own exit handler records the end. */
function killLiveRuns(db: Database, id: string): number {
  const live = db.prepare("SELECT id, pid FROM runs WHERE task_id = ? AND ended_at IS NULL").all(id) as Array<{ id: string; pid: number | null }>;
  for (const r of live) {
    db.prepare("UPDATE runs SET error = 'cancelled' WHERE id = ?").run(r.id);
    if (!r.pid) continue;
    try {
      process.kill(r.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  return live.length;
}

type DiscardDraft = (draftId: string) => void | Promise<void>;

/**
 * Cancel a task; a run in progress is stopped right away, not left to finish. Its pending approval
 * cards close with it and their Slack drafts go: a reply for a task I called off must not be sent,
 * nor counted as waiting for me.
 */
export async function cancel(db: Database, id: string, discardDraft: DiscardDraft = deleteDraft): Promise<{ stopped: number; closed: number }> {
  if (!getTask(db, id)) throw new Error("没有这个任务");
  // Status first, so the run's exit handler sees "cancelled" and does not requeue or retry it.
  setTaskStatus(db, id, "cancelled");
  const stopped = killLiveRuns(db, id);
  const pending = db.prepare("SELECT kind, payload FROM approvals WHERE task_id = ? AND status = 'pending'").all(id) as Array<{ kind: string; payload: string }>;
  // Closed before the drafts go, so nothing can approve them in between; the result keeps the
  // decision loop (processDecisions) from acting on them.
  db.prepare("UPDATE approvals SET status = 'denied', decided_at = ?, result = 'discarded: task cancelled' WHERE task_id = ? AND status = 'pending'").run(Date.now(), id);
  for (const a of pending) {
    const draftId = a.kind === "outbound" ? (JSON.parse(a.payload) as { draftId?: string }).draftId : undefined;
    if (!draftId) continue;
    try {
      await discardDraft(draftId);
    } catch (e) {
      log(`cancel: discarding draft ${draftId} of ${id} failed: ${clip(String(e), 200)}`);
    }
  }
  return { stopped, closed: pending.length };
}

/**
 * Delete a task's records: the task, its runs and their log files, its approval cards, and any of
 * its replies still sitting as drafts in Slack. Its Slack events stay (marked "deleted") because
 * they are what stops the same unread message from being picked up again.
 */
export async function deleteTask(db: Database, id: string, discardDraft: DiscardDraft = deleteDraft): Promise<void> {
  await cancel(db, id, discardDraft);
  const runs = db.prepare("SELECT id, log_path FROM runs WHERE task_id = ?").all(id) as Array<{ id: string; log_path: string | null }>;
  for (const r of runs) {
    for (const f of [r.log_path, ...(r.log_path ? [".mcp.json", ".policy.json"].map((ext) => r.log_path!.replace(/\.jsonl$/, ext)) : [])]) {
      if (f && existsSync(f)) rmSync(f);
    }
  }
  db.transaction(() => {
    db.prepare("DELETE FROM approvals WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM runs WHERE task_id = ?").run(id);
    db.prepare("UPDATE events SET task_id = 'deleted' WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  })();
}

/** Delete every finished task (done / closed / cancelled). */
export async function clearFinished(db: Database, discardDraft?: DiscardDraft): Promise<number> {
  const ids = (db.prepare("SELECT id FROM tasks WHERE status IN ('done','closed','cancelled')").all() as Array<{ id: string }>).map((r) => r.id);
  for (const id of ids) await deleteTask(db, id, discardDraft);
  return ids.length;
}

/** Who has been reaching me, and in which channels, so the panel can offer them for skipping. */
export function slackPeople(db: Database, days = 60): { people: Array<{ id: string; name: string; messages: number }>; channels: Array<{ id: string; name: string; messages: number }> } {
  const since = Date.now() - days * 86_400_000;
  const people = db.prepare(`
    SELECT user_id AS id, MAX(user_name) AS name, COUNT(*) AS messages FROM events
    WHERE source = 'slack' AND user_id IS NOT NULL AND received_at >= ?
    GROUP BY user_id ORDER BY messages DESC LIMIT 50`).all(since) as Array<{ id: string; name: string | null; messages: number }>;
  const channels = db.prepare(`
    SELECT channel AS id, MAX(channel_name) AS name, COUNT(*) AS messages FROM events
    WHERE source = 'slack' AND kind != 'dm' AND (channel LIKE 'C%' OR channel LIKE 'G%') AND received_at >= ?
    GROUP BY channel ORDER BY messages DESC LIMIT 50`).all(since) as Array<{ id: string; name: string | null; messages: number }>;
  return {
    people: people.map((p) => ({ ...p, name: p.name ?? p.id })),
    channels: channels.map((c) => ({ ...c, name: c.name ?? c.id })),
  };
}

/**
 * Work on a task now: one held until working hours, or one a rule skipped (intake.ts). Anything else is
 * not waiting on a rule, so there is nothing to undo.
 */
export function processNow(db: Database, id: string): void {
  const t = getTask(db, id);
  if (!t) throw new Error("没有这个任务");
  if (t.status === "queued" && t.not_before) {
    db.prepare("UPDATE tasks SET not_before = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
  } else if (t.status === "closed" && t.outcome === "skipped") {
    setTaskStatus(db, id, "queued", { outcome: null, summary: null, not_before: null });
  } else {
    throw new Error("这个任务没有在等规则放行");
  }
}

/** What 「在 Claude Code 里继续」 opened, or the command to run by hand where it cannot open anything. */
export interface Continued { where: "terminal" | "desktop"; cwd: string; session: string; name: string; command: string }

/** `claude --desktop` needs a terminal to talk to; script(1) lends it one. Its output keeps the colours. */
async function openInDesktop(cwd: string, session: string): Promise<void> {
  const r = await runProcess(["/usr/bin/script", "-q", "/dev/null", CLAUDE, "--desktop", "--resume", session], { cwd, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`没能在 Claude 桌面 app 打开：${clip((r.stdout + r.stderr).replace(/\x1b\[[0-9;?]*[A-Za-z]|[\x00-\x08\r]/g, "").trim(), 200)}`);
}

/**
 * Open a task's conversation in my own Claude Code, to go on with it myself: my own permissions, no
 * sidekick tools, nothing to hand back (that is takeover). In Terminal it is a fork, so my session and
 * sidekick's never write the same file. The desktop app cannot fork, so there it is sidekick's own
 * session, handed over: if this task runs again, sidekick starts a new session (handle.ts sessionFor).
 */
export async function continueInClaude(
  profile: Profile,
  db: Database,
  id: string,
  where: "terminal" | "desktop",
  open: (cwd: string, session: string) => Promise<void> = openInDesktop,
): Promise<Continued> {
  const t = getTask(db, id);
  if (!t?.session_id) throw new Error("这个任务还没有会话");
  if (t.status === "running") throw new Error("任务正在跑，等这一轮结束再继续");
  const name = `sidekick：${t.title.replace(/\s+/g, " ")}`.slice(0, 60);
  const resume = [CLAUDE, "--resume", t.session_id];
  if (where === "terminal") {
    return { where, cwd: profile.root, session: t.session_id, name, command: [...resume, "--fork-session", "-n", name].map(shellQuote).join(" ") };
  }
  await open(profile.root, t.session_id);
  db.prepare("UPDATE tasks SET handed_off_at = ? WHERE id = ?").run(Date.now(), t.id);
  return { where, cwd: profile.root, session: t.session_id, name, command: [...resume, "--desktop"].map(shellQuote).join(" ") };
}

/** Pause the task and return the shell command that opens its session in a terminal. */
/**
 * Pause the task for me to drive its session in a terminal. `args` go to the menu bar app, which
 * quotes each one itself (WebPanel.swift Terminal.takeover); `command` is for showing and the CLI.
 */
export function takeover(profile: Profile, db: Database, id: string): { cwd: string; args: string[]; command: string } {
  const t = getTask(db, id);
  if (!t?.session_id) throw new Error("这个任务还没有会话");
  if (t.status === "running") throw new Error("任务正在跑，等这一轮结束，或者先取消");
  setTaskStatus(db, t.id, "paused");
  const runId = newId("r");
  const spec = launchSpec(profile, t, runId, join(profile.stateDir, "sidekick.db"), runSettings());
  const mcp = writeMcpConfig(join(profile.stateDir, "runs"), runId, spec.sidekickMcp!);
  const args = takeoverArgs(spec, t.session_id, mcp);
  return { cwd: profile.root, args, command: [CLAUDE, ...args].map(shellQuote).join(" ") };
}

export { OPEN_STATUSES };
