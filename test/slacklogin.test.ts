import { afterEach, describe, expect, test } from "bun:test";
import { setLang } from "../src/i18n.ts";
import { SlackLogin } from "../src/slacklogin.ts";
import type { ProcessResult } from "../src/util.ts";

/** A login that finishes when told to, counting how often it was started. */
const controlled = () => {
  let finish: (r: ProcessResult) => void = () => {};
  const calls = { n: 0 };
  const run = () => {
    calls.n += 1;
    return new Promise<ProcessResult>((resolve) => { finish = resolve; });
  };
  return { run, calls, finish: (r: ProcessResult) => finish(r) };
};
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("signing in to Slack from the panel", () => {
  test("one login at a time; on success the daemon is told", async () => {
    const c = controlled();
    let signedIn = 0;
    const login = new SlackLogin(() => { signedIn += 1; }, c.run);
    expect(login.view().state).toBe("idle");
    expect(login.start().state).toBe("running");
    expect(login.start().state).toBe("running"); // a second click waits for the first
    expect(c.calls.n).toBe(1);
    c.finish({ code: 0, stdout: "✔ Signed in to acme", stderr: "" });
    await settle();
    expect(login.view()).toMatchObject({ state: "ok", message: "已登录 Slack。" });
    expect(signedIn).toBe(1);
  });

  test("a failure says why, in slackcli's last words, without spinner or colour noise", async () => {
    const c = controlled();
    const login = new SlackLogin(() => { throw new Error("must not be called"); }, c.run);
    login.start();
    c.finish({ code: 1, stdout: "", stderr: "- Waiting for sign-in...\n\x1b[31mTimed out after 300s waiting for sign-in\x1b[0m\n" });
    await settle();
    expect(login.view()).toMatchObject({ state: "failed", message: "没登录成功：Timed out after 300s waiting for sign-in" });
    expect(login.start().state).toBe("running"); // and it can be tried again
  });

  test("a Mac with no Chromium-family browser is told what to install, in Chinese", async () => {
    const c = controlled();
    const login = new SlackLogin(() => {}, c.run);
    login.start();
    c.finish({
      code: 1,
      stdout: "",
      stderr: "✖ No Chrome, Edge, Chromium, or Brave installation found.\n   Install one, or point SLACKCLI_BROWSER at the executable.\n",
    });
    await settle();
    expect(login.view()).toMatchObject({
      state: "failed",
      message: "没登录成功：没找到 Chrome、Edge 或 Brave。登录 Slack 要用其中一个单独开窗口，装一个再点。",
    });
  });

  describe("in English", () => {
    afterEach(() => setLang("zh"));

    test("what the panel shows while waiting, after success and after a failure", async () => {
      setLang("en");
      const c = controlled();
      const login = new SlackLogin(() => {}, c.run);
      expect(login.start().message).toBe("A separate Chrome window is open: sign in to Slack there. It closes by itself once you are signed in; this waits up to 5 minutes.");
      c.finish({ code: 0, stdout: "", stderr: "" });
      await settle();
      expect(login.view()).toMatchObject({ state: "ok", message: "Signed in to Slack." });

      const d = controlled();
      const again = new SlackLogin(() => {}, d.run);
      again.start();
      d.finish({ code: 1, stdout: "", stderr: "✖ No Chrome, Edge, Chromium, or Brave installation found.\n" });
      await settle();
      expect(again.view()).toMatchObject({
        state: "failed",
        message: "Sign-in failed: Chrome, Edge or Brave not found. Signing in to Slack opens a separate window in one of them; install one and try again.",
      });
    });
  });
});
