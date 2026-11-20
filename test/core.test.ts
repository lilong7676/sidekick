import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_NOTE, DELETED_IN_SLACK, processDecisions, decide, reconcileDrafts, replyBlocks, RULE_NOTE, SENT_IN_SLACK, SIGN_APPROVED, SIGN_AUTO } from "../src/approvals.ts";
import { getTask, openDb, type EventRow } from "../src/db.ts";
import { autoReplyAllowed, autoReplyRules, decidePermission, PENDING_MESSAGE, proposeSlackReply, replyOptions, replyTarget } from "../src/mcp.ts";
import { API_STALL_MS, apiStall, claudeArgs, takeoverArgs, type LaunchSpec } from "../src/runner.ts";
import { parsePermalink, pickSlackMessages, type UnreadRich } from "../src/slack.ts";
import { ENGINE_DENY, manualTaskPrompt, needsConnectors, RETRY_LATER_MS, sessionFor, settle, systemPrompt, toolSetFor } from "../src/handle.ts";
import { addManualTask, cancel, continueInClaude, mute, processNow, recentlyDeletedDrafts, slackPeople, taskDetail, unmute } from "../src/queries.ts";
import { approvalLine } from "../src/notify.ts";
import { setLang } from "../src/i18n.ts";
import { Database } from "bun:sqlite";
import { intakeSlack, isClosing, QUIET_MS } from "../src/intake.ts";
import { groupLines, prLine, prLinks, profileGroups } from "../src/facts.ts";
import type { Profile } from "../src/config.ts";

const freshDb = () => openDb(mkdtempSync(join(tmpdir(), "sidekick-test-")));

function seedTask(db: ReturnType<typeof openDb>, status = "running", ev?: Partial<EventRow>) {
  let eventId: number | null = null;
  if (ev) {
    eventId = Number(db.prepare(`INSERT INTO events (source, kind, dedupe_key, channel, ts, thread_ts, text, received_at)
      VALUES ('slack', ?, ?, ?, ?, ?, ?, 0)`).run(ev.kind ?? "dm", `k${Math.random()}`, ev.channel ?? "D1", ev.ts ?? "100.1", ev.thread_ts ?? null, ev.text ?? "hi").lastInsertRowid);
  }
  db.prepare("INSERT INTO tasks (id, source, kind, title, status, event_id, created_at, updated_at) VALUES ('t1', ?, 'dm', 'x', ?, ?, 0, 0)")
    .run(ev ? "slack" : "manual", status, eventId);
}

describe("approval tool", () => {
  test("times out to a deny that tells the agent to stop", async () => {
    const db = freshDb();
    seedTask(db);
    const r = await decidePermission(db, "t1", "r1", "Bash", { command: "git push" }, 30, 10);
    expect(r).toEqual({ behavior: "deny", message: PENDING_MESSAGE });
    expect((db.prepare("SELECT status FROM approvals").get() as { status: string }).status).toBe("pending");
  });

  test("a retry of a still-pending call is denied at once, without a second card", async () => {
    const db = freshDb();
    seedTask(db);
    await decidePermission(db, "t1", "r1", "Bash", { command: "git push" }, 10, 5);
    const started = Date.now();
    const r = await decidePermission(db, "t1", "r1", "Bash", { command: "git push" }, 5_000, 5);
    expect(r.behavior).toBe("deny");
    expect(Date.now() - started).toBeLessThan(500);
    expect((db.prepare("SELECT COUNT(*) n FROM approvals").get() as { n: number }).n).toBe(1);
  });

  test("after approval the same call is allowed immediately (resume)", async () => {
    const db = freshDb();
    seedTask(db);
    await decidePermission(db, "t1", "r1", "Bash", { command: "git push" }, 10, 5);
    const id = (db.prepare("SELECT id FROM approvals").get() as { id: string }).id;
    decide(db, id, "approved");
    expect(await decidePermission(db, "t1", "r2", "Bash", { command: "git push" }, 10, 5)).toEqual({ behavior: "allow" });
  });

  test("a decision made while the run waits is answered inline and marked so", async () => {
    const db = freshDb();
    seedTask(db);
    const pending = decidePermission(db, "t1", "r1", "Bash", { command: "x" }, 2_000, 10);
    await Bun.sleep(50);
    const id = (db.prepare("SELECT id FROM approvals").get() as { id: string }).id;
    decide(db, id, "approved");
    expect(await pending).toEqual({ behavior: "allow" });
    expect((db.prepare("SELECT result FROM approvals").get() as { result: string }).result).toBe("inline");
  });
});

describe("slack reply proposals", () => {
  test("reply target: thread, DM root, or a new thread under a channel mention", async () => {
    expect(replyTarget({ kind: "thread", channel: "C", ts: "2", thread_ts: "1" } as EventRow)).toEqual({ channel: "C", threadTs: "1" });
    expect(replyTarget({ kind: "dm", channel: "D", ts: "2", thread_ts: null } as EventRow)).toEqual({ channel: "D", threadTs: null });
    expect(replyTarget({ kind: "mention", channel: "C", ts: "2", thread_ts: null } as EventRow)).toEqual({ channel: "C", threadTs: "2" });
  });

  test("propose drafts once and refuses a second pending reply", async () => {
    const db = freshDb();
    seedTask(db, "running", { kind: "mention", channel: "C9", ts: "5.5" });
    const calls: unknown[] = [];
    const fakeDraft = (c: string, t: string | null, b: string) => { calls.push([c, t, b]); return "Dr1"; };
    expect(await proposeSlackReply(db, "t1", "r1", "收到", "why", fakeDraft)).toContain("草稿");
    expect(calls).toEqual([["C9", "5.5", "收到"]]);
    expect(await proposeSlackReply(db, "t1", "r1", "再来一条", "", fakeDraft)).toContain("已经有一条");
  });
});

/**
 * What Slack shows: `live` lists the drafts still unsent (undefined: the list cannot be read), `mine`
 * is my message there since the card was made. Every send is logged; the draft list is counted.
 */
const fakeSender = (slack: { live?: string[]; mine?: string | null } = {}) => {
  const log: string[] = [];
  const listed = { n: 0 };
  return { log, listed, sender: {
    sendDraft: (id: string) => void log.push(`send-draft ${id}`),
    deleteDraft: (id: string) => void log.push(`delete-draft ${id}`),
    sendMessage: (c: string, t: string | null, b: string, blocks?: unknown[]) =>
      void log.push(`send ${c} ${t} ${b}${blocks ? ` [${(blocks[0] as { elements: Array<{ text: string }> }).elements[0].text}]` : ""}`),
    liveDrafts: () => { listed.n += 1; return slack.live ? new Set(slack.live) : null; },
    mineSince: () => slack.mine ?? null,
  } };
};

describe("one conversation, one card", () => {
  test("a later run's proposal replaces the earlier card and its Slack draft; the same run cannot propose twice", async () => {
    const db = freshDb();
    seedTask(db, "running", { kind: "dm" });
    await proposeSlackReply(db, "t1", "r1", "收到", "", () => "Dr1");
    expect(await proposeSlackReply(db, "t1", "r1", "再来一条", "", () => "DrX")).toContain("已经有一条");
    const discarded: string[] = [];
    await proposeSlackReply(db, "t1", "r2", "收到，补充的也看了", "", () => "Dr2", false, (id) => { discarded.push(id); });
    expect(discarded).toEqual(["Dr1"]);
    const cards = db.prepare("SELECT run_id, status, result, json_extract(payload, '$.draftId') AS draft FROM approvals ORDER BY created_at").all();
    expect(cards).toEqual([
      { run_id: "r1", status: "denied", result: "superseded", draft: "Dr1" },
      { run_id: "r2", status: "pending", result: null, draft: "Dr2" },
    ]);
  });
});

describe("acting on decisions", () => {

  test("approved reply with a draft sends the draft and closes the task", async () => {
    const db = freshDb();
    seedTask(db, "needs_approval", { kind: "dm" });
    await proposeSlackReply(db, "t1", "r1", "收到", "", () => "Dr1");
    const id = (db.prepare("SELECT id FROM approvals").get() as { id: string }).id;
    decide(db, id, "approved");
    const { log, sender } = fakeSender();
    await processDecisions(db, () => false, sender);
    expect(log).toEqual(["send-draft Dr1"]);
    expect(getTask(db, "t1")!.status).toBe("done");
  });

  test("approved with edited text replaces the draft", async () => {
    const db = freshDb();
    seedTask(db, "needs_approval", { kind: "thread", channel: "C", ts: "2", thread_ts: "1" });
    await proposeSlackReply(db, "t1", "r1", "收到", "", () => "Dr1");
    const id = (db.prepare("SELECT id FROM approvals").get() as { id: string }).id;
    decide(db, id, "approved", undefined, "改过的");
    const { log, sender } = fakeSender();
    await processDecisions(db, () => false, sender);
    expect(log).toEqual(["delete-draft Dr1", "send C 1 改过的"]);
  });

  test("denied with a note requeues the task with the feedback", async () => {
    const db = freshDb();
    seedTask(db, "needs_approval", { kind: "dm" });
    await proposeSlackReply(db, "t1", "r1", "收到", "", () => "Dr1");
    const id = (db.prepare("SELECT id FROM approvals").get() as { id: string }).id;
    decide(db, id, "denied", "语气太硬");
    const { log, sender } = fakeSender();
    await processDecisions(db, () => false, sender);
    expect(log).toEqual(["delete-draft Dr1"]);
    const t = getTask(db, "t1")!;
    expect(t.status).toBe("queued");
    expect(t.next_prompt).toContain("语气太硬");
  });

  test("decisions wait while the task is still running", async () => {
    const db = freshDb();
    seedTask(db, "running", { kind: "dm" });
    await proposeSlackReply(db, "t1", "r1", "收到", "", () => "Dr1");
    const id = (db.prepare("SELECT id FROM approvals").get() as { id: string }).id;
    decide(db, id, "approved");
    const { log, sender } = fakeSender();
    expect(await processDecisions(db, () => true, sender)).toBe(0);
    expect(log).toEqual([]);
  });
});

describe("signed replies", () => {
  const approved = async (note?: string) => {
    const db = freshDb();
    seedTask(db, "needs_approval", { kind: "dm" });
    await proposeSlackReply(db, "t1", "r1", "收到", "", () => "Dr1");
    const id = (db.prepare("SELECT id FROM approvals").get() as { id: string }).id;
    decide(db, id, "approved", note);
    return db;
  };

  test("approved here: the draft goes and the reply is posted under the signature line", async () => {
    const db = await approved();
    const { log, sender } = fakeSender();
    await processDecisions(db, () => false, sender, undefined, { sign: true });
    expect(log).toEqual(["delete-draft Dr1", `send D1 null 收到 [${SIGN_APPROVED}]`]);
  });

  test("full mode says nobody looked yet; signing off sends the draft as before", async () => {
    const auto = await approved(AUTO_NOTE);
    const a = fakeSender();
    await processDecisions(auto, () => false, a.sender, undefined, { sign: true });
    expect(a.log.at(-1)).toBe(`send D1 null 收到 [${SIGN_AUTO}]`);
    const plain = await approved();
    const b = fakeSender();
    await processDecisions(plain, () => false, b.sender, undefined, { sign: false });
    expect(b.log).toEqual(["send-draft Dr1"]);
  });

  test("a long reply is split into sections under Slack's limit, at line breaks", () => {
    const line = "x".repeat(1999);
    const blocks = replyBlocks([line, line, line].join("\n"), false) as Array<{ type: string; text?: { text: string } }>;
    expect(blocks[0].type).toBe("context");
    const sections = blocks.slice(1).map((b) => b.text!.text);
    expect(sections.every((t) => t.length <= 3000)).toBe(true);
    expect(sections.join("\n")).toBe([line, line, line].join("\n"));
    expect(SIGN_APPROVED.startsWith(":speaking_head_in_silhouette:")).toBe(true);
  });
});

describe("a reply card and its Slack draft: whichever I use first wins", () => {
  const card = (db: ReturnType<typeof openDb>) => db.prepare("SELECT * FROM approvals").get() as { id: string; status: string; result: string | null; payload: string };
  const proposed = async () => {
    const db = freshDb();
    seedTask(db, "needs_approval", { kind: "dm" });
    await proposeSlackReply(db, "t1", "r1", "收到", "", () => "Dr1");
    return db;
  };

  test("sent from Slack (edited): the card closes as sent, with what went out, and nothing is sent again", async () => {
    const db = await proposed();
    const { log, sender } = fakeSender({ live: ["DrOther"], mine: "收到，我下午看" });
    expect(await reconcileDrafts(db, () => false, sender)).toBe(1);
    const a = card(db);
    expect([a.status, a.result]).toEqual(["executed", SENT_IN_SLACK]);
    expect(JSON.parse(a.payload).sentText).toBe("收到，我下午看");
    expect(getTask(db, "t1")).toMatchObject({ status: "done", outcome: "replied" });
    expect(await processDecisions(db, () => false, sender)).toBe(0);
    expect(log).toEqual([]);
  });

  test("draft deleted in Slack and nothing said: no reply", async () => {
    const db = await proposed();
    const { log, sender } = fakeSender({ live: [], mine: null });
    expect(await reconcileDrafts(db, () => false, sender)).toBe(1);
    expect([card(db).status, card(db).result]).toEqual(["denied", DELETED_IN_SLACK]);
    expect(getTask(db, "t1")).toMatchObject({ status: "closed", outcome: "reply_rejected" });
    expect(log).toEqual([]);
  });

  test("left alone while the draft is still there, the list cannot be read, or the task is running", async () => {
    const db = await proposed();
    expect(await reconcileDrafts(db, () => false, fakeSender({ live: ["Dr1"], mine: "x" }).sender)).toBe(0);
    expect(await reconcileDrafts(db, () => false, fakeSender({ mine: "x" }).sender)).toBe(0);
    const running = fakeSender({ live: [], mine: "x" });
    expect(await reconcileDrafts(db, () => true, running.sender)).toBe(0);
    expect(running.listed.n).toBe(0); // no Slack call at all
    expect(card(db).status).toBe("pending");
  });

  test("no card waiting: Slack is not asked", async () => {
    const db = freshDb();
    const { listed, sender } = fakeSender({ live: [] });
    expect(await reconcileDrafts(db, () => false, sender)).toBe(0);
    expect(listed.n).toBe(0);
  });

  test("approved here after sending it from Slack: not sent twice", async () => {
    const db = await proposed();
    decide(db, card(db).id, "approved");
    const { log, sender } = fakeSender({ live: [], mine: "收到" });
    expect(await processDecisions(db, () => false, sender)).toBe(1);
    expect(log).toEqual([]);
    expect([card(db).status, card(db).result]).toEqual(["executed", SENT_IN_SLACK]);
    expect(getTask(db, "t1")!.status).toBe("done");
  });

  test("approved here after deleting the draft in Slack: the later decision stands, sent as a message", async () => {
    const db = await proposed();
    decide(db, card(db).id, "approved");
    const { log, sender } = fakeSender({ live: [], mine: null });
    await processDecisions(db, () => false, sender);
    expect(log).toEqual(["send D1 null 收到"]);
  });
});

describe("the Slack DM to myself says what to do from the phone", () => {
  const reply = (extra: Record<string, unknown>) => ({ kind: "outbound" as const, payload: JSON.stringify({ kind: "slack.reply", text: "收到\n下午看", ...extra }) });

  test("a reply with a draft: go to the conversation and send it, or delete it", () => {
    const line = approvalLine(reply({ draftId: "Dr1" }), "Bin：问题都改完了不", "https://x.slack.com/archives/D1/p1");
    expect(line).toBe("待你回复 · Bin：问题都改完了不\n> 收到\n> 下午看\n草稿已经在这个对话的输入框里：点链接过去，改好直接发出；不回就删掉草稿。\nhttps://x.slack.com/archives/D1/p1");
    expect(line).not.toContain("sidekick approvals");
  });

  test("no draft: approve in the app; an operation: approve or deny in the app", () => {
    expect(approvalLine(reply({}), "t", "")).toContain("到菜单栏的 sidekick 里批准后发出");
    expect(approvalLine({ kind: "tool" as const, payload: JSON.stringify({ tool_name: "Bash", input: { command: "git push" } }) }, "t", "")).toContain("在菜单栏的 sidekick 里批准或拒绝");
  });

  describe("in English", () => {
    afterEach(() => setLang("zh"));

    test("the same lines, in English; the draft itself stays as written", () => {
      setLang("en");
      expect(approvalLine(reply({ draftId: "Dr1" }), "Bin: all fixed?", "https://x.slack.com/archives/D1/p1")).toBe(
        "Reply to approve · Bin: all fixed?\n> 收到\n> 下午看\nThe draft is already in this conversation's message box: follow the link, edit it and send it. Not replying? Delete the draft.\nhttps://x.slack.com/archives/D1/p1",
      );
      expect(approvalLine(reply({}), "t", "")).toContain("approve it in sidekick in the menu bar to send it");
      expect(approvalLine({ kind: "tool" as const, payload: JSON.stringify({ tool_name: "Bash", input: { command: "git push" } }) }, "t", ""))
        .toBe('Action to approve · t\nBash {"command":"git push"}\nApprove or deny it in sidekick in the menu bar.');
    });
  });
});

describe("continuing a task in my own Claude Code", () => {
  const profile = { root: "/work space" } as unknown as Profile;
  const withSession = (status: string) => {
    const db = freshDb();
    seedTask(db, status, { kind: "dm" });
    db.prepare("UPDATE tasks SET session_id = '9b1c24a5-55c9-4585-989c-146518d84e21', title = 'Bin：后天吧'").run();
    return db;
  };

  test("terminal: a fork of the session, named after the task, and the task is left as it was", async () => {
    const db = withSession("done");
    const r = await continueInClaude(profile, db, "t1", "terminal", async () => { throw new Error("must not open the desktop app"); });
    expect(r).toMatchObject({ where: "terminal", cwd: "/work space", session: "9b1c24a5-55c9-4585-989c-146518d84e21", name: "sidekick：Bin：后天吧" });
    expect(r.command).toContain("--resume 9b1c24a5-55c9-4585-989c-146518d84e21 --fork-session -n");
    expect(getTask(db, "t1")).toMatchObject({ status: "done", handed_off_at: null });
  });

  test("desktop: sidekick's own session opens there and is handed over", async () => {
    const db = withSession("needs_me");
    const opened: string[] = [];
    await continueInClaude(profile, db, "t1", "desktop", async (cwd, session) => { opened.push(`${cwd} ${session}`); });
    expect(opened).toEqual(["/work space 9b1c24a5-55c9-4585-989c-146518d84e21"]);
    expect(getTask(db, "t1")!.handed_off_at).toBeNumber();
  });

  test("not while a run is going, nor without a session", async () => {
    await expect(continueInClaude(profile, withSession("running"), "t1", "terminal")).rejects.toThrow("正在跑");
    const db = freshDb();
    seedTask(db, "done", { kind: "dm" });
    await expect(continueInClaude(profile, db, "t1", "terminal")).rejects.toThrow("还没有会话");
  });

  test("a handed-over session is never resumed by sidekick again", () => {
    expect(sessionFor({ session_id: "S1", handed_off_at: null })).toEqual({ id: "S1", resume: true });
    const after = sessionFor({ session_id: "S1", handed_off_at: 5 });
    expect(after.resume).toBe(false);
    expect(after.id).not.toBe("S1");
    expect(sessionFor({ session_id: null, handed_off_at: null }).resume).toBe(false);
  });

  test("an older ledger gets the new column when opened", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidekick-migrate-"));
    const old = new Database(join(dir, "sidekick.db"));
    old.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, event_id INTEGER, session_id TEXT, next_prompt TEXT, outcome TEXT, summary TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, notified_status TEXT)");
    old.close();
    const db = openDb(dir);
    expect((db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name)).toContain("handed_off_at");
    openDb(dir); // and opening it again is fine
  });
});

describe("task settling", () => {
  test("pending approval wins, then outcome decides", async () => {
    const db = freshDb();
    seedTask(db, "running", { kind: "dm" });
    await proposeSlackReply(db, "t1", "r1", "收到", "", () => "Dr1");
    settle(db, "t1", false);
    expect(getTask(db, "t1")!.status).toBe("needs_approval");
  });

  test("no outcome reported surfaces to me instead of silently finishing", async () => {
    const db = freshDb();
    seedTask(db, "running");
    settle(db, "t1", false);
    expect(getTask(db, "t1")!.status).toBe("needs_me");
  });

  test("failures retry, then fail", async () => {
    const db = freshDb();
    seedTask(db, "running");
    for (let i = 0; i < 3; i += 1) {
      db.prepare("UPDATE tasks SET status = 'running' WHERE id = 't1'").run();
      settle(db, "t1", true);
    }
    expect(getTask(db, "t1")!.status).toBe("failed");
  });
});

describe("launch args", () => {
  const spec: LaunchSpec = {
    cwd: "/p", model: "claude-opus-5-5", effort: "medium", maxTurns: 40, lean: true,
    allow: [], ask: ["Bash(git push:*)"], deny: ENGINE_DENY, timeoutMs: 1000,
  };

  test("headless run: auto mode, lean sources, ask rules, deny rules, approval tool", async () => {
    const a = claudeArgs(spec, "do it", { id: "S1", resume: false }, "/tmp/m.json");
    const after = (f: string) => a[a.indexOf(f) + 1];
    expect(after("--permission-mode")).toBe("auto");
    expect(after("--setting-sources")).toBe("project,local");
    expect(after("--session-id")).toBe("S1");
    expect(after("--effort")).toBe("medium");
    expect(JSON.parse(after("--settings"))).toEqual({ permissions: { ask: ["Bash(git push:*)"] } });
    expect(a).toContain("Bash(slackcli messages:*)");
    expect(after("--permission-prompt-tool")).toBe("mcp__sidekick__approve");
  });

  test("resume uses --resume", async () => {
    const a = claudeArgs(spec, "go on", { id: "S1", resume: true });
    expect(a[a.indexOf("--resume") + 1]).toBe("S1");
    expect(a).not.toContain("--session-id");
  });

  test("takeover keeps rules and tools but not the lean sources", async () => {
    const a = takeoverArgs(spec, "S1", "/tmp/m.json");
    expect(a).not.toContain("--setting-sources");
    expect(a).not.toContain("-p");
    // The menu bar app only runs a takeover whose arguments start like this (WebPanel.swift).
    expect(a.slice(0, 2)).toEqual(["--resume", "S1"]);
  });
});

describe("which Slack messages are mine", () => {
  const ME = "UME";
  const names = (id: string) => ({ C1: "proj-x" } as Record<string, string>)[id] ?? null;
  const rich: UnreadRich = {
    users: [{ id: "U1", real_name: "Ann" }],
    unread_channels: [
      { id: "D1", is_im: true, messages: [{ ts: "1.1", user: "U1", text: "在吗" }, { ts: "1.2", user: ME, text: "我自己说的" }] },
      { id: "G1", is_mpim: true, messages: [{ ts: "2.1", user: "U1", text: "群聊闲聊" }, { ts: "2.2", user: "U1", text: `<@${ME}> 看下` }] },
      { id: "C1", name: "proj-x", mention_count: 1, messages: [{ ts: "3.1", user: "U1", text: "无关" }, { ts: "3.2", user: "U1", text: `<@${ME}> 帮看` }, { ts: "3.3", user: "U1", text: "<!here> 通知" }] },
      { id: "C2", name: "random", mention_count: 1, messages: [{ ts: "4.1", user: "U1", text: "@ 在 thread 里，主线没有" }] },
      { id: "C3", name: "bots", mention_count: 1, messages: [{ ts: "5.1", bot_id: "B1", text: `<@${ME}> bot 提醒` }] },
    ],
    threads: { items: [
      { channel_id: "C1", thread_ts: "6.0", unread_replies: [{ ts: "6.1", user: "U1", text: "thread 里的其他回复" }, { ts: "6.2", user: "U1", text: `<@${ME}> thread 里问你` }] },
      { channel_id: "D1", thread_ts: "7.0", unread_replies: [{ ts: "7.1", user: "U1", text: "私信里的 thread 回复" }] },
    ] },
  };
  const picked = pickSlackMessages(rich, ME, names);
  const keys = picked.map((p) => `${p.kind}:${p.message.ts}`);

  test("DMs and personal @ only", async () => {
    expect(keys.sort()).toEqual(["dm:1.1", "dm:7.1", "mention:2.2", "mention:3.2", "mention:6.2"].sort());
  });

  test("thread replies keep their thread and channel name", async () => {
    const t = picked.find((p) => p.message.ts === "6.2")!;
    expect(t.message.thread_ts).toBe("6.0");
    expect(t.channelName).toBe("proj-x");
  });

  test("no fallback to an unrelated message when the @ is not in view", async () => {
    expect(keys.some((k) => k.endsWith(":4.1"))).toBe(false);
  });
});

describe("intake: Slack events become tasks", () => {
  const addEvent = (db: ReturnType<typeof openDb>, e: Partial<EventRow>) =>
    db.prepare(`INSERT INTO events (source, kind, dedupe_key, channel, channel_name, ts, thread_ts, user_id, user_name, text, received_at)
      VALUES ('slack', ?, ?, ?, ?, ?, ?, ?, 'Ann', ?, 0)`).run(e.kind ?? "dm", `k${Math.random()}`, e.channel ?? "D1", e.channel_name ?? null, e.ts ?? "1.0", e.thread_ts ?? null, e.user_id ?? "U1", e.text ?? "hi");
  const tasks = (db: ReturnType<typeof openDb>) => db.prepare("SELECT id, status, next_prompt, notified_status FROM tasks ORDER BY created_at").all() as Array<{ id: string; status: string; next_prompt: string | null; notified_status: string | null }>;
  /** A Slack ts this many hours from now. */
  const at = (hours: number) => (Date.now() / 1000 + hours * 3600).toFixed(6);
  const NO_FILTERS = { skipUsers: [], skipChannels: [], workHours: null };
  const DEFAULTS = { thread: null, dm: 2, ...NO_FILTERS };
  const NEVER = { thread: 0, dm: 0, ...NO_FILTERS }; // only while the task is still queued or running
  /** The first task settles (status, last active now), the way a run would leave it. */
  const settle = (db: ReturnType<typeof openDb>, status: string) =>
    db.prepare("UPDATE tasks SET status = ?, next_prompt = NULL, notified_status = ?, updated_at = ?").run(status, status, Date.now());

  test("a burst of DMs while the task is queued is one task", async () => {
    const db = freshDb();
    addEvent(db, { ts: at(0), text: "在吗" });
    addEvent(db, { ts: at(0.01), text: "问个事" });
    expect(intakeSlack(db, NEVER)).toBe(1);
    const t = tasks(db);
    expect(t.length).toBe(1);
    expect(t[0].next_prompt).toContain("问个事");
  });

  test("a thread keeps its task however late (default): a reply after the card reopens it with the card in mind", async () => {
    const db = freshDb();
    addEvent(db, { kind: "mention", channel: "C1", ts: at(0), thread_ts: "5.0", text: "<@ME> 看下" });
    intakeSlack(db, DEFAULTS);
    settle(db, "needs_approval");
    await proposeSlackReply(db, tasks(db)[0].id, "r1", "收到", "", () => "Dr1");
    addEvent(db, { kind: "mention", channel: "C1", ts: at(24 * 30), thread_ts: "5.0", text: "<@ME> 还有" });
    expect(intakeSlack(db, DEFAULTS)).toBe(0);
    const [t] = tasks(db);
    expect(t.status).toBe("queued");
    expect(t.next_prompt).toContain("还有");
    expect(t.next_prompt).toContain("还在等使用者审批");
    expect(t.notified_status).toBeNull(); // if it ends up needing me again, that is news
  });

  test("with the window at 0 a settled thread task takes no more messages", async () => {
    const db = freshDb();
    addEvent(db, { kind: "mention", channel: "C1", ts: at(0), thread_ts: "5.0" });
    intakeSlack(db, NEVER);
    settle(db, "needs_approval");
    addEvent(db, { kind: "mention", channel: "C1", ts: at(0.1), thread_ts: "5.0" });
    expect(intakeSlack(db, NEVER)).toBe(1);
  });

  test("a DM keeps its task for 2 h by default: within reopens it, after starts a new one", async () => {
    const db = freshDb();
    addEvent(db, { ts: at(0), text: "问题都改完了不" });
    intakeSlack(db, DEFAULTS);
    settle(db, "done");
    addEvent(db, { ts: at(1.5), text: "那你发吧" });
    expect(intakeSlack(db, DEFAULTS)).toBe(0);
    expect(tasks(db)[0]).toMatchObject({ status: "queued" });
    expect(tasks(db)[0].next_prompt).toContain("上一轮已经处理完了");
    settle(db, "closed");
    addEvent(db, { ts: at(3), text: "另一件事" });
    expect(intakeSlack(db, DEFAULTS)).toBe(1);
    expect(tasks(db).length).toBe(2);
  });

  test("a cancelled or failed task takes no new messages, and only the latest task counts", async () => {
    for (const status of ["cancelled", "failed"]) {
      const db = freshDb();
      addEvent(db, { ts: at(0) });
      intakeSlack(db, DEFAULTS);
      settle(db, status);
      addEvent(db, { ts: at(0.1) });
      expect(intakeSlack(db, DEFAULTS)).toBe(1);
    }
  });

  test("messages from skipped people or channels are closed at once, with the reason", async () => {
    const db = freshDb();
    addEvent(db, { ts: at(0), user_id: "U9" });
    addEvent(db, { kind: "mention", channel: "C7", channel_name: "random", ts: at(0.01), user_id: "U2" });
    addEvent(db, { kind: "mention", channel: "C8", ts: at(0.02), user_id: "U2" });
    expect(intakeSlack(db, { ...DEFAULTS, skipUsers: ["U9"], skipChannels: ["C7"] })).toBe(3);
    const rows = db.prepare("SELECT status, outcome, summary FROM tasks ORDER BY created_at, rowid").all() as Array<{ status: string; outcome: string | null; summary: string | null }>;
    expect(rows.map((r) => [r.status, r.outcome])).toEqual([["closed", "skipped"], ["closed", "skipped"], ["queued", null]]);
    expect(rows[0].summary).toBe("按规则跳过：不处理 Ann 的消息。");
    expect(rows[1].summary).toBe("按规则跳过：不处理 #random 里的 @。");
  });

  test("after hours, new work waits for the morning: a new task, and a settled one a message reopens", async () => {
    const db = freshDb();
    const night = new Date(2026, 10, 17, 22, 30); // Tue 22:30
    const nine = new Date(2026, 10, 18, 9, 0).getTime();
    const hours = { ...DEFAULTS, workHours: { start: 9, end: 20, weekends: false } };
    const ts = (minutes: number) => (night.getTime() / 1000 + minutes * 60).toFixed(6); // the messages come that night
    addEvent(db, { ts: ts(0) });
    intakeSlack(db, hours, night);
    expect(db.prepare("SELECT not_before FROM tasks").get()).toEqual({ not_before: nine });
    settle(db, "done");
    addEvent(db, { ts: ts(6) });
    intakeSlack(db, hours, night);
    expect(db.prepare("SELECT status, not_before FROM tasks").get()).toEqual({ status: "queued", not_before: nine });
    addEvent(db, { kind: "mention", channel: "C1", ts: ts(12) });
    intakeSlack(db, hours, new Date(2026, 10, 18, 10, 0)); // in working hours: no wait
    expect(db.prepare("SELECT not_before FROM tasks ORDER BY created_at DESC, rowid DESC").get()).toEqual({ not_before: null });
  });

  test("mentions in different channels never merge", async () => {
    const db = freshDb();
    addEvent(db, { kind: "mention", channel: "C1", ts: at(0) });
    addEvent(db, { kind: "mention", channel: "C2", ts: at(0.01) });
    expect(intakeSlack(db, DEFAULTS)).toBe(2);
  });
});

// Each message used to start a run of its own, and each resumed run re-read the whole conversation:
// "好了", "欧克", "那你发吧", "hao wo kankan" cost $0.43, $0.64, $0.87, $1.89 (2026-11-18).
describe("follow-ups: a burst is one run, and a closing word is not worked on", () => {
  const addEvent = (db: ReturnType<typeof openDb>, ts: string, text: string) =>
    db.prepare(`INSERT INTO events (source, kind, dedupe_key, channel, ts, user_id, user_name, text, received_at)
      VALUES ('slack', 'dm', ?, 'D1', ?, 'U1', 'Bin', ?, 0)`).run(`k${Math.random()}`, ts, text);
  const task = (db: ReturnType<typeof openDb>) => db.prepare("SELECT id, status, not_before, next_prompt FROM tasks").get() as { id: string; status: string; not_before: number | null; next_prompt: string | null };
  const RULES = { thread: null, dm: 2, skipUsers: [], skipChannels: [], workHours: null };
  const sec = (s: number) => (Date.now() / 1000 + s).toFixed(6);

  test("a new conversation waits a minute after its latest message; a message meanwhile pushes it back", () => {
    const db = freshDb();
    addEvent(db, sec(0), "上 staging 了吧？");
    intakeSlack(db, RULES);
    const first = task(db).not_before!;
    expect(first).toBeGreaterThan(Date.now() + QUIET_MS - 5_000);
    addEvent(db, sec(30), "怎么回事~");
    intakeSlack(db, RULES);
    expect(task(db).not_before!).toBeGreaterThanOrEqual(first + 29_000);
    expect(task(db).next_prompt).toContain("怎么回事~");
  });

  test("a message collected late does not wait: its quiet minute is already over", () => {
    const db = freshDb();
    addEvent(db, sec(-600), "上 staging 了吧？");
    intakeSlack(db, RULES);
    expect(task(db).not_before).toBeNull();
  });

  test("after hours the morning start wins over the quiet minute", () => {
    const db = freshDb();
    addEvent(db, sec(0), "在吗");
    const night = new Date(); night.setHours(23, 0, 0, 0);
    intakeSlack(db, { ...RULES, workHours: { start: 9, end: 20, weekends: true } }, night);
    expect(task(db).not_before!).toBeGreaterThan(Date.now() + 60 * 60_000);
  });

  test("a closing word in a handled conversation is kept with the task but does not reopen it", () => {
    const db = freshDb();
    addEvent(db, sec(-600), "上 staging 了吧？");
    intakeSlack(db, RULES);
    db.prepare("UPDATE tasks SET status = 'done', updated_at = ?").run(Date.now());
    for (const text of ["好了", "欧克", "哈哈", ":+1:", "👍"]) addEvent(db, sec(0), text);
    intakeSlack(db, RULES);
    expect(task(db)).toMatchObject({ status: "done", next_prompt: null });
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ?").get(task(db).id) as { n: number }).n).toBe(6);
    addEvent(db, sec(0), "那你发吧");
    intakeSlack(db, RULES);
    expect(task(db).status).toBe("queued");
  });

  test("a conversation opened by a closing word is skipped, still there to process anyway; a bare @ is not one", () => {
    const db = freshDb();
    addEvent(db, sec(0), ":+1:");
    intakeSlack(db, RULES);
    expect(db.prepare("SELECT status, outcome FROM tasks").get()).toEqual({ status: "closed", outcome: "skipped" });
    processNow(db, task(db).id);
    expect(task(db).status).toBe("queued");

    const other = freshDb();
    other.prepare(`INSERT INTO events (source, kind, dedupe_key, channel, ts, thread_ts, user_id, text, received_at)
      VALUES ('slack', 'mention', 'k', 'C1', ?, '5.0', 'U1', '<@U0733BA64AE>', 0)`).run(sec(0));
    intakeSlack(other, RULES);
    expect(task(other).status).toBe("queued");
  });

  test("what counts as a closing word", () => {
    for (const s of ["好了", "好的！", "欧克", "ok", "OK~", "收到", "谢谢", "哈哈哈", "嗯嗯", ":+1:", "👍👍", "<@U0733BA64AE> :pray:", "thanks!"]) expect(isClosing(s)).toBe(true);
    for (const s of ["那你发吧", "hao wo kankan", "你慢慢搞", "好了吗？上了没", "ok 那我先合了", "可以按照这个改", "", "<@U0733BA64AE>", " <@U1> <@U2> "]) expect(isClosing(s)).toBe(false);
  });
});

describe("rules can be overridden for one task", () => {
  test("held until morning: process now; skipped by a rule: process anyway; anything else is refused", () => {
    const db = freshDb();
    seedTask(db, "queued", { kind: "dm" });
    db.prepare("UPDATE tasks SET not_before = ?").run(Date.now() + 3_600_000);
    processNow(db, "t1");
    expect(getTask(db, "t1")!.not_before).toBeNull();
    db.prepare("UPDATE tasks SET status = 'closed', outcome = 'skipped', summary = '按规则跳过'").run();
    processNow(db, "t1");
    expect(getTask(db, "t1")).toMatchObject({ status: "queued", outcome: null, summary: null });
    db.prepare("UPDATE tasks SET status = 'done', outcome = 'replied'").run();
    expect(() => processNow(db, "t1")).toThrow("没有在等规则放行");
  });

  test("who has been reaching me, most first, for the panel to offer", () => {
    const db = freshDb();
    const now = Date.now();
    const add = (user: string, name: string, channel: string, kind: string, channelName: string | null) =>
      db.prepare("INSERT INTO events (source, kind, dedupe_key, channel, channel_name, user_id, user_name, received_at) VALUES ('slack', ?, ?, ?, ?, ?, ?, ?)")
        .run(kind, `k${Math.random()}`, channel, channelName, user, name, now);
    add("U1", "Ann", "D1", "dm", null);
    add("U1", "Ann", "C1", "mention", "eng");
    add("U2", "Bob", "C1", "mention", "eng");
    const r = slackPeople(db);
    expect(r.people.map((p) => [p.id, p.name, p.messages])).toEqual([["U1", "Ann", 2], ["U2", "Bob", 1]]);
    expect(r.channels).toEqual([{ id: "C1", name: "eng", messages: 2 }]);
  });
});

describe("working hours", async () => {
  const { nextWorkStart } = await import("../src/intake.ts");
  const wh = { start: 9, end: 20, weekends: false };
  const t = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m); // 2026-11-16 is a Monday

  test("inside them work starts now; after them, at the next start; weekends wait for Monday", () => {
    expect(nextWorkStart(t(17, 10), wh)).toBeNull();
    expect(nextWorkStart(t(17, 20), wh)).toBe(t(18, 9).getTime());
    expect(nextWorkStart(t(17, 7, 30), wh)).toBe(t(17, 9).getTime());
    expect(nextWorkStart(t(20, 21), wh)).toBe(t(23, 9).getTime()); // Friday night → Monday
    expect(nextWorkStart(t(21, 12), wh)).toBe(t(23, 9).getTime()); // Saturday noon → Monday
    expect(nextWorkStart(t(21, 12), { ...wh, weekends: true })).toBeNull();
    expect(nextWorkStart(t(21, 12), null)).toBeNull();
  });
});

describe("channel names by id", () => {
  test("looked up once, cached, refreshed after a week, stale kept on failure", async () => {
    const { channelName } = await import("../src/slack.ts");
    const db = freshDb();
    let calls = 0;
    const search = (id: string) => { calls += 1; return id === "C1" ? "proj-x" : null; };
    expect(await channelName(db, "C1", search, 0)).toBe("proj-x");
    expect(await channelName(db, "C1", search, 1000)).toBe("proj-x");
    expect(calls).toBe(1);
    const week = 7 * 24 * 3600_000;
    expect(await channelName(db, "C1", () => { throw new Error("rate limited"); }, week + 1)).toBe("proj-x");
    expect(await channelName(db, "C9", search, 0)).toBeNull();
  });
});

describe("what on the Slack socket means collect now", async () => {
  const { shouldCollect } = await import("../src/listener.ts");
  test("others' DMs and @me, not mine, not bots, not edits", async () => {
    const st = { droppedSinceHello: false };
    expect(shouldCollect({ type: "message", user: "U1", is_dm: true }, "UME", st)).toBe(true);
    expect(shouldCollect({ type: "message", user: "U1", mentions_me: true }, "UME", st)).toBe(true);
    expect(shouldCollect({ type: "message", user: "U1" }, "UME", st)).toBe(false);
    expect(shouldCollect({ type: "message", user: "UME", is_dm: true }, "UME", st)).toBe(false);
    expect(shouldCollect({ type: "message", user: "U1", bot_id: "B1", is_dm: true }, "UME", st)).toBe(false);
    expect(shouldCollect({ type: "message", user: "U1", is_dm: true, changed: true }, "UME", st)).toBe(false);
    expect(shouldCollect({ type: "reaction_added", user: "U1" }, "UME", st)).toBe(false);
  });

  test("my own new messages are told apart, for checking reply drafts", async () => {
    const { isMyMessage } = await import("../src/listener.ts");
    expect(isMyMessage({ type: "message", user: "UME", channel_id: "D1" }, "UME")).toBe(true);
    expect(isMyMessage({ type: "message", user: "U1", channel_id: "D1" }, "UME")).toBe(false);
    expect(isMyMessage({ type: "message", user: "UME", channel_id: "D1", changed: true }, "UME")).toBe(false);
    expect(isMyMessage({ type: "message", user: "", channel_id: "D1" }, "")).toBe(false);
  });

  test("a reconnect after a drop catches up once; the first hello does not", async () => {
    const st = { droppedSinceHello: false };
    expect(shouldCollect({ type: "hello" }, "UME", st)).toBe(false);
    expect(shouldCollect({ type: "disconnected", error: "x" }, "UME", st)).toBe(false);
    expect(shouldCollect({ type: "hello" }, "UME", st)).toBe(true);
    expect(shouldCollect({ type: "hello" }, "UME", st)).toBe(false);
  });
});

describe("slackcli calls do not block the daemon", () => {
  test("timers keep firing while a slow slackcli call runs", async () => {
    const { slackJson } = await import("../src/slack.ts");
    const prev = process.env.SIDEKICK_SLACKCLI;
    process.env.SIDEKICK_SLACKCLI = new URL("./fixtures/slow-slackcli.sh", import.meta.url).pathname;
    try {
      let ticks = 0;
      const timer = setInterval(() => { ticks += 1; }, 100);
      const started = Date.now();
      const r = await slackJson<{ ok: boolean }>(["conversations", "unread"]);
      clearInterval(timer);
      expect(r.ok).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(ticks).toBeGreaterThanOrEqual(7); // a sync call would have left this at 0
    } finally {
      if (prev === undefined) delete process.env.SIDEKICK_SLACKCLI;
      else process.env.SIDEKICK_SLACKCLI = prev;
    }
  });
});

// A task given by hand used to have nowhere to reply: an agent asked to answer a Slack thread it had
// been linked to drafted the answer, had its proposal refused, and told me to paste it myself.
describe("a task given by hand with a Slack link", () => {
  const ROOT = "https://acme.slack.com/archives/C0B39GJKUBV/p1794909984018279";
  const REPLY = "https://acme.slack.com/archives/C0B39GJKUBV/p1794910000000100?thread_ts=1794909984.018279&cid=C0B39GJKUBV";
  const DM = "https://acme.slack.com/archives/D0123ABC/p1794909000123456";
  const drafted = () => {
    const calls: Array<[string, string | null]> = [];
    return { calls, draft: (c: string, t: string | null) => { calls.push([c, t]); return "Dr1"; } };
  };

  test("reads Slack's copied links: a message, a reply in a thread, a DM, and text with none", () => {
    expect(parsePermalink(`${ROOT} review this`)).toEqual({ url: ROOT, channel: "C0B39GJKUBV", ts: "1794909984.018279", threadTs: null });
    expect(parsePermalink(`看下 <${REPLY}|这条>`)).toMatchObject({ channel: "C0B39GJKUBV", ts: "1794910000.000100", threadTs: "1794909984.018279" });
    expect(parsePermalink(DM)).toMatchObject({ channel: "D0123ABC", ts: "1794909000.123456", threadTs: null });
    expect(parsePermalink("https://acme.enterprise.slack.com/archives/G1A2B3/p1794909000123456")).toMatchObject({ channel: "G1A2B3" });
    expect(parsePermalink("review https://github.com/acme/web/pull/241")).toBeNull();
    expect(parsePermalink("https://acme.slack.com/archives/C0B39GJKUBV")).toBeNull();
  });

  test("a link to a message: the reply goes in that message's thread, through an approval card", async () => {
    const db = freshDb();
    const id = addManualTask(db, `${ROOT} review this`);
    expect(getTask(db, id)?.event_id).not.toBeNull();
    const d = drafted();
    expect(await proposeSlackReply(db, id, "r1", "看了，整体没问题", "", d.draft)).toContain("草稿");
    expect(d.calls).toEqual([["C0B39GJKUBV", "1794909984.018279"]]);
    expect((db.prepare("SELECT status FROM approvals WHERE task_id = ?").get(id) as { status: string }).status).toBe("pending");
  });

  test("a link to a reply goes in its thread; a DM link goes in the DM", async () => {
    const db = freshDb();
    const d = drafted();
    await proposeSlackReply(db, addManualTask(db, `帮我回一下 ${REPLY}`), "r1", "好", "", d.draft);
    await proposeSlackReply(db, addManualTask(db, `回他 ${DM}`), "r2", "好", "", d.draft);
    expect(d.calls).toEqual([["C0B39GJKUBV", "1794909984.018279"], ["D0123ABC", null]]);
  });

  test("without a link it says how to get one sent next time", async () => {
    const db = freshDb();
    const id = addManualTask(db, "review https://github.com/acme/web/pull/241");
    expect(getTask(db, id)?.event_id).toBeNull();
    expect(await proposeSlackReply(db, id, "r1", "好", "", drafted().draft)).toContain("派活时带上那条 Slack 消息的链接");
  });

  test("later messages in that thread join the task, and the agent is told where its reply goes", () => {
    const db = freshDb();
    const id = addManualTask(db, `${ROOT} review this`);
    db.prepare(`INSERT INTO events (source, kind, dedupe_key, channel, ts, thread_ts, user_id, user_name, text, received_at)
      VALUES ('slack', 'mention', 'k-later', 'C0B39GJKUBV', ?, '1794909984.018279', 'U2', 'Leo', '<@ME> 看完了吗', 0)`).run((Date.now() / 1000).toFixed(6));
    expect(intakeSlack(db, { thread: null, dm: 2, skipUsers: [], skipChannels: [], workHours: null })).toBe(0);
    expect((db.prepare("SELECT task_id FROM events WHERE dedupe_key = 'k-later'").get() as { task_id: string }).task_id).toBe(id);
    const profile = { manual: {} } as unknown as Profile;
    expect(manualTaskPrompt(profile, getTask(db, id)!, `${ROOT} review this`, true)).toContain("mcp__sidekick__propose 提交 slack.reply");
    expect(manualTaskPrompt(profile, getTask(db, id)!, "review", false)).not.toContain("slack.reply");
  });
});

// Routine replies I said need no review go out on their own, e.g. 「已 approve ✅」 after approving a
// teammate's PR (2026-11-18). The rule is checked in code: sender and exact text, nothing the agent decides.
describe("replies an autoReply rule lets out without me", () => {
  const RULES = [{ from: ["S04GBA1855G", "U0DAVE"], texts: ["已 approve ✅"] }];
  const members = async (g: string) => (g === "S04GBA1855G" ? ["U0CHICO", "U0DAMIAN"] : []);
  const seed = (db: ReturnType<typeof openDb>, userId: string | null) => {
    const ev = Number(db.prepare(`INSERT INTO events (source, kind, dedupe_key, channel, ts, user_id, text, received_at)
      VALUES ('slack', 'dm', ?, 'D1', '1.0', ?, 'https://github.com/AfterShip/x/pull/1 dd', 0)`).run(`k${Math.random()}`, userId).lastInsertRowid);
    db.prepare("INSERT INTO tasks (id, source, kind, title, status, event_id, created_at, updated_at) VALUES ('t1', 'slack', 'dm', 'x', 'running', ?, 0, 0)").run(ev);
  };

  test("someone in a named user group, or named directly, with exactly the rule's text", async () => {
    for (const who of ["U0CHICO", "U0DAVE"]) {
      const db = freshDb();
      seed(db, who);
      expect(await autoReplyAllowed(db, "t1", " 已 approve ✅ ", RULES, members)).toBe(true);
    }
  });

  test("anyone else, any other text, a task given by hand, or no rules: it waits for me", async () => {
    const db = freshDb();
    seed(db, "U0STRANGER");
    expect(await autoReplyAllowed(db, "t1", "已 approve ✅", RULES, members)).toBe(false);
    const db2 = freshDb();
    seed(db2, "U0CHICO");
    expect(await autoReplyAllowed(db2, "t1", "已 approve ✅，顺便说一下……", RULES, members)).toBe(false);
    expect(await autoReplyAllowed(db2, "t1", "已 approve ✅", [], members)).toBe(false);
    const db3 = freshDb();
    seed(db3, null);
    expect(await autoReplyAllowed(db3, "t1", "已 approve ✅", RULES, members)).toBe(false);
  });

  test("a group that cannot be read lets nothing through", async () => {
    const db = freshDb();
    seed(db, "U0CHICO");
    expect(await autoReplyAllowed(db, "t1", "已 approve ✅", RULES, async () => { throw new Error("offline"); })).toBe(false);
  });

  test("allowed: approved on the spot with the rule's note, and sent signed as unreviewed", async () => {
    const db = freshDb();
    seed(db, "U0CHICO");
    expect(await proposeSlackReply(db, "t1", "r1", "已 approve ✅", "", () => "Dr1", true, () => {}, RULE_NOTE)).toContain("autoReply");
    expect(db.prepare("SELECT status, decision_note FROM approvals").get()).toEqual({ status: "approved", decision_note: RULE_NOTE });
    const sent: string[] = [];
    const sender = {
      liveDrafts: async () => new Set<string>(), mineSince: async () => null, sendDraft: async () => {}, deleteDraft: async () => {},
      sendMessage: async (_c: string, _t: string | null, _b: string, blocks?: unknown[]) => void sent.push(JSON.stringify(blocks)),
    };
    await processDecisions(db, () => false, sender as never, undefined, { sign: true });
    expect(sent[0]).toContain(SIGN_AUTO);
  });

  test("the rules handed to the MCP server: unreadable means none", () => {
    expect(autoReplyRules(JSON.stringify(RULES))).toEqual(RULES);
    expect(autoReplyRules("not json")).toEqual([]);
    expect(autoReplyRules(JSON.stringify([{ from: "S1", texts: ["x"] }]))).toEqual([]);
    expect(autoReplyRules(undefined)).toEqual([]);
  });
});

// Three overnight tasks each sat out the 40-minute timeout three times while Claude only retried the
// API (offline or asleep), about two hours each (2026-11-18). Now such a run stops after five minutes
// and the task waits ten, without the attempt counting against it.
describe("a run that cannot reach the API", () => {
  test("only api_retry for a while is a stall; anything else resets it", () => {
    let now = 0;
    const s = apiStall(() => now);
    s.see({ type: "system", subtype: "init" });
    expect(s.stalledFor()).toBe(0);
    s.see({ type: "system", subtype: "api_retry" });
    now = 4 * 60_000;
    s.see({ type: "system", subtype: "api_retry" });
    expect(s.stalledFor()).toBe(4 * 60_000);
    s.see({ type: "assistant" });
    expect(s.stalledFor()).toBe(0);
    s.see({ type: "system", subtype: "api_retry" });
    now = 4 * 60_000 + API_STALL_MS + 1;
    expect(s.stalledFor()).toBeGreaterThan(API_STALL_MS);
  });

  test("the task waits to try again, and the attempt does not count", () => {
    const db = freshDb();
    seedTask(db, "running");
    const later = Date.now() + RETRY_LATER_MS;
    settle(db, "t1", true, later);
    expect(getTask(db, "t1")).toMatchObject({ status: "queued", attempts: 0, not_before: later });
    db.prepare("UPDATE tasks SET status = 'running'").run();
    settle(db, "t1", true);
    expect(getTask(db, "t1")).toMatchObject({ status: "queued", attempts: 1 });
  });
});

describe("a draft I deleted in Slack offers to carry on in Claude", () => {
  test("deleted in the last 15 minutes, on a task with a session; older ones and others are not offered", () => {
    const db = freshDb();
    const now = Date.now();
    for (const [task, session] of [["t1", "s1"], ["t2", null]] as const) {
      db.prepare("INSERT INTO tasks (id, source, kind, title, status, session_id, created_at, updated_at) VALUES (?, 'slack', 'dm', ?, 'done', ?, 0, 0)").run(task, `task ${task}`, session);
    }
    const add = (id: string, task: string, result: string, at: number) =>
      db.prepare("INSERT INTO approvals (id, task_id, run_id, kind, key, payload, status, created_at, result, decided_at) VALUES (?, ?, 'r', 'outbound', ?, '{}', 'denied', 0, ?, ?)").run(id, task, id, result, at);
    add("a1", "t1", DELETED_IN_SLACK, now - 60_000);
    add("a2", "t1", DELETED_IN_SLACK, now - 20 * 60_000);
    add("a3", "t1", SENT_IN_SLACK, now - 60_000);
    add("a4", "t2", DELETED_IN_SLACK, now - 60_000);
    expect(recentlyDeletedDrafts(db, now)).toEqual([{ approvalId: "a1", taskId: "t1", title: "task t1" }]);
  });
});

// A run used to get every tool Claude Code has and all 75 claude.ai connectors: 65.7k tokens of context
// a turn, plus a turn on ToolSearch and one on `cat SKILL.md`. Now a lean set by default (2026-11-18).
describe("what a run is given", () => {
  test("only links slackcli and gh cannot read call for the connectors", () => {
    expect(needsConnectors("review https://github.com/AfterShip/x/pull/1 dd")).toBe(false);
    expect(needsConnectors("看下 https://aftership.slack.com/archives/C1/p1794909984018279")).toBe(false);
    expect(needsConnectors("没有链接")).toBe(false);
    expect(needsConnectors("文案在 <https://app.notion.com/p/automizely/x|这里>")).toBe(true);
    expect(needsConnectors("https://aftership.atlassian.net/browse/APR-1")).toBe(true);
  });

  test("a new session starts lean or with links; a resumed one never loses tools", () => {
    expect(toolSetFor(null, false, "hi")).toBe("lean");
    expect(toolSetFor(null, false, "https://docs.google.com/x")).toBe("links");
    expect(toolSetFor("lean", true, "那你发吧")).toBe("lean");
    expect(toolSetFor("lean", true, "看这个 https://aftership.atlassian.net/browse/X")).toBe("links");
    expect(toolSetFor("links", true, "好")).toBe("links");
    expect(toolSetFor(null, true, "好")).toBeNull(); // a session from before tool sets keeps everything
    expect(toolSetFor("links", false, "hi")).toBe("lean"); // a new session after a hand-off starts afresh
  });

  test("the launch flags for each set", () => {
    const base: LaunchSpec = { cwd: "/w", model: "m", maxTurns: 5, lean: true, allow: [], ask: [], deny: [], timeoutMs: 1 };
    const lean = claudeArgs({ ...base, tools: "Bash,Read,Grep,Glob", strictMcp: true }, "p", { id: "s", resume: false }, "/tmp/m.json");
    expect(lean.join(" ")).toContain("--tools Bash,Read,Grep,Glob");
    expect(lean).toContain("--strict-mcp-config");
    const links = claudeArgs({ ...base, tools: "Bash,Read,Grep,Glob,ToolSearch" }, "p", { id: "s", resume: false }, "/tmp/m.json");
    expect(links).not.toContain("--strict-mcp-config");
    const trial = claudeArgs({ ...base, strictMcp: true }, "p", { id: "s", resume: false });
    expect(trial.join(" ")).toContain('--strict-mcp-config --mcp-config {"mcpServers":{}}');
  });

  test("the workflow skill is in the system prompt, without its front matter", () => {
    const root = mkdtempSync(join(tmpdir(), "sidekick-skill-"));
    mkdirSync(join(root, "skills/s"), { recursive: true });
    writeFileSync(join(root, "skills/s/SKILL.md"), "---\nname: s\ndescription: x\n---\n\n# 处理一条消息\n\n先看决策模型。\n");
    writeFileSync(join(root, "me.md"), "# 我");
    const prompt = systemPrompt({ root, persona: ["me.md"] }, "semi", "skills/s/SKILL.md");
    expect(prompt).toContain("# 处理流程（skills/s/SKILL.md）");
    expect(prompt).toContain("先看决策模型。");
    expect(prompt).not.toContain("description: x");
  });
});

// A decision that is mine (a time, a priority) used to end as "needs you" with no draft. Now the
// agent drafts two or three candidates and I pick one on the card (2026-11-18).
describe("candidate replies", () => {
  test("up to two others, non-empty, not repeating the main text", () => {
    expect(replyOptions(["明天上午给你", " ", "今天下班前", "今天下班前", 3, "下周一"], "今天下班前")).toEqual(["明天上午给你", "下周一"]);
    expect(replyOptions(["a", "b", "c"], "x")).toEqual(["a", "b"]);
    expect(replyOptions(undefined, "x")).toEqual([]);
  });

  test("a card with candidates keeps them all and always waits for me, even in full mode", async () => {
    const db = freshDb();
    seedTask(db, "running", { kind: "mention", channel: "C9", ts: "5.5" });
    const said = await proposeSlackReply(db, "t1", "r1", "今天下班前看完", "要你定时间", () => "Dr1", true, () => {}, AUTO_NOTE, ["明天上午给你"]);
    expect(said).toContain("2 条候选");
    const row = db.prepare("SELECT status, payload FROM approvals").get() as { status: string; payload: string };
    expect(row.status).toBe("pending");
    expect(JSON.parse(row.payload).choices).toEqual(["今天下班前看完", "明天上午给你"]);
    expect(approvalLine({ kind: "outbound", payload: row.payload }, "Leo：review", "")).toContain("另有 1 条候选");
  });
});

describe("facts looked up before a run", () => {
  test("PR links: first ones first, each once, at most three", () => {
    const text = "看下 <https://github.com/a/b/pull/12|#12> 和 https://github.com/a/b/pull/12 还有 https://github.com/c/d.e/pull/3 https://github.com/x/y/pull/4 https://github.com/x/y/pull/5 https://github.com/x/y/issues/6";
    expect(prLinks(text)).toEqual([{ repo: "a/b", number: 12 }, { repo: "c/d.e", number: 3 }, { repo: "x/y", number: 4 }]);
    expect(prLinks("no links")).toEqual([]);
  });

  test("which groups each sender is in, by handle", () => {
    const groups = [{ id: "S1", handle: "team-a", members: ["U1"] }, { id: "S2", handle: null, members: [] }];
    expect(groupLines([{ id: "U1", name: "Ann" }, { id: "U2", name: null }], groups)).toEqual([
      "- 发消息的人 Ann（U1）在 @team-a 里，不在 S2 里。",
      "- 发消息的人 U2（U2）不在 @team-a、S2 里。",
    ]);
    expect(groupLines([{ id: "U1", name: "Ann" }], [])).toEqual([]);
    expect(profileGroups({ autoReply: [{ from: ["S1", "U9"], texts: ["x"] }, { from: ["S1", "S2"], texts: ["y"] }] })).toEqual(["S1", "S2"]);
  });

  test("a PR: state, review decision, and where the user stands", () => {
    const pr = { title: "fix", author: { login: "bob" }, state: "OPEN", isDraft: false, reviewDecision: "REVIEW_REQUIRED",
      reviewRequests: [{ login: "me" }], latestReviews: [{ author: { login: "bot" }, state: "COMMENTED" }] };
    const ref = { repo: "a/b", number: 1 };
    expect(prLine(ref, pr, "me")).toBe("- PR a/b#1「fix」：作者 bob；开着；review 状态：还要 review；使用者还没 review，在待 review 名单里。");
    expect(prLine(ref, { ...pr, state: "MERGED", reviewDecision: "APPROVED", reviewRequests: [], latestReviews: [{ author: { login: "me" }, state: "APPROVED" }] }, "me"))
      .toBe("- PR a/b#1「fix」：作者 bob；已合并；review 状态：已通过；使用者已经 approve 过。");
    expect(prLine(ref, { ...pr, author: { login: "me" }, isDraft: true, reviewDecision: "" }, "me")).toBe("- PR a/b#1「fix」：作者 me（就是使用者自己）；开着，草稿；review 状态：没有要求。");
    expect(prLine(ref, pr, null)).toBe("- PR a/b#1「fix」：作者 bob；开着；review 状态：还要 review。");
  });
});

describe("a muted thread", () => {
  const addEvent = (db: ReturnType<typeof openDb>, e: Partial<EventRow>) =>
    db.prepare(`INSERT INTO events (source, kind, dedupe_key, channel, ts, thread_ts, user_id, user_name, text, received_at)
      VALUES ('slack', ?, ?, ?, ?, ?, 'U1', 'Ann', ?, 0)`).run(e.kind ?? "mention", `k${Math.random()}`, e.channel ?? "C1", e.ts ?? "1.0", e.thread_ts ?? null, e.text ?? "<@ME> 看下");
  const sec = (s: number) => (Date.now() / 1000 + s).toFixed(6);
  const RULES = { thread: 0, dm: 0, skipUsers: [], skipChannels: [], workHours: null }; // no merge window at all
  const only = (db: ReturnType<typeof openDb>) => db.prepare("SELECT * FROM tasks").all() as Array<{ id: string; status: string; outcome: string | null; muted_at: number | null; next_prompt: string | null }>;

  test("keeps every later message in the thread with its task, never reopening it, however late and whatever its status", async () => {
    const db = freshDb();
    addEvent(db, { ts: "5.0" }); // an @ in a channel: replies go to its thread
    intakeSlack(db, RULES);
    const id = only(db)[0].id;
    db.prepare("UPDATE tasks SET status = 'done', updated_at = 0").run();
    mute(db, id);
    addEvent(db, { ts: sec(0), thread_ts: "5.0", text: "<@ME> 还在吗" });
    addEvent(db, { ts: sec(1), thread_ts: "5.0", text: "那我先合了" });
    expect(intakeSlack(db, RULES)).toBe(0);
    expect(only(db)).toMatchObject([{ id, status: "done", next_prompt: null }]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ?").get(id) as { n: number }).n).toBe(3);

    await cancel(db, id);
    addEvent(db, { ts: sec(2), thread_ts: "5.0" });
    expect(intakeSlack(db, RULES)).toBe(0);

    addEvent(db, { ts: sec(3) }); // a new @ in the same channel is another conversation
    expect(intakeSlack(db, RULES)).toBe(1);
  });

  test("muting stops work in progress but keeps reply cards waiting; unmuting lets the next message in", () => {
    const db = freshDb();
    addEvent(db, { kind: "dm", channel: "D1", ts: sec(0), thread_ts: "4.0" }); // a thread in a DM
    intakeSlack(db, RULES);
    const id = only(db)[0].id;
    mute(db, id);
    expect(only(db)[0]).toMatchObject({ status: "closed", outcome: "muted" });

    const db2 = freshDb();
    addEvent(db2, { ts: "5.0" });
    intakeSlack(db2, RULES);
    const id2 = only(db2)[0].id;
    db2.prepare("UPDATE tasks SET status = 'needs_approval'").run();
    db2.prepare("INSERT INTO approvals (id, task_id, kind, key, status, payload, created_at) VALUES ('a1', ?, 'outbound', 'k1', 'pending', '{}', 0)").run(id2);
    mute(db2, id2);
    expect(only(db2)[0].status).toBe("needs_approval");
    expect(db2.prepare("SELECT status FROM approvals").get()).toEqual({ status: "pending" });

    unmute(db2, id2);
    db2.prepare("UPDATE tasks SET status = 'done'").run();
    addEvent(db2, { ts: sec(1), thread_ts: "5.0", text: "合了吗" });
    intakeSlack(db2, { ...RULES, thread: null });
    expect(only(db2)[0]).toMatchObject({ status: "queued", muted_at: null });
  });

  test("only a thread can be muted: a DM outside threads would mute the person", () => {
    const db = freshDb();
    addEvent(db, { kind: "dm", channel: "D1", ts: sec(0) });
    intakeSlack(db, RULES);
    expect(() => mute(db, only(db)[0].id)).toThrow();
    expect(taskDetail(db, only(db)[0].id)!.task.thread).toBe(false);
  });
});
