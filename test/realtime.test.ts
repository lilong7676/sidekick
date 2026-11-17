import { afterEach, describe, expect, test } from "bun:test";
import { AutoDoctor, realtimeCheck, type Check, type DoctorReport } from "../src/doctor.ts";
import type { ListenerOptions, ListenerStatus } from "../src/listener.ts";
import { setLang } from "../src/i18n.ts";
import { fallbackReason, freshHealth, observe, POLICY, Realtime, type SlackStatus } from "../src/realtime.ts";

const LOGIN_EXPIRED = "Slack 登录失效";
const FORCE_RELOAD = "Slack 不再接受 slackcli 用的网页版版本（force_reload）";

const MIN = 60_000;

describe("realtime fallback policy", () => {
  afterEach(() => setLang("zh"));
  const hello: ListenerStatus = { type: "hello" };
  const drop: ListenerStatus = { type: "disconnected", error: "closed (code 1006)" };

  test("failed attempts during a short blip do not count as drops", () => {
    let h = freshHealth(0);
    for (const t of [1, 2, 4, 8, 16]) h = observe(h, drop, t * 1000); // listen's own backoff, never connected
    expect(h.drops).toEqual([]);
    expect(fallbackReason(h, 20_000)).toBeNull();
    h = observe(h, hello, 30_000);
    expect(h.downSince).toBeNull();
    expect(fallbackReason(h, 10 * MIN)).toBeNull();
  });

  test("three drops of a live connection within 10 minutes", () => {
    let h = freshHealth(0);
    for (const t of [1, 3, 5]) {
      h = observe(h, hello, t * MIN);
      h = observe(h, drop, t * MIN + 1000);
    }
    expect(fallbackReason(h, 5 * MIN + 2000)).toBe("10 分钟内断了 3 次");
    // the same three drops spread over 30 minutes are fine
    let slow = freshHealth(0);
    for (const t of [1, 12, 24]) {
      slow = observe(slow, hello, t * MIN);
      slow = observe(slow, drop, t * MIN + 1000);
      slow = observe(slow, hello, t * MIN + 5000);
    }
    expect(fallbackReason(slow, 25 * MIN)).toBeNull();
  });

  test("not connected for 3 minutes, with the last error", () => {
    let h = observe(freshHealth(0), { type: "disconnected", error: "socket error" }, 1000);
    expect(fallbackReason(h, 2 * MIN)).toBeNull();
    expect(fallbackReason(h, 3 * MIN)).toBe("3 分钟没连上（socket error）");
  });

  test("login refused and force_reload give up at once", () => {
    const login = observe(freshHealth(0), { type: "exit", code: 2, error: "Slack refused the login" }, 1000);
    expect(fallbackReason(login, 1000)).toBe(LOGIN_EXPIRED);
    const reload = observe(freshHealth(0), { type: "disconnected", error: "slack error before hello: force_reload (code 1)" }, 1000);
    expect(fallbackReason(reload, 1000)).toBe(FORCE_RELOAD);
  });

  test("the reason is in the interface language", () => {
    setLang("en");
    const h = observe(freshHealth(0), { type: "disconnected", error: "socket error" }, 1000);
    expect(fallbackReason(h, 3 * MIN)).toBe("Not connected for 3 min (socket error)");
    const login = observe(freshHealth(0), { type: "exit", code: 2, error: "" }, 1000);
    expect(fallbackReason(login, 1000)).toBe("Slack sign-in expired");
  });
});

/** A Realtime wired to a fake listener and a fake clock. */
function harness() {
  let now = 0;
  const started: ListenerOptions[] = [];
  let stopped = 0;
  const fallbacks: string[] = [];
  const rt = new Realtime({
    me: () => "UME",
    onCollect: () => {},
    onFallback: (r) => fallbacks.push(r),
    start: (o) => {
      started.push(o);
      return { stop: () => { stopped += 1; } };
    },
    now: () => now,
  });
  return {
    rt,
    started,
    fallbacks,
    stopped: () => stopped,
    at: (t: number) => { now = t; },
    emit: (s: ListenerStatus) => started.at(-1)!.onStatus(s),
  };
}

describe("Realtime", () => {
  test("off by default, starts when enabled, stops when disabled", () => {
    const h = harness();
    h.rt.update(false);
    expect(h.rt.view().state).toBe("off");
    expect(h.started.length).toBe(0);
    h.rt.update(true);
    expect(h.rt.view().state).toBe("connecting");
    h.emit({ type: "hello" });
    expect(h.rt.view().state).toBe("connected");
    h.rt.update(true); // ticks do not restart a running listener
    expect(h.started.length).toBe(1);
    h.rt.update(false);
    expect(h.rt.view().state).toBe("off");
    expect(h.stopped()).toBe(1);
  });

  test("falls back, stays on polling for 15 minutes, then retries; announces once per episode", () => {
    const h = harness();
    h.rt.update(true);
    h.at(3 * MIN);
    h.rt.update(true); // a tick notices nothing ever connected
    const v = h.rt.view();
    expect(v.state).toBe("fallback");
    expect(v.state === "fallback" && v.retryAt).toBe(18 * MIN);
    expect(h.stopped()).toBe(1);
    expect(h.fallbacks).toEqual(["3 分钟没连上"]);

    h.at(10 * MIN);
    h.rt.update(true);
    expect(h.started.length).toBe(1); // still waiting

    h.at(18 * MIN);
    h.rt.update(true);
    expect(h.started.length).toBe(2); // retried
    h.emit({ type: "exit", code: 2, error: "" });
    expect(h.rt.view()).toMatchObject({ state: "fallback", reason: LOGIN_EXPIRED, fatal: "login_expired" });
    expect(h.fallbacks.length).toBe(1); // the failed retry is the same episode

    // a retry that then stays up for 10 minutes ends the episode
    h.at(33 * MIN);
    h.rt.update(true);
    h.emit({ type: "hello" });
    h.at(44 * MIN);
    h.rt.update(true);
    h.emit({ type: "disconnected", error: "force_reload" });
    expect(h.fallbacks).toEqual(["3 分钟没连上", FORCE_RELOAD]);
  });

  test("retry now skips the wait; lines from a stopped listener are ignored", () => {
    const h = harness();
    h.rt.update(true);
    const old = h.started[0];
    h.emit({ type: "exit", code: 2, error: "" });
    expect(h.rt.view().state).toBe("fallback");
    h.rt.retryNow();
    expect(h.started.length).toBe(2);
    old.onStatus({ type: "hello" });
    expect(h.rt.view().state).toBe("connecting");
  });
});

describe("the realtime check in diagnostics", () => {
  afterEach(() => setLang("zh"));
  const status = (fatal?: "login_expired" | "force_reload"): SlackStatus => ({
    enabled: true,
    realtime: { state: "fallback", since: 0, reason: "whatever language it was written in", retryAt: new Date(2026, 10, 17, 16, 27).getTime(), ...(fatal ? { fatal } : {}) },
    pollMinutes: 5,
    collectingSince: null,
    lastCollect: null,
    nextCollectAt: null,
  });

  test("an expired sign-in is told by its code, not by its text, and says how to sign in", () => {
    const zh = realtimeCheck(true, status("login_expired"), 0);
    expect(zh).toMatchObject({ status: "fail", detail: "已回退轮询：whatever language it was written in；16:27 再试" });
    expect(zh.fix).toContain("「登录 Slack」");
    expect(zh.command).toContain("auth login-auto");
    expect(realtimeCheck(true, status(), 0).status).toBe("warn");
  });

  test("in English", () => {
    setLang("en");
    const en = realtimeCheck(true, status("login_expired"), 0);
    expect(en).toMatchObject({ status: "fail", detail: "Fell back to polling: whatever language it was written in; retrying at 16:27" });
    expect(en.fix).toBe('In the panel, go to Settings → Slack and click "Sign in to Slack". From the command line, run this');
    expect(realtimeCheck(false, undefined, 0).detail).toBe("Off, polling only");
    expect(realtimeCheck(true, status("force_reload"), 0).fix).toContain("Upgrade the slackcli sidekick pins");
  });
});

describe("AutoDoctor", () => {
  const report = (checks: Partial<Check>[], at = 0): DoctorReport => ({
    at,
    checks: checks.map((c, i) => ({ id: `c${i}`, name: `检查${i}`, status: "ok", detail: "", ...c })),
  });

  test("first run a minute after start, then every 6 hours; soon() pulls it in", async () => {
    let runs = 0;
    const d = new AutoDoctor(async () => { runs += 1; return report([], runs * 1000); }, () => {}, 0);
    d.tick(30_000);
    expect(runs).toBe(0);
    d.tick(60_000);
    await Bun.sleep(0);
    expect(runs).toBe(1);
    d.tick(2 * 3600_000);
    expect(runs).toBe(1);
    d.soon(); // a collect failed: at most every 30 minutes
    d.tick(10 * MIN);
    await Bun.sleep(0);
    expect(runs).toBe(1);
    d.tick(31 * MIN);
    await Bun.sleep(0);
    expect(runs).toBe(2);
  });

  test("announces a failing check once, again only after it recovered; manual runs never announce", async () => {
    const results = [
      report([{ status: "fail" }, { status: "warn" }]),
      report([{ status: "fail" }]),
      report([]),
      report([{ status: "fail" }]),
      report([{ status: "fail" }, { status: "fail" }]),
    ];
    const announced: string[][] = [];
    const d = new AutoDoctor(async () => results.shift()!, (bad) => announced.push(bad.map((c) => c.id)));
    await d.runNow();
    await d.runNow();
    await d.runNow();
    await d.runNow();
    expect(announced).toEqual([["c0"], ["c0"]]);
    await d.runNow(true);
    expect(announced.length).toBe(2);
    expect(d.report()!.checks.length).toBe(2);
  });
});
