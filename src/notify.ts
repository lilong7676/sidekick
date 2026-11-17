// Telling me something needs me: a macOS notification, and optionally a Slack DM to myself so it
// reaches the phone (plan §8). Only three things are worth it: a pending approval, a task that
// needs me, a task that failed.

import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import type { ApprovalRow, EventRow, TaskRow } from "./db.ts";
import { cachedMe, dmSelf, permalink } from "./slack.ts";
import { clip, log } from "./util.ts";

/** A local banner only (used when Slack itself is the problem). */
export function notifyLocal(title: string, message: string): void {
  macos(title, message);
}

function macos(title: string, message: string): void {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    execFileSync("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}" sound name "Ping"`]);
  } catch {
    // No GUI session (e.g. over ssh): not worth failing for.
  }
}

function linkOf(db: Database, task: TaskRow): string {
  if (task.source !== "slack" || !task.event_id) return "";
  const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(task.event_id) as EventRow | null;
  const me = cachedMe(db);
  return me && ev?.channel && ev.ts ? permalink(me, ev.channel, ev.ts, ev.thread_ts) : "";
}

/** Full mode sent a reply on my behalf: always tell me what was said, where. */
export async function notifyAutoSent(db: Database, a: ApprovalRow, text: string, channels: { macos: boolean; slack: boolean }): Promise<void> {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(a.task_id) as TaskRow | null;
  if (channels.macos) macos("sidekick 已自动回复", task?.title ?? a.task_id);
  if (!channels.slack) return;
  try {
    await dmSelf(db, `全托管已代你回复 · ${task?.title ?? a.task_id}\n> ${clip(text, 600).replace(/\n/g, "\n> ")}\n${task ? linkOf(db, task) : ""}`);
  } catch (e) {
    log(`notify: slack self DM failed: ${String(e).slice(0, 200)}`);
  }
}

/**
 * One pending approval, as the Slack DM to myself shows it: it has to be actionable from the phone.
 * A reply's draft already sits in the conversation's composer, so the way to answer is to go there
 * and send it (or delete it): sidekick follows (approvals.ts reconcileDrafts).
 */
export function approvalLine(a: Pick<ApprovalRow, "kind" | "payload">, title: string, link: string): string {
  const p = JSON.parse(a.payload) as Record<string, any>;
  if (a.kind !== "outbound") {
    return `要你批准一个操作 · ${title}\n${p.tool_name} ${clip(JSON.stringify(p.input), 60)}\n在菜单栏的 sidekick 里批准或拒绝。${link ? `\n${link}` : ""}`;
  }
  const how = p.draftId
    ? "草稿已经在这个对话的输入框里：点链接过去，改好直接发出；不回就删掉草稿。"
    : "草稿没建成，到菜单栏的 sidekick 里批准后发出。";
  return `待你回复 · ${title}\n> ${clip(p.text, 120).replace(/\n/g, "\n> ")}\n${how}${link ? `\n${link}` : ""}`;
}

export async function notifyPending(db: Database, channels: { macos: boolean; slack: boolean }): Promise<void> {
  const lines: string[] = [];

  const approvals = db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND notified = 0").all() as ApprovalRow[];
  for (const a of approvals) {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(a.task_id) as TaskRow | null;
    lines.push(approvalLine(a, task?.title ?? a.task_id, task ? linkOf(db, task) : ""));
    db.prepare("UPDATE approvals SET notified = 1 WHERE id = ?").run(a.id);
  }

  const tasks = db.prepare("SELECT * FROM tasks WHERE status IN ('needs_me','failed') AND (notified_status IS NULL OR notified_status != status)").all() as TaskRow[];
  for (const t of tasks) {
    const link = linkOf(db, t);
    lines.push(`${t.status === "failed" ? "处理失败" : "要你自己看"} · ${t.title}${t.summary ? `\n${clip(t.summary, 160)}` : ""}${link ? `\n${link}` : ""}`);
    db.prepare("UPDATE tasks SET notified_status = status WHERE id = ?").run(t.id);
  }

  if (lines.length === 0) return;
  if (channels.macos) macos("sidekick", lines.length === 1 ? lines[0].split("\n")[0] : `${lines.length} 件事要你看`);
  if (channels.slack) {
    try {
      await dmSelf(db, `sidekick\n\n${lines.join("\n\n")}`);
    } catch (e) {
      log(`notify: slack self DM failed: ${String(e).slice(0, 200)}`);
    }
  }
}
