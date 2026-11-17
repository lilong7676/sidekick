import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_NOTE, decide, processDecisions } from "../src/approvals.ts";
import { getTask, openDb } from "../src/db.ts";
import { proposeSlackReply } from "../src/mcp.ts";
import { cancel, clearFinished, deleteTask, stateSummary } from "../src/queries.ts";
import { effectiveMode, loadSettings, setWorkspaceRoot, timetableSwitch, updateSettings } from "../src/settings.ts";
import { writeMcpConfig } from "../src/runner.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "sidekick-settings-"));

describe("settings", () => {
  /** Defaults of the settings added later, part of every whole-object comparison below. */
  const MERGE = { threadMergeHours: null, dmMergeHours: 2, continueIn: "terminal" as const, skipUsers: [], skipChannels: [], workHours: null, autoFull: null, signReplies: true };

  test("defaults to semi when there is no file", async () => {
    expect(loadSettings(join(tmp(), "none.json"))).toEqual({ mode: "semi", realtime: false, ...MERGE });
  });

  test("a broken file never turns on full mode", async () => {
    const f = join(tmp(), "s.json");
    writeFileSync(f, '{"mode":"full","model":"gpt-5"}');
    expect(loadSettings(f).mode).toBe("semi");
  });

  test("patches are validated; null resets to the profile default", async () => {
    const f = join(tmp(), "s.json");
    updateSettings({ mode: "full", model: "claude-sonnet-5-5", effort: "high" }, f);
    expect(loadSettings(f)).toEqual({ mode: "full", model: "claude-sonnet-5-5", effort: "high", realtime: false, ...MERGE });
    updateSettings({ model: null }, f);
    expect(loadSettings(f).model).toBeUndefined();
    expect(() => updateSettings({ mode: "yolo" }, f)).toThrow();
    expect(() => updateSettings({ effort: "ultra" }, f)).toThrow();
    expect(loadSettings(f).mode).toBe("full"); // a rejected patch changes nothing
  });

  test("realtime is opt-in; poll interval is 1–60 minutes and null clears it", async () => {
    const f = join(tmp(), "s.json");
    writeFileSync(f, '{"mode":"full"}');
    expect(loadSettings(f).realtime).toBe(false); // a file from before the switch keeps polling only
    updateSettings({ realtime: true, pollMinutes: 2 }, f);
    expect(loadSettings(f)).toEqual({ mode: "full", realtime: true, pollMinutes: 2, ...MERGE });
    expect(() => updateSettings({ pollMinutes: 0 }, f)).toThrow();
    expect(() => updateSettings({ pollMinutes: 1.5 }, f)).toThrow();
    expect(() => updateSettings({ pollMinutes: 61 }, f)).toThrow();
    expect(() => updateSettings({ realtime: "yes" }, f)).toThrow();
    updateSettings({ pollMinutes: null }, f);
    expect(loadSettings(f)).toEqual({ mode: "full", realtime: true, ...MERGE });
  });

  test("how long a conversation keeps its task: thread no limit, DM 2 h by default; null is no limit", async () => {
    const f = join(tmp(), "s.json");
    expect(loadSettings(f)).toMatchObject({ threadMergeHours: null, dmMergeHours: 2 });
    updateSettings({ threadMergeHours: 24, dmMergeHours: 0 }, f);
    expect(loadSettings(f)).toMatchObject({ threadMergeHours: 24, dmMergeHours: 0 });
    updateSettings({ dmMergeHours: null }, f);
    expect(loadSettings(f).dmMergeHours).toBeNull();
    expect(() => updateSettings({ dmMergeHours: -1 }, f)).toThrow();
    expect(() => updateSettings({ threadMergeHours: 1000 }, f)).toThrow();
  });

  test("notifications follow the profile until switched here; null hands it back", async () => {
    const f = join(tmp(), "s.json");
    expect(loadSettings(f).notifyMacos).toBeUndefined();
    updateSettings({ notifyMacos: false, notifySlackDm: true }, f);
    expect(loadSettings(f)).toMatchObject({ notifyMacos: false, notifySlackDm: true });
    updateSettings({ notifyMacos: null }, f);
    expect(loadSettings(f).notifyMacos).toBeUndefined();
    expect(() => updateSettings({ notifySlackDm: "yes" }, f)).toThrow();
  });

  test("what not to work on: Slack ids only, and working hours that make sense", async () => {
    const f = join(tmp(), "s.json");
    updateSettings({ skipUsers: ["U123ABC"], skipChannels: ["C42"], workHours: { start: 9, end: 20, weekends: false } }, f);
    expect(loadSettings(f)).toMatchObject({ skipUsers: ["U123ABC"], skipChannels: ["C42"], workHours: { start: 9, end: 20, weekends: false } });
    expect(() => updateSettings({ skipUsers: ["bob"] }, f)).toThrow();
    expect(() => updateSettings({ skipChannels: ["D1"] }, f)).toThrow(); // DMs are people, not channels
    expect(() => updateSettings({ workHours: { start: 20, end: 9, weekends: false } }, f)).toThrow();
    updateSettings({ workHours: null }, f);
    expect(loadSettings(f).workHours).toBeNull();
  });

  test("full mode on a timetable: windows on weekdays, a hand-set full mode wins", () => {
    const lunch = { windows: [{ start: 12 * 60, end: 13 * 60 + 30 }, { start: 18 * 60, end: 19 * 60 }], weekends: false };
    const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m); // 2026-11-16 is a Monday
    expect(effectiveMode({ mode: "semi", autoFull: lunch }, at(17, 12, 30))).toEqual({ mode: "full", scheduled: true, until: at(17, 13, 30).getTime() });
    expect(effectiveMode({ mode: "semi", autoFull: lunch }, at(17, 13, 30)).mode).toBe("semi"); // the end is not in it
    expect(effectiveMode({ mode: "semi", autoFull: lunch }, at(17, 18, 5)).until).toBe(at(17, 19).getTime());
    expect(effectiveMode({ mode: "semi", autoFull: lunch }, at(21, 12, 30)).mode).toBe("semi"); // Saturday
    expect(effectiveMode({ mode: "semi", autoFull: { ...lunch, weekends: true } }, at(21, 12, 30)).mode).toBe("full");
    expect(effectiveMode({ mode: "full", autoFull: lunch }, at(17, 9))).toEqual({ mode: "full", scheduled: false, until: null });
    expect(effectiveMode({ mode: "semi", autoFull: null }, at(17, 12, 30)).mode).toBe("semi");
  });

  test("only a switch made by the timetable is announced, not one made by hand", () => {
    const lunch = { windows: [{ start: 12 * 60, end: 13 * 60 + 30 }], weekends: false };
    const noon = new Date(2026, 10, 17, 12, 0);
    const semi = { manual: "semi" as const, mode: "semi" as const };
    const r = timetableSwitch(semi, { mode: "semi", autoFull: lunch }, noon);
    expect(r.announce?.mode).toBe("full");
    expect(timetableSwitch(r.seen, { mode: "semi", autoFull: lunch }, new Date(2026, 10, 17, 12, 1)).announce).toBeNull(); // once
    expect(timetableSwitch(r.seen, { mode: "semi", autoFull: lunch }, new Date(2026, 10, 17, 13, 30)).announce?.mode).toBe("semi");
    expect(timetableSwitch(semi, { mode: "full", autoFull: null }, noon).announce).toBeNull(); // by hand
  });

  test("timetable windows must make sense", () => {
    const f = join(tmp(), "s.json");
    updateSettings({ autoFull: { windows: [{ start: 720, end: 810 }], weekends: false } }, f);
    expect(loadSettings(f).autoFull).toEqual({ windows: [{ start: 720, end: 810 }], weekends: false });
    expect(() => updateSettings({ autoFull: { windows: [{ start: 810, end: 720 }], weekends: false } }, f)).toThrow();
    expect(() => updateSettings({ autoFull: { windows: [], weekends: false } }, f)).toThrow();
    expect(() => updateSettings({ autoFull: { windows: Array(7).fill({ start: 1, end: 2 }), weekends: false } }, f)).toThrow();
  });

  test("a run carries the mode it started in to the approval tool", () => {
    const path = writeMcpConfig(tmp(), "r1", { dbPath: "/db", taskId: "t1", runId: "r1", waitMs: 1, profileRoot: "/w", mode: "full" });
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.sidekick.env.SIDEKICK_MODE).toBe("full");
  });

  test("where to continue a task: terminal by default, or the desktop app", async () => {
    const f = join(tmp(), "s.json");
    expect(loadSettings(f).continueIn).toBe("terminal");
    updateSettings({ continueIn: "desktop" }, f);
    expect(loadSettings(f).continueIn).toBe("desktop");
    expect(() => updateSettings({ continueIn: "vscode" }, f)).toThrow();
  });

  test("workspace folder must hold a profile", async () => {
    const dir = tmp();
    const cfg = join(dir, "config.yaml");
    expect(() => setWorkspaceRoot(dir, cfg)).toThrow(/profile\.yaml/);
    expect(() => setWorkspaceRoot("relative/path", cfg)).toThrow(/绝对路径/);
    mkdirSync(join(dir, "sidekick"));
    writeFileSync(join(dir, "sidekick/profile.yaml"), "x: 1\n");
    expect(setWorkspaceRoot(dir, cfg)).toBe(dir);
    expect(readFileSync(cfg, "utf8")).toContain(JSON.stringify(dir));
  });
});

function seed(status: string, withEvent = true) {
  const dir = tmp();
  const db = openDb(dir);
  let eventId: number | null = null;
  if (withEvent) {
    eventId = Number(db.prepare(`INSERT INTO events (source, kind, dedupe_key, channel, ts, text, received_at)
      VALUES ('slack', 'dm', 'k1', 'D1', '1.0', 'hi', 0)`).run().lastInsertRowid);
  }
  db.prepare("INSERT INTO tasks (id, source, kind, title, status, event_id, created_at, updated_at) VALUES ('t1', 'slack', 'dm', 'x', ?, ?, 0, 0)").run(status, eventId);
  if (eventId) db.prepare("UPDATE events SET task_id = 't1'").run();
  return { db, dir };
}

describe("full mode", () => {
  test("a reply proposed in full mode is approved on the spot and marked as automatic", async () => {
    const { db } = seed("running");
    await proposeSlackReply(db, "t1", "r1", "收到", "", () => "Dr1", true);
    const a = db.prepare("SELECT status, decision_note, decided_at FROM approvals").get() as { status: string; decision_note: string; decided_at: number };
    expect(a.status).toBe("approved");
    expect(a.decision_note).toBe(AUTO_NOTE);
    expect(a.decided_at).toBeGreaterThan(0);
  });

  test("semi mode still waits for me", async () => {
    const { db } = seed("running");
    await proposeSlackReply(db, "t1", "r1", "收到", "", () => "Dr1", false);
    expect((db.prepare("SELECT status FROM approvals").get() as { status: string }).status).toBe("pending");
  });
});

describe("stopping and deleting", () => {
  test("cancel stops the live claude process right away", async () => {
    const { db } = seed("running");
    const sleeper = Bun.spawn(["sleep", "30"]);
    db.prepare("INSERT INTO runs (id, task_id, stage, pid, started_at) VALUES ('r1', 't1', 'agent', ?, 0)").run(sleeper.pid);
    expect((await cancel(db, "t1", () => {})).stopped).toBe(1);
    expect(await sleeper.exited).not.toBe(0);
    expect(getTask(db, "t1")!.status).toBe("cancelled");
    expect((db.prepare("SELECT error FROM runs").get() as { error: string }).error).toBe("cancelled");
  });

  test("cancel closes the pending reply and its Slack draft, so it neither waits for me nor can be sent", async () => {
    const { db } = seed("needs_approval");
    await proposeSlackReply(db, "t1", "r1", "收到", "", () => "Dr7", false);
    expect(stateSummary(db).pendingApprovals).toBe(1);
    const discarded: string[] = [];
    expect((await cancel(db, "t1", (id) => { discarded.push(id); })).closed).toBe(1);
    expect(discarded).toEqual(["Dr7"]);
    const a = db.prepare("SELECT id, status, result FROM approvals").get() as { id: string; status: string; result: string };
    expect([a.status, a.result]).toEqual(["denied", "discarded: task cancelled"]);
    expect(stateSummary(db)).toMatchObject({ pendingApprovals: 0, attention: 0 });
    expect(() => decide(db, a.id, "approved")).toThrow();
    const sent: string[] = [];
    await processDecisions(db, () => false, { sendDraft: (d) => { sent.push(d); }, deleteDraft: () => {}, sendMessage: (c) => { sent.push(c); }, liveDrafts: () => null, mineSince: () => null });
    expect(sent).toEqual([]);
    expect(getTask(db, "t1")!.status).toBe("cancelled");
  });

  test("delete removes records, logs and the Slack draft, but keeps the event as dedupe memory", async () => {
    const { db, dir } = seed("needs_approval");
    const log = join(dir, "r1.jsonl");
    writeFileSync(log, "{}\n");
    db.prepare("INSERT INTO runs (id, task_id, stage, started_at, ended_at, log_path) VALUES ('r1', 't1', 'agent', 0, 1, ?)").run(log);
    await proposeSlackReply(db, "t1", "r1", "收到", "", () => "Dr9", false);
    const discarded: string[] = [];
    await deleteTask(db, "t1", (id) => { discarded.push(id); });
    expect(discarded).toEqual(["Dr9"]);
    expect(getTask(db, "t1")).toBeNull();
    expect(existsSync(log)).toBe(false);
    for (const t of ["runs", "approvals"]) expect((db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT task_id FROM events").get() as { task_id: string }).task_id).toBe("deleted");
  });

  test("clear finished only touches finished tasks", async () => {
    const { db } = seed("done", false);
    db.prepare("INSERT INTO tasks (id, source, kind, title, status, created_at, updated_at) VALUES ('t2', 'manual', 'manual', 'y', 'needs_me', 0, 0)").run();
    expect(await clearFinished(db, () => {})).toBe(1);
    expect(getTask(db, "t1")).toBeNull();
    expect(getTask(db, "t2")!.status).toBe("needs_me");
  });
});
