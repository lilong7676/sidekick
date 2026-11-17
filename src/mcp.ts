// The sidekick MCP server, spawned by claude for every stage-2 run (stdio). Three tools:
//
//   approve   the --permission-prompt-tool: turns an `ask` rule hit into an approval card and waits
//             a few minutes for me; then denies so the run ends cleanly and resumes later (plan §7)
//   propose   the only way for the agent to get something said or done outside: it becomes a card,
//             and the DAEMON executes it after I approve
//   report    the agent's conclusion for the task
//
// The agent can create cards but never decide them: deciding only happens through `sidekick approve`.

import type { Database } from "bun:sqlite";
import { Database as Sqlite } from "bun:sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ApprovalRow, EventRow, TaskRow } from "./db.ts";
import { AUTO_NOTE } from "./approvals.ts";
import { createDraft, deleteDraft } from "./slack.ts";
import { hash, log, newId, sleep, VERSION } from "./util.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export const PENDING_MESSAGE = "已提交给使用者审批，本轮先停：不要重试这个调用，也不要换别的办法达到同样的效果。审批结果会在下一轮告诉你。";

/** Decide a permission request. Pure apart from the db, so it is testable without MCP. */
export async function decidePermission(
  db: Database, taskId: string, runId: string, toolName: string, input: unknown, waitMs: number, pollMs = 1000,
): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }> {
  const key = hash({ toolName, input });
  const prior = db.prepare("SELECT * FROM approvals WHERE task_id = ? AND key = ? ORDER BY created_at DESC LIMIT 1").get(taskId, key) as ApprovalRow | null;
  if (prior?.status === "approved" || prior?.status === "executed") return { behavior: "allow" };
  if (prior?.status === "pending") return { behavior: "deny", message: PENDING_MESSAGE };
  if (prior?.status === "denied") return { behavior: "deny", message: `使用者拒绝了这个调用${prior.decision_note ? `：${prior.decision_note}` : "。"}不要重试。` };

  const id = newId("a");
  db.prepare("INSERT INTO approvals (id, task_id, run_id, kind, key, payload, created_at) VALUES (?, ?, ?, 'tool', ?, ?, ?)")
    .run(id, taskId, runId, key, JSON.stringify({ tool_name: toolName, input }), Date.now());
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const row = db.prepare("SELECT status, decision_note FROM approvals WHERE id = ?").get(id) as Pick<ApprovalRow, "status" | "decision_note">;
    if (row.status === "approved" || row.status === "denied") {
      // Answered while the run was still waiting: the daemon must not requeue for it later.
      db.prepare("UPDATE approvals SET result = 'inline' WHERE id = ?").run(id);
      return row.status === "approved"
        ? { behavior: "allow" }
        : { behavior: "deny", message: `使用者拒绝了这个调用${row.decision_note ? `：${row.decision_note}` : "。"}不要重试。` };
    }
    await sleep(pollMs);
  }
  return { behavior: "deny", message: PENDING_MESSAGE };
}

/** Where a Slack reply for this task goes: its thread, or the DM root when the DM has no thread. */
export function replyTarget(ev: EventRow): { channel: string; threadTs: string | null } {
  if (ev.thread_ts) return { channel: ev.channel!, threadTs: ev.thread_ts };
  if (ev.kind === "dm") return { channel: ev.channel!, threadTs: null };
  return { channel: ev.channel!, threadTs: ev.ts };
}

/**
 * A reply proposal becomes an approval card. In full mode it is approved on the spot, so it goes out
 * when the run ends without ever showing up as pending; cards already waiting keep waiting for me.
 */
export async function proposeSlackReply(
  db: Database,
  taskId: string,
  runId: string,
  body: string,
  reason: string,
  draft: (channel: string, threadTs: string | null, text: string) => string | Promise<string> = createDraft,
  auto = false,
  discardDraft: (draftId: string) => void | Promise<void> = deleteDraft,
): Promise<string> {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | null;
  const ev = task?.event_id ? (db.prepare("SELECT * FROM events WHERE id = ?").get(task.event_id) as EventRow | null) : null;
  if (!ev || ev.source !== "slack") return "这个任务不是从 Slack 来的，不能提议 Slack 回复。";
  const pending = db.prepare("SELECT id, run_id, payload FROM approvals WHERE task_id = ? AND kind = 'outbound' AND status = 'pending'").get(taskId) as
    Pick<ApprovalRow, "id" | "run_id" | "payload"> | null;
  if (pending && pending.run_id === runId) return "这个任务已经有一条待审批的回复了，不要再提。等使用者审批。";
  if (pending) {
    // An earlier run's card, and this run was started by a new message in the conversation: one
    // conversation, one card. The old one and its Slack draft go (the composer holds one draft).
    db.prepare("UPDATE approvals SET status = 'denied', decided_at = ?, result = 'superseded' WHERE id = ? AND status = 'pending'").run(Date.now(), pending.id);
    const old = (JSON.parse(pending.payload) as { draftId?: string }).draftId;
    if (old) {
      try {
        await discardDraft(old);
      } catch (e) {
        log(`propose: discarding the replaced draft ${old} failed: ${String(e).slice(0, 200)}`);
      }
    }
  }
  const target = replyTarget(ev);
  let draftId: string | null = null;
  let draftError: string | null = null;
  try {
    draftId = await draft(target.channel, target.threadTs, body);
  } catch (e) {
    // e.g. the thread composer already holds an unsent draft; the card still works, send posts directly.
    draftError = String((e as { stderr?: string }).stderr ?? e).slice(0, 300);
  }
  const id = newId("a");
  const now = Date.now();
  db.prepare(`INSERT INTO approvals (id, task_id, run_id, kind, key, payload, created_at, status, decision_note, decided_at)
              VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?)`)
    .run(id, taskId, runId, hash({ kind: "slack.reply", body }), JSON.stringify({ kind: "slack.reply", ...target, text: body, reason, draftId, draftError }), now,
      auto ? "approved" : "pending", auto ? AUTO_NOTE : null, auto ? now : null);
  if (auto) return "全托管模式：这条回复会在本轮结束后直接发出。本轮可以结束了。";
  return draftId
    ? "已在 Slack 输入框里建好草稿，并提交给使用者审批。本轮可以结束了。"
    : "已提交给使用者审批（Slack 草稿没建成，审批通过后会直接发送）。本轮可以结束了。";
}

export function report(db: Database, taskId: string, outcome: string, summary: string, evidence?: string): string {
  db.prepare("UPDATE tasks SET outcome = ?, summary = ?, updated_at = ? WHERE id = ?")
    .run(outcome, evidence ? `${summary}\n\n证据：${evidence}` : summary, Date.now(), taskId);
  return "已记录。";
}

export async function serveMcp(): Promise<void> {
  const dbPath = process.env.SIDEKICK_DB;
  const taskId = process.env.SIDEKICK_TASK_ID;
  const runId = process.env.SIDEKICK_RUN_ID ?? "";
  const waitMs = Number(process.env.SIDEKICK_WAIT_MS ?? 300_000);
  if (!dbPath || !taskId) throw new Error("SIDEKICK_DB and SIDEKICK_TASK_ID are required");
  const db = new Sqlite(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");

  const server = new Server({ name: "sidekick", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "approve",
        description: "Permission prompts are answered here by the human operator. Not for direct use.",
        inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, additionalProperties: true },
      },
      {
        name: "propose",
        description: "提议一个对外动作，交给使用者审批；批准后由 sidekick 执行。目前支持 kind=slack.reply：在任务来源的那条 Slack 消息下回复 text。",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["slack.reply"] },
            text: { type: "string", description: "要发出的完整回复正文" },
            reason: { type: "string", description: "一句话说明为什么这样回，给审批的人看" },
          },
          required: ["kind", "text"],
        },
      },
      {
        name: "report",
        description: "本轮结束前调用一次，记录这个任务的结论。",
        inputSchema: {
          type: "object",
          properties: {
            outcome: { type: "string", enum: ["reply_proposed", "no_reply", "needs_me", "done"], description: "reply_proposed：已用 propose 提了回复；no_reply：不需要回；needs_me：要使用者亲自决定或动手；done：事情办完了" },
            summary: { type: "string", description: "一两句话的结论，给使用者看" },
            evidence: { type: "string", description: "结论的出处：PR、文件、日志、数据" },
          },
          required: ["outcome", "summary"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = (req.params.arguments ?? {}) as Record<string, any>;
    switch (req.params.name) {
      case "approve":
        return text(JSON.stringify(await decidePermission(db, taskId, runId, String(a.tool_name), a.input, waitMs)));
      case "propose":
        if (a.kind !== "slack.reply" || typeof a.text !== "string" || !a.text.trim()) return text("参数不对：kind 必须是 slack.reply，text 不能为空。");
        // The run's own mode, not the one in force now: a reply drafted under semi-mode rules never goes out
        // unseen because full mode began (by hand or on a timetable) while it was being written.
        return text(await proposeSlackReply(db, taskId, runId, a.text, String(a.reason ?? ""), createDraft, process.env.SIDEKICK_MODE === "full"));
      case "report":
        return text(report(db, taskId, String(a.outcome), String(a.summary ?? ""), a.evidence ? String(a.evidence) : undefined));
      default:
        return text(`unknown tool ${req.params.name}`);
    }
  });
  await server.connect(new StdioServerTransport());
}
