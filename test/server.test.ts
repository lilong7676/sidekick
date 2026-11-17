import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile } from "../src/config.ts";
import { getTask, openDb } from "../src/db.ts";
import type { DoctorReport } from "../src/doctor.ts";
import type { SlackStatus } from "../src/realtime.ts";
import { startServer } from "../src/server.ts";

const dir = mkdtempSync(join(tmpdir(), "sidekick-server-"));
const db = openDb(dir);
const profile = { name: "test", root: dir, stateDir: dir, agent: { model: "m" }, slack: { pollMinutes: 5 }, notify: { macos: true, slackSelfDm: false }, persona: ["sidekick/me.md"] } as unknown as Profile;
const runtimeFile = join(dir, "runtime.json");
const settingsFile = join(dir, "settings.json");
const slack: SlackStatus = {
  enabled: true,
  realtime: { state: "fallback", since: 1, reason: "3 分钟没连上", retryAt: 2 },
  pollMinutes: 5,
  collectingSince: null,
  lastCollect: { at: 1, ms: 1200, added: 0 },
  nextCollectAt: 300_001,
};
let settingsChanged = 0;
let retried = 0;
let last: DoctorReport | null = null;
const doctor = {
  report: () => last,
  runNow: async () => (last = { at: 5, checks: [{ id: "slack-login", name: "Slack 登录", status: "fail" as const, detail: "登录失效", command: "x" }] }),
};
const srv = startServer({
  profile, db, port: 0, runtimeFile, settingsFile,
  slack: () => slack,
  doctor,
  onSettingsChanged: () => { settingsChanged += 1; },
  realtimeRetry: () => { retried += 1; },
});
const base = `http://127.0.0.1:${srv.port}`;
const auth = { Authorization: `Bearer ${srv.token}` };
afterAll(() => srv.stop());

describe("api auth", () => {
  test("runtime file is private", () => {
    expect(statSync(runtimeFile).mode & 0o777).toBe(0o600);
  });

  test("no token, wrong token → 401", async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/api/state`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });

  test("foreign Host header → 403 (DNS rebinding)", async () => {
    const res = await fetch(`${base}/api/state`, { headers: { ...auth, Host: `evil.example:${srv.port}` } });
    expect(res.status).toBe(403);
  });

  test("with token: state, dispatch, detail, cancel", async () => {
    expect((await fetch(`${base}/api/state`, { headers: auth })).status).toBe(200);
    const created = await fetch(`${base}/api/tasks`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ text: "测试派活" }) });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const detail = (await (await fetch(`${base}/api/tasks/${id}`, { headers: auth })).json()) as { task: { status: string } };
    expect(detail.task.status).toBe("queued");
    expect((await fetch(`${base}/api/tasks/${id}/cancel`, { method: "POST", headers: auth })).status).toBe(200);
    expect(getTask(db, id)!.status).toBe("cancelled");
  });

  test("input is validated", async () => {
    const post = (path: string, body: string) => fetch(`${base}${path}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body });
    expect((await post("/api/tasks", "{}")).status).toBe(400);
    expect((await post("/api/tasks", JSON.stringify({ text: "x".repeat(9000) }))).status).toBe(400);
    expect((await post("/api/tasks", "not json")).status).toBe(400);
    expect((await fetch(`${base}/api/tasks/..%2F..%2Fetc`, { headers: auth })).status).toBe(400);
  });

  test("the page itself loads without a token (it holds no data)", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="app">');
  });
});

describe("slack status, settings, diagnosis", () => {
  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { ...auth, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  test("state carries the Slack status and a diagnosis summary", async () => {
    const before = (await (await send("GET", "/api/state")).json()) as { slack: SlackStatus; doctor: unknown };
    expect(before.slack.realtime.state).toBe("fallback");
    expect(before.doctor).toBeNull();
    const report = (await (await send("POST", "/api/doctor")).json()) as DoctorReport;
    expect(report.checks[0].status).toBe("fail");
    const after = (await (await send("GET", "/api/state")).json()) as { doctor: { fail: number; warn: number } };
    expect(after.doctor).toMatchObject({ fail: 1, warn: 0 });
    expect(((await (await send("GET", "/api/doctor")).json()) as DoctorReport).at).toBe(5);
  });

  test("realtime and poll interval are saved and applied at once", async () => {
    const res = await send("PUT", "/api/settings", { realtime: true, pollMinutes: 2 });
    expect(res.status).toBe(200);
    const view = (await res.json()) as { realtime: boolean; pollMinutes: number; defaults: { pollMinutes: number } };
    expect(view).toMatchObject({ realtime: true, pollMinutes: 2, defaults: { pollMinutes: 5 } });
    expect(settingsChanged).toBe(1);
    expect((await send("PUT", "/api/settings", { realtime: "yes" })).status).toBe(400);
    expect((await send("PUT", "/api/settings", { pollMinutes: 0 })).status).toBe(400);
    expect((await send("PUT", "/api/settings", { pollMinutes: "5" })).status).toBe(400);
    const cleared = (await (await send("PUT", "/api/settings", { pollMinutes: null })).json()) as { pollMinutes: number | null; realtime: boolean };
    expect(cleared).toMatchObject({ pollMinutes: null, realtime: true });
    expect((await send("POST", "/api/realtime/retry")).status).toBe(200);
    expect(retried).toBe(1);
  });

  test("how long a conversation keeps its task: thread no limit and DM 2 h by default, both settable", async () => {
    expect(await (await send("GET", "/api/settings")).json()).toMatchObject({ threadMergeHours: null, dmMergeHours: 2 });
    expect(await (await send("PUT", "/api/settings", { threadMergeHours: 24, dmMergeHours: null })).json()).toMatchObject({ threadMergeHours: 24, dmMergeHours: null });
    expect((await send("PUT", "/api/settings", { dmMergeHours: "2" })).status).toBe(400);
    expect((await send("PUT", "/api/settings", { dmMergeHours: -1 })).status).toBe(400);
  });
});

describe("persona endpoints", () => {
  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { ...auth, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  test("read, create, conflict, and only the profile's files", async () => {
    const view = (await (await send("GET", "/api/persona")).json()) as { files: Array<{ path: string; exists: boolean; mtime: number | null }>; template: string };
    expect(view.files).toEqual([{ path: "sidekick/me.md", exists: false, content: "", mtime: null }] as never);
    expect(view.template).toContain("## 红线");
    const created = await send("PUT", "/api/persona", { path: "sidekick/me.md", content: "我负责结账页", baseMtime: null });
    expect(created.status).toBe(200);
    const { mtime } = (await created.json()) as { mtime: number };
    expect((await send("PUT", "/api/persona", { path: "sidekick/me.md", content: "x", baseMtime: null })).status).toBe(409);
    expect((await send("PUT", "/api/persona", { path: "sidekick/me.md", content: "我负责结账页和购物车", baseMtime: mtime })).status).toBe(200);
    expect((await send("PUT", "/api/persona", { path: "../../etc/x.md", content: "x", baseMtime: null })).status).toBe(400);
    expect((await send("PUT", "/api/persona", { path: "sidekick/me.md", content: 1, baseMtime: null })).status).toBe(400);
    expect((await send("POST", "/api/persona/trials", { eventId: 1 })).status).toBe(404); // no trials in this server
    expect(((await (await send("GET", "/api/persona/samples")).json()) as unknown[]).length).toBe(0);
  });
});

describe("delete endpoints", () => {
  test("DELETE a task, then clear finished ones", async () => {
    const mk = async (text: string) => ((await (await fetch(`${base}/api/tasks`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ text }) })).json()) as { id: string }).id;
    const a = await mk("删我");
    expect((await fetch(`${base}/api/tasks/${a}`, { method: "DELETE", headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/tasks/${a}`, { headers: auth })).status).toBe(404);
    const b = await mk("取消再清空");
    await fetch(`${base}/api/tasks/${b}/cancel`, { method: "POST", headers: auth });
    const res = (await (await fetch(`${base}/api/finished-tasks`, { method: "DELETE", headers: auth })).json()) as { deleted: number };
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(getTask(db, b)).toBeNull();
  });
});
