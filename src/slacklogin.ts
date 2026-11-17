// Signing in to Slack from the panel. `slackcli auth login-auto` opens a Chromium-family browser with
// a profile of its own, waits for me to sign in (up to 5 minutes), and keeps the tokens; the profile
// stays signed in, so later logins need no clicks. It runs in the daemon, one at a time, and the panel
// polls how it went. Before this, signing in was a command to paste into a terminal.

import { cleanEnv, clip, runProcess, SLACKCLI, type ProcessResult } from "./util.ts";

export interface LoginJob {
  state: "idle" | "running" | "ok" | "failed";
  startedAt: number | null;
  message: string;
}

type Run = () => Promise<ProcessResult>;

const login: Run = () =>
  runProcess([SLACKCLI, "auth", "login-auto"], {
    timeoutMs: 330_000, // its own wait is 300 s
    env: cleanEnv({ SLACKCLI_NO_UPDATE_NOTIFIER: "1", SLACKCLI_LOG_LEVEL: "warning" }),
  });

/** What slackcli says, minus spinner noise and colours, for the panel. */
function lastWords(r: ProcessResult): string {
  const text = `${r.stderr}\n${r.stdout}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !/^[-✔✖⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/.test(l));
  return clip(lines.at(-1) ?? (r.code === null ? "slackcli 没能启动" : `slackcli 退出码 ${r.code}`), 200);
}

export class SlackLogin {
  private job: LoginJob = { state: "idle", startedAt: null, message: "" };

  /** `onSignedIn`: forget the cached account, reconnect realtime, re-check (daemon.ts). */
  constructor(private onSignedIn: () => void, private run: Run = login) {}

  view(): LoginJob {
    return this.job;
  }

  start(): LoginJob {
    if (this.job.state === "running") return this.job;
    this.job = { state: "running", startedAt: Date.now(), message: "已打开浏览器：在里面登录 Slack，最多等 5 分钟。已经登录过的会自己完成。" };
    this.run()
      .then((r) => {
        if (r.code === 0) {
          this.job = { ...this.job, state: "ok", message: "已登录 Slack。" };
          this.onSignedIn();
        } else {
          this.job = { ...this.job, state: "failed", message: `没登录成功：${lastWords(r)}` };
        }
      })
      .catch((e) => {
        this.job = { ...this.job, state: "failed", message: `没登录成功：${clip(String(e), 200)}` };
      });
    return this.job;
  }
}
