// Signing in to Slack from the panel. `slackcli auth login-auto` opens a Chromium-family browser with
// a profile of its own, waits for me to sign in (up to 5 minutes), and keeps the tokens; the profile
// stays signed in, so later logins need no clicks. It runs in the daemon, one at a time, and the panel
// polls how it went. Before this, signing in was a command to paste into a terminal.
//
// It is never the default browser: Chrome refuses the DevTools port slackcli reads tokens through on
// the everyday profile, so slackcli takes Chrome, then Edge, Chromium or Brave, with its own profile.
// The panel says so up front; a Mac with none of them gets that said in the interface language, not
// slackcli's hint.

import { t } from "./i18n.ts";
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
  if (text.includes("No Chrome, Edge, Chromium, or Brave installation found")) {
    return t(
      "没找到 Chrome、Edge 或 Brave。登录 Slack 要用其中一个单独开窗口，装一个再点。",
      "Chrome, Edge or Brave not found. Signing in to Slack opens a separate window in one of them; install one and try again.",
    );
  }
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !/^[-✔✖⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/.test(l));
  return clip(lines.at(-1) ?? (r.code === null ? t("slackcli 没能启动", "slackcli did not start") : t(`slackcli 退出码 ${r.code}`, `slackcli exited with code ${r.code}`)), 200);
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
    this.job = {
      state: "running",
      startedAt: Date.now(),
      message: t(
        "已单独打开一个 Chrome 窗口：在里面登录 Slack，登录完它会自己关掉，最多等 5 分钟。",
        "A separate Chrome window is open: sign in to Slack there. It closes by itself once you are signed in; this waits up to 5 minutes.",
      ),
    };
    this.run()
      .then((r) => {
        if (r.code === 0) {
          this.job = { ...this.job, state: "ok", message: t("已登录 Slack。", "Signed in to Slack.") };
          this.onSignedIn();
        } else {
          const why = lastWords(r);
          this.job = { ...this.job, state: "failed", message: t(`没登录成功：${why}`, `Sign-in failed: ${why}`) };
        }
      })
      .catch((e) => {
        const why = clip(String(e), 200);
        this.job = { ...this.job, state: "failed", message: t(`没登录成功：${why}`, `Sign-in failed: ${why}`) };
      });
    return this.job;
  }
}
