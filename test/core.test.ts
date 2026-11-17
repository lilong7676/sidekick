import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_NOTE, DELETED_IN_SLACK, processDecisions, decide, reconcileDrafts, replyBlocks, SENT_IN_SLACK, SIGN_APPROVED, SIGN_AUTO } from "../src/approvals.ts";
import { getTask, openDb, type EventRow } from "../src/db.ts";
import { decidePermission, PENDING_MESSAGE, proposeSlackReply, replyTarget } from "../src/mcp.ts";
import { claudeArgs, takeoverArgs, type LaunchSpec } from "../src/runner.ts";
import { pickSlackMessages, type UnreadRich } from "../src/slack.ts";
import { ENGINE_DENY, sessionFor, settle } from "../src/handle.ts";
import { continueInClaude, processNow, slackPeople } from "../src/queries.ts";
import { approvalLine } from "../src/notify.ts";
import { setLang } from "../src/i18n.ts";
import { Database } from "bun:sqlite";
import { intakeSlack } from "../src/intake.ts";
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
    addEvent(db, { ts: at(1.5), text: "欧克" });
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
    addEvent(db, { ts: at(0) });
    intakeSlack(db, hours, night);
    expect(db.prepare("SELECT not_before FROM tasks").get()).toEqual({ not_before: nine });
    settle(db, "done");
    addEvent(db, { ts: at(0.1) });
    intakeSlack(db, hours, night);
    expect(db.prepare("SELECT status, not_before FROM tasks").get()).toEqual({ status: "queued", not_before: nine });
    addEvent(db, { kind: "mention", channel: "C1", ts: at(0.2) });
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
