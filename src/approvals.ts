// Deciding approvals (only from my CLI / app) and acting on decisions (only in the daemon).

import type { Database } from "bun:sqlite";
import { getTask, setTaskStatus, type ApprovalRow } from "./db.ts";
import { t } from "./i18n.ts";
import { deleteDraft, liveDraftIds, myMessageSince, sendDraft, sendMessage } from "./slack.ts";
import { log } from "./util.ts";

export function decide(db: Database, id: string, decision: "approved" | "denied", note?: string, editedText?: string): ApprovalRow {
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | null;
  if (!row) throw new Error(`no approval ${id}`);
  if (row.status !== "pending") throw new Error(`approval ${id} is already ${row.status}`);
  let payload = row.payload;
  if (editedText !== undefined) {
    if (row.kind !== "outbound") throw new Error("only outbound approvals can be edited");
    payload = JSON.stringify({ ...JSON.parse(row.payload), editedText });
  }
  db.prepare("UPDATE approvals SET status = ?, decision_note = ?, decided_at = ?, payload = ? WHERE id = ?")
    .run(decision, note ?? null, Date.now(), payload, id);
  return db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow;
}

type MaybeAsync<T> = T | Promise<T>;
type Sender = {
  sendDraft: (draftId: string) => MaybeAsync<void>;
  deleteDraft: (draftId: string) => MaybeAsync<void>;
  sendMessage: (channel: string, threadTs: string | null, text: string, blocks?: unknown[]) => MaybeAsync<void>;
  /** Drafts Slack still holds unsent; null when it cannot tell. */
  liveDrafts: () => MaybeAsync<Set<string> | null>;
  /** The first message I posted there after `sinceSec`, or null. */
  mineSince: (channel: string, threadTs: string | null, sinceSec: number) => MaybeAsync<string | null>;
};
const realSender = (db: Database): Sender => ({
  sendDraft,
  deleteDraft,
  sendMessage,
  liveDrafts: liveDraftIds,
  mineSince: (channel, threadTs, sinceSec) => myMessageSince(db, channel, threadTs, sinceSec),
});

/**
 * The line above a reply sidekick sends for me, so whoever reads it knows an assistant drafted it, and
 * whether I looked at it first. English whatever the reply's language (decided 2026-11-17).
 */
export const SIGN_APPROVED = ":speaking_head_in_silhouette: Drafted by sidekick · approved by me";
export const SIGN_AUTO = ":speaking_head_in_silhouette: Auto-reply by sidekick · not yet reviewed by me";
const SECTION_MAX = 3000; // Slack's limit for one section's text

/** A signed reply: the signature as a context block (small grey text), then the text in sections. */
export function replyBlocks(text: string, auto: boolean): unknown[] {
  const sections: string[] = [];
  let rest = text;
  while (rest.length > SECTION_MAX) {
    const cut = rest.lastIndexOf("\n", SECTION_MAX);
    const at = cut > SECTION_MAX / 2 ? cut : SECTION_MAX; // a line break if there is one late enough
    sections.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  sections.push(rest);
  return [
    { type: "context", elements: [{ type: "mrkdwn", text: auto ? SIGN_AUTO : SIGN_APPROVED }] },
    ...sections.map((s) => ({ type: "section", text: { type: "mrkdwn", text: s } })),
  ];
}

/** Results that say a reply card was settled in Slack, by me, rather than in sidekick. */
export const SENT_IN_SLACK = "sent in Slack";
export const DELETED_IN_SLACK = "draft deleted in Slack";

/** Marks replies the daemon approved on its own in full mode, so they can be reported back to me. */
export const AUTO_NOTE = "全托管自动发送";
/** decision_note of a reply a profile.yaml autoReply rule let out without me (mcp.ts). Compared, never translated. */
export const RULE_NOTE = "按规则自动发送";
const unseen = (note: string | null) => note === AUTO_NOTE || note === RULE_NOTE;

/**
 * Act on every decided-but-unhandled approval. Runs in the daemon loop.
 * Tool approvals: the run that asked is gone, so requeue the task with the answer.
 * Outbound approvals: execute the action (approved) or discard the draft (denied).
 */
export async function processDecisions(
  db: Database,
  isRunning: (taskId: string) => boolean,
  sender: Sender = realSender(db),
  onSent?: (approval: ApprovalRow, text: string) => void | Promise<void>,
  opts: { sign?: boolean } = {},
): Promise<number> {
  const rows = db.prepare("SELECT * FROM approvals WHERE status IN ('approved','denied') AND result IS NULL ORDER BY decided_at").all() as ApprovalRow[];
  let n = 0;
  let live: Set<string> | null | undefined; // listed once per pass, and only if a draft needs checking
  const draftGone = async (draftId: string): Promise<boolean> => {
    try {
      if (live === undefined) live = await sender.liveDrafts();
    } catch (e) {
      live = null;
      log(`approvals: listing Slack drafts failed: ${String(e).slice(0, 200)}`);
    }
    return live !== null && !live.has(draftId);
  };
  for (const a of rows) {
    if (isRunning(a.task_id)) continue; // let the live run see it, or wait until it ends
    const task = getTask(db, a.task_id);
    const payload = JSON.parse(a.payload) as Record<string, any>;
    if (a.kind === "tool") {
      const what = `${payload.tool_name} ${JSON.stringify(payload.input).slice(0, 300)}`;
      const next = a.status === "approved"
        ? `你之前请求的调用已获使用者批准，可以执行了：${what}`
        : `你之前请求的调用被使用者拒绝${a.decision_note ? `，理由：${a.decision_note}` : ""}：${what}。不要再请求它，按现有条件把任务收尾。`;
      appendAndQueue(db, a.task_id, next);
      db.prepare("UPDATE approvals SET result = 'requeued' WHERE id = ?").run(a.id);
    } else if (payload.kind === "slack.reply") {
      if (a.status === "approved") {
        try {
          const edited = typeof payload.editedText === "string";
          // The draft has left Slack: if I said something there since, I sent it myself and it must
          // not go out twice; if not, I deleted it, yet approved here later, so send the text plainly.
          const gone = payload.draftId ? await draftGone(payload.draftId) : false;
          if (gone) {
            const mine = await sender.mineSince(payload.channel, payload.threadTs ?? null, a.created_at / 1000);
            if (mine !== null) {
              settleFromSlack(db, a, "approved", mine);
              n += 1;
              continue;
            }
          }
          const body: string = edited ? payload.editedText : payload.text;
          if (opts.sign) {
            // A draft is plain text and cannot carry the signature: it goes, and the reply is posted signed.
            if (payload.draftId && !gone) await sender.deleteDraft(payload.draftId);
            await sender.sendMessage(payload.channel, payload.threadTs ?? null, body, replyBlocks(body, unseen(a.decision_note)));
          } else if (payload.draftId && !gone && !edited) await sender.sendDraft(payload.draftId);
          else {
            if (payload.draftId && !gone) await sender.deleteDraft(payload.draftId);
            await sender.sendMessage(payload.channel, payload.threadTs ?? null, body);
          }
          db.prepare("UPDATE approvals SET status = 'executed', result = 'executed: sent' WHERE id = ?").run(a.id);
          if (task && !hasPending(db, a.task_id)) setTaskStatus(db, a.task_id, "done", { outcome: "replied" });
          log(`approvals: ${a.id} sent for ${a.task_id}${a.decision_note === AUTO_NOTE ? " (full mode)" : a.decision_note === RULE_NOTE ? " (by a rule)" : ""}`);
          try {
            await onSent?.(a, edited ? payload.editedText : payload.text);
          } catch (e) {
            log(`approvals: after-send hook failed: ${String(e).slice(0, 200)}`);
          }
        } catch (e) {
          db.prepare("UPDATE approvals SET status = 'failed', result = ? WHERE id = ?").run(`failed: ${String(e).slice(0, 300)}`, a.id);
          if (task) setTaskStatus(db, a.task_id, "needs_me", { summary: t(`回复发送失败：${String(e).slice(0, 200)}`, `The reply could not be sent: ${String(e).slice(0, 200)}`) });
          log(`approvals: ${a.id} send failed: ${String(e).slice(0, 200)}`);
        }
      } else {
        if (payload.draftId) {
          try {
            await sender.deleteDraft(payload.draftId);
          } catch (e) {
            log(`approvals: discarding draft of ${a.id} failed: ${String(e).slice(0, 200)}`);
          }
        }
        db.prepare("UPDATE approvals SET result = 'discarded' WHERE id = ?").run(a.id);
        if (a.decision_note) appendAndQueue(db, a.task_id, `使用者没有采用你提议的回复，意见：${a.decision_note}。按这个意见重新处理，需要的话再提一次。`);
        else if (task && !hasPending(db, a.task_id)) setTaskStatus(db, a.task_id, "closed", { outcome: "reply_rejected" });
      }
    } else {
      db.prepare("UPDATE approvals SET status = 'failed', result = 'unknown outbound kind' WHERE id = ?").run(a.id);
    }
    n += 1;
  }
  return n;
}

/**
 * A reply card and its Slack draft are two ways to answer the same message, and whichever I use
 * first wins. For each pending reply whose draft has left Slack's list: a message of mine there since
 * means I sent it from Slack (edited or not), nothing means I deleted the draft, so no reply. Tasks
 * with a live run are left for the next pass. Runs after each collect, and when I post on the socket.
 */
export async function reconcileDrafts(db: Database, isRunning: (taskId: string) => boolean, sender: Sender = realSender(db)): Promise<number> {
  const cards = (db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND kind = 'outbound' ORDER BY created_at").all() as ApprovalRow[])
    .map((a) => ({ a, p: JSON.parse(a.payload) as Record<string, any> }))
    .filter(({ a, p }) => p.kind === "slack.reply" && p.draftId && !isRunning(a.task_id));
  if (cards.length === 0) return 0;
  const live = await sender.liveDrafts();
  if (!live) return 0;
  let n = 0;
  for (const { a, p } of cards) {
    if (live.has(p.draftId)) continue;
    const mine = await sender.mineSince(p.channel, p.threadTs ?? null, a.created_at / 1000);
    if (settleFromSlack(db, a, "pending", mine)) n += 1;
  }
  return n;
}

/** Close a reply card from what I did in Slack: sent (`sent` is what went out) or deleted (`sent` null). */
function settleFromSlack(db: Database, a: ApprovalRow, from: "pending" | "approved", sent: string | null): boolean {
  const now = Date.now();
  const changed = sent !== null
    ? db.prepare("UPDATE approvals SET status = 'executed', decided_at = COALESCE(decided_at, ?), result = ?, payload = ? WHERE id = ? AND status = ?")
        .run(now, SENT_IN_SLACK, JSON.stringify({ ...JSON.parse(a.payload), sentText: sent }), a.id, from).changes
    : db.prepare("UPDATE approvals SET status = 'denied', decided_at = ?, result = ? WHERE id = ? AND status = ?")
        .run(now, DELETED_IN_SLACK, a.id, from).changes;
  if (!changed) return false; // decided in sidekick meanwhile
  if (getTask(db, a.task_id) && !hasPending(db, a.task_id)) {
    setTaskStatus(db, a.task_id, sent !== null ? "done" : "closed", { outcome: sent !== null ? "replied" : "reply_rejected" });
  }
  log(`approvals: ${a.id} ${sent !== null ? "was sent from Slack" : "had its draft deleted in Slack"} (${a.task_id})`);
  return true;
}

function hasPending(db: Database, taskId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM approvals WHERE task_id = ? AND status = 'pending'").get(taskId));
}

function appendAndQueue(db: Database, taskId: string, text: string): void {
  db.prepare("UPDATE tasks SET next_prompt = COALESCE(next_prompt || char(10), '') || ?, updated_at = ? WHERE id = ?").run(text, Date.now(), taskId);
  const task = getTask(db, taskId);
  if (task && ["needs_approval", "needs_me", "done", "closed"].includes(task.status)) setTaskStatus(db, taskId, "queued");
}
