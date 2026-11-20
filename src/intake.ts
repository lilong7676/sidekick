// From collected Slack events to tasks.
//
// Collection already keeps only DMs to me and messages that @ me (slack.ts), so every event
// becomes a task: no separate triage stage (decided 2026-11-13). The agent decides whether to
// reply. Nothing is put on the message in Slack while it is handled (no reaction, decided 2026-11-16).

import type { Database } from "bun:sqlite";
import { getTask, setTaskStatus, type EventRow } from "./db.ts";
import { t } from "./i18n.ts";
import { loadSettings } from "./settings.ts";
import { clip, log, newId } from "./util.ts";

/** How long, in hours, a conversation keeps its task (null: no limit). From settings.ts. */
export interface MergeWindows { thread: number | null; dm: number | null }

/** Local hours [start, end) on weekdays, and on weekends too when `weekends`. From settings.ts. */
export interface WorkHours { start: number; end: number; weekends: boolean }

/** Everything intake decides by, from settings.ts: which task a message joins, and what not to work on. */
export interface IntakeRules extends MergeWindows {
  skipUsers: string[];
  skipChannels: string[];
  workHours: WorkHours | null;
}

const rulesFromSettings = (): IntakeRules => {
  const s = loadSettings();
  return { thread: s.threadMergeHours, dm: s.dmMergeHours, skipUsers: s.skipUsers, skipChannels: s.skipChannels, workHours: s.workHours };
};

/** When work may start: null now, inside working hours; otherwise the next start, local time. */
export function nextWorkStart(now: Date, wh: WorkHours | null): number | null {
  if (!wh) return null;
  const workday = (d: Date) => wh.weekends || (d.getDay() !== 0 && d.getDay() !== 6);
  if (workday(now) && now.getHours() >= wh.start && now.getHours() < wh.end) return null;
  const next = new Date(now);
  next.setHours(wh.start, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  while (!workday(next)) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/**
 * Why a new message is not worked on, if a rule says so. Shown as the task's summary, in the language
 * of the moment it is written; code goes by the outcome "skipped", never by this text.
 */
function skipReason(ev: EventRow, rules: IntakeRules): string | null {
  if (ev.user_id && rules.skipUsers.includes(ev.user_id)) {
    const who = ev.user_name ?? ev.user_id;
    return t(`按规则跳过：不处理 ${who} 的消息。`, `Skipped by a rule: skip messages from ${who}.`);
  }
  if (ev.channel && rules.skipChannels.includes(ev.channel)) {
    const where = `#${ev.channel_name ?? ev.channel}`;
    return t(`按规则跳过：不处理 ${where} 里的 @。`, `Skipped by a rule: skip @-mentions in ${where}.`);
  }
  if (isClosing(ev.text)) {
    return t("按规则跳过：只是一句收尾的话（好的、谢谢、表情），不用回。", "Skipped by a rule: only a closing word (ok, thanks, an emoji), nothing to answer.");
  }
  return null;
}

/**
 * A conversation's run waits this long after its latest message, so a burst ("怎么回事~", "哈哈",
 * "你慢慢搞" within a minute) is one run, not three. Each run resumes the conversation's session and
 * re-reads all of it, so every extra one cost more than the last ($0.43 → $1.89, 2026-11-18).
 */
export const QUIET_MS = 60_000;

/** Not before the conversation has been quiet for QUIET_MS, nor before working hours (`hold`). */
function quietUntil(ev: EventRow, hold: number | null, now = Date.now()): number | null {
  const quiet = Number(ev.ts) * 1000 + QUIET_MS;
  const at = Math.max(hold ?? 0, quiet > now ? quiet : 0);
  return at > 0 ? at : null;
}

/**
 * A message that only closes a conversation: thanks, ok, a laugh, an emoji. Not worked on: in a
 * conversation already handled it is kept with the task, and one it opens is skipped (skipReason). The
 * agent always found no reply was needed, and each such run still cost $0.4–3.8: 3 of the first 60
 * conversations opened with one (2026-11-19). A bare @ is not one: it asks me to look at the thread.
 */
export function isClosing(text: string | null): boolean {
  const rest = (text ?? "").replace(/<@[A-Z0-9]+>/g, "");
  if (!rest.trim()) return false; // nothing, or only a mention
  const s = rest
    .replace(/:[a-z0-9_+'-]+:/gi, "")
    .replace(/[\s.,!?~。，！？～…、]+/g, "")
    .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, "")
    .toLowerCase();
  if (!s) return true; // only emoji
  return /^(好|好的|好滴|好嘞|好哒|好了|嗯+|哦+|噢+|ok+|okay|欧克|收到|了解|明白|知道了|谢谢|谢啦|多谢|感谢|辛苦|辛苦了|thx|thanks|thankyou|ty|哈+|h+a+|nice|cool|牛|棒)$/.test(s);
}

/** Still at work: a new message in its conversation always joins. */
const OPEN = ["queued", "running"];
/** Settled, but the conversation may go on: a new message joins within the window and reopens it. */
const SETTLED = ["needs_approval", "needs_me", "done", "closed"];
// cancelled and failed take no new messages: I called it off, or it broke; the next one starts clean.

/**
 * The task a new event continues, if any: the latest task of the same thread (or of the same 1:1 DM,
 * outside threads), when it is still at work, or settled less than the window ago. Joining keeps the
 * conversation in one task and one Claude session: the agent remembers what it looked up and drafted.
 */
export function findJoinableTask(db: Database, ev: EventRow, windows: MergeWindows): string | null {
  type Latest = { id: string; status: string; updated_at: number } | null;
  let latest: Latest = null;
  if (ev.thread_ts) {
    latest = db.prepare(`
      SELECT t.id, t.status, t.updated_at FROM tasks t JOIN events e ON e.task_id = t.id
      WHERE e.channel = ? AND (e.thread_ts = ? OR e.ts = ?)
      ORDER BY t.updated_at DESC LIMIT 1`).get(ev.channel, ev.thread_ts, ev.thread_ts) as Latest;
  } else if (ev.kind === "dm") {
    latest = db.prepare(`
      SELECT t.id, t.status, t.updated_at FROM tasks t JOIN events e ON e.task_id = t.id
      WHERE e.channel = ? AND e.thread_ts IS NULL
      ORDER BY t.updated_at DESC LIMIT 1`).get(ev.channel) as Latest;
  }
  if (!latest) return null;
  if (OPEN.includes(latest.status)) return latest.id;
  if (!SETTLED.includes(latest.status)) return null;
  const hours = ev.thread_ts ? windows.thread : windows.dm;
  if (hours === null) return latest.id;
  return Number(ev.ts) * 1000 - latest.updated_at <= hours * 3_600_000 ? latest.id : null;
}

/** Turn every new Slack event into a task, or a follow-up on its conversation's task. Returns tasks created. */
export function intakeSlack(db: Database, rules: IntakeRules = rulesFromSettings(), now = new Date()): number {
  const fresh = db.prepare("SELECT * FROM events WHERE source = 'slack' AND task_id IS NULL ORDER BY ts").all() as EventRow[];
  const hold = nextWorkStart(now, rules.workHours);
  let created = 0;
  for (const ev of fresh) {
    const join = findJoinableTask(db, ev, rules);
    if (join) {
      followUp(db, join, ev, hold);
      continue;
    }
    const id = newId("t");
    const at = now.getTime();
    const skip = skipReason(ev, rules);
    // Skipped: closed at once, with the reason, so I can still see it and run it anyway from the panel.
    db.prepare(`INSERT INTO tasks (id, source, kind, title, status, event_id, created_at, updated_at, outcome, summary, not_before)
                VALUES (?, 'slack', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ev.kind, `${ev.user_name ?? "?"}${t("：", ": ")}${clip(ev.text, 60).replace(/\s+/g, " ")}`, skip ? "closed" : "queued", ev.id, at, at,
        skip ? "skipped" : null, skip, skip ? null : quietUntil(ev, hold, at));
    db.prepare("UPDATE events SET task_id = ? WHERE id = ?").run(id, ev.id);
    created += 1;
  }
  if (fresh.length) log(`intake: ${fresh.length} event(s) → ${created} new task(s)`);
  return created;
}

/**
 * Add a new message to its conversation's task. A task still at work picks it up when its run ends;
 * a settled one goes back in the queue, and resumes its session with the message.
 */
function followUp(db: Database, taskId: string, ev: EventRow, hold: number | null): void {
  const task = getTask(db, taskId)!;
  if (!OPEN.includes(task.status) && isClosing(ev.text)) {
    db.prepare("UPDATE events SET task_id = ? WHERE id = ?").run(taskId, ev.id);
    log(`intake: ${taskId} closing message kept, not worked on`);
    return;
  }
  if (task.status === "queued") {
    // Still waiting for the conversation to go quiet: wait for this message too.
    db.prepare("UPDATE tasks SET not_before = ? WHERE id = ?").run(quietUntil(ev, Math.max(hold ?? 0, task.not_before ?? 0) || null), taskId);
  }
  const lines = [`这个对话里又来了一条新消息（${ev.user_name ?? "?"}，ts ${ev.ts}）：${clip(ev.text, 600)}`];
  if (!OPEN.includes(task.status)) {
    const waiting = db.prepare("SELECT 1 FROM approvals WHERE task_id = ? AND kind = 'outbound' AND status = 'pending'").get(taskId);
    lines.push(waiting
      ? "你上一轮提议的回复还在等使用者审批，没有发出。带上这条新消息重新判断：回复要改，就重新 propose，新的会替换掉旧的；不用改，就不要再提。"
      : "上一轮已经处理完了，这是之后来的新消息。按它判断要不要回，不要重复已经说过的话。");
  }
  db.prepare("UPDATE tasks SET next_prompt = COALESCE(next_prompt || char(10), '') || ?, updated_at = ? WHERE id = ?")
    .run(lines.join("\n"), Date.now(), taskId);
  db.prepare("UPDATE events SET task_id = ? WHERE id = ?").run(taskId, ev.id);
  if (!OPEN.includes(task.status)) {
    // Back to work; and if it comes back needing me, that is news again.
    db.prepare("UPDATE tasks SET notified_status = NULL WHERE id = ?").run(taskId);
    setTaskStatus(db, taskId, "queued", { not_before: quietUntil(ev, hold) }); // after hours, it waits for the morning
  }
}
