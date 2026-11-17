// Health checks shared by `sidekick doctor`, the daemon (shortly after start, every 6 h, and after a
// Slack collect fails) and the panel's 诊断 button. Every failing check says how to fix it, so a
// colleague who just installed sidekick can get it running without reading the code.

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "./config.ts";
import { isUnwritten, readPersona } from "./persona.ts";
import { t } from "./i18n.ts";
import type { SlackStatus } from "./realtime.ts";
import { shellQuote } from "./runner.ts";
import { loadSettings } from "./settings.ts";
import pkg from "../package.json";
import { CLAUDE, cleanEnv, clip, COMPILED, HOME, log, RUNTIME_FILE, runProcess, SIDEKICK_ROOT, SLACKCLI, VERSION } from "./util.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  id: string;
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it, in words. */
  fix?: string;
  /** A command that fixes it, to copy into a terminal. */
  command?: string;
}

export interface DoctorReport { at: number; checks: Check[] }

export const DAEMON_LABEL = "local.sidekick.daemon";

export interface DoctorInput {
  profile: Profile | null;
  profileError?: string;
  db: Database | null;
  /** The daemon passes its live Slack status. Left out (the CLI), the running daemon is asked. */
  slack?: SlackStatus;
  /** Running inside the daemon (also before setup, when there is no Slack status yet). */
  inDaemon?: boolean;
}

const inRepo = (cmd: string) => `cd ${shellQuote(SIDEKICK_ROOT ?? ".")} && ${cmd}`;
/** Where the daemon logs before a profile is loaded, and why it crashed (one file per day). */
export const DAEMON_LOG_DIR = join(HOME, "Library/Logs/sidekick");
const tilde = (p: string) => (p.startsWith(`${HOME}/`) ? `~/${p.slice(HOME.length + 1)}` : p);
const clock = (ms: number) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
const minutes = (ms: number) => {
  if (ms < 60_000) return t("不到 1 分钟", "under 1 min");
  if (ms < 3600_000) return t(`${Math.round(ms / 60_000)} 分钟`, `${Math.round(ms / 60_000)} min`);
  return t(`${(ms / 3600_000).toFixed(1)} 小时`, `${(ms / 3600_000).toFixed(1)} h`);
};
const SLACKCLI_ENV = () => cleanEnv({ SLACKCLI_NO_UPDATE_NOTIFIER: "1", SLACKCLI_LOG_LEVEL: "warning" });
const loginFix = () => ({
  fix: t("在面板 设置 → Slack 点「登录 Slack」；用命令行的话，运行下面这条", "In the panel, go to Settings → Slack and click \"Sign in to Slack\". From the command line, run this"),
  command: `${shellQuote(SLACKCLI)} auth login-auto`,
});
/** How to (re)install the daemon: the app installs it itself; a checkout builds and installs the app. */
const installFix = () => COMPILED
  ? { fix: t(
      "打开 Sidekick.app，它会把 daemon 装成常驻服务（~/Library/LaunchAgents/local.sidekick.daemon.plist）；系统设置 → 通用 → 登录项 里要允许 sidekick 在后台运行",
      "Open Sidekick.app; it installs the daemon as a background service (~/Library/LaunchAgents/local.sidekick.daemon.plist). In System Settings → General → Login Items, allow sidekick to run in the background",
    ) }
  : { fix: t("构建并安装菜单栏 app，打开后它会装好常驻服务", "Build and install the menu bar app; when it opens, it installs the background service"), command: inRepo("cd app && make install && make run") };

type Body = Omit<Check, "id" | "name">;

async function check(id: string, name: string, fn: () => Body | Promise<Body>): Promise<Check> {
  try {
    return { id, name, ...(await fn()) };
  } catch (e) {
    return { id, name, status: "fail", detail: clip(String((e as Error).message ?? e), 300) };
  }
}

function profileCheck(input: DoctorInput): Body {
  if (input.profile) return { status: "ok", detail: `${input.profile.name} @ ${tilde(input.profile.root)}` };
  if (/missing .*config\.yaml/.test(input.profileError ?? "")) {
    return { status: "fail", detail: t("还没选工作区", "No workspace chosen yet"), fix: t("在面板的「开始用 sidekick」里选一个文件夹", "Choose a folder under \"Get started\" in the panel") };
  }
  return {
    status: "fail",
    detail: clip(input.profileError ?? t("没有加载到 profile", "No profile loaded"), 300),
    fix: t(
      "按上面的报错改工作区里的 sidekick/profile.yaml（字段见 sidekick 的 src/config.ts），或在面板里换一个工作区",
      "Fix sidekick/profile.yaml in your workspace as the error above says (the fields are in sidekick's src/config.ts), or switch to another workspace in the panel",
    ),
  };
}

/** launchd keeps the daemon alive and the restart button relies on it. From the CLI, also ask its API. */
async function daemonCheck(inDaemon: boolean, api: DaemonApi): Promise<Body> {
  const r = await runProcess(["/bin/launchctl", "print", `gui/${process.getuid!()}/${DAEMON_LABEL}`], { timeoutMs: 10_000 });
  if (r.code !== 0) {
    return inDaemon
      ? {
          status: "warn",
          detail: t(
            "daemon 在跑，但不是 launchd 托管的（手动起的？），崩溃后不会自动拉起，「重启 daemon」也会直接把它停掉",
            "The daemon is running, but not under launchd (started by hand?). It will not come back after a crash, and \"Restart daemon\" will just stop it",
          ),
          ...installFix(),
        }
      : { status: "fail", detail: t("没有装成常驻服务", "Not installed as a background service"), ...installFix() };
  }
  const state = /\n\s*state = (\S+)/.exec(r.stdout)?.[1] ?? "?";
  const pid = /\n\s*pid = (\d+)/.exec(r.stdout)?.[1];
  if (!inDaemon && !api.ok) {
    return {
      status: "fail",
      detail: t(`launchd 里有（${state}），但 API 没响应：${api.error}`, `In launchd (${state}), but the API does not answer: ${api.error}`),
      fix: t("看 daemon 的日志找原因", "Look for the cause in the daemon's log"),
      command: `tail -n 50 "$(ls -t ${shellQuote(DAEMON_LOG_DIR)}/*.log | head -1)"`,
    };
  }
  // Where the running daemon comes from: the binary inside Sidekick.app, or bun on a checkout.
  const fromApp = /\n\s*program = \S*\.app\/Contents\/Resources\/bin\/sidekick\n/.test(r.stdout);
  const from = fromApp ? t("Sidekick.app 自带", "bundled with Sidekick.app")
    : /\n\s*program = \S*\/bun\n/.test(r.stdout) ? t("从源码运行（开发用）", "running from source (development)") : "";
  const parts = [
    t("launchd 托管", "Managed by launchd"),
    state,
    pid ? `pid ${pid}` : "",
    api.version ? t(`版本 ${api.version}`, `version ${api.version}`) : "",
    from,
  ];
  return { status: "ok", detail: parts.filter(Boolean).join(t("，", ", ")) };
}

async function claudeCheck(): Promise<Body> {
  if (!existsSync(CLAUDE)) {
    return {
      status: "fail",
      detail: t(`找不到 ${tilde(CLAUDE)}`, `${tilde(CLAUDE)} not found`),
      fix: t("安装 Claude Code（原生安装方式会装到 ~/.local/bin/claude）", "Install Claude Code (the native installer puts it at ~/.local/bin/claude)"),
    };
  }
  const v = await runProcess([CLAUDE, "--version"], { timeoutMs: 15_000 });
  if (v.code !== 0) {
    const out = clip(v.stderr || v.stdout, 200);
    return { status: "fail", detail: t(`claude --version 失败：${out}`, `claude --version failed: ${out}`), fix: t("在终端运行 claude 看报错", "Run claude in a terminal to see the error") };
  }
  const version = v.stdout.trim();
  const a = await runProcess([CLAUDE, "auth", "status", "--json"], { timeoutMs: 15_000 });
  let loggedIn = false;
  try {
    loggedIn = JSON.parse(a.stdout).loggedIn === true; // only this field: the rest names the account
  } catch {
    // not JSON: treated as not logged in
  }
  if (!loggedIn) {
    return { status: "fail", detail: t(`${version}，未登录`, `${version}, not signed in`), fix: t("在终端运行 claude，按提示登录", "Run claude in a terminal and sign in as it asks"), command: "claude" };
  }
  return { status: "ok", detail: t(`${version}，已登录`, `${version}, signed in`) };
}

async function slackcliCheck(realtimeOn: boolean): Promise<Body> {
  const spec = String((pkg.dependencies as Record<string, string>).slackcli ?? "").replace(/#([0-9a-f]{7})[0-9a-f]+$/, "@$1");
  const v = await runProcess([SLACKCLI, "--version"], { timeoutMs: 20_000, env: SLACKCLI_ENV() });
  if (v.code !== 0) {
    return COMPILED
      ? {
          status: "fail",
          detail: t(`app 自带的 slackcli 跑不起来：${clip(v.stderr, 160)}`, `The slackcli bundled with the app does not run: ${clip(v.stderr, 160)}`),
          fix: t("重新下载安装 Sidekick.app", "Download and install Sidekick.app again"),
        }
      : { status: "fail", detail: t("锁定的 slackcli 跑不起来", "The pinned slackcli does not run"), fix: t("在 sidekick 目录里装依赖", "Install the dependencies in the sidekick folder"), command: inRepo("bun install") };
  }
  const version = v.stdout.trim();
  const l = await runProcess([SLACKCLI, "listen", "--help"], { timeoutMs: 20_000, env: SLACKCLI_ENV() });
  if (l.code !== 0) {
    return {
      status: realtimeOn ? "fail" : "warn",
      detail: t(`${version}（${spec}），没有 listen 命令，实时模式用不了`, `${version} (${spec}) has no listen command, so Realtime mode cannot work`),
      fix: COMPILED
        ? t("升级 Sidekick.app", "Upgrade Sidekick.app")
        : t("把 package.json 里的 slackcli 升到带 listen 的版本，再 bun install", "Bump slackcli in package.json to a version with listen, then bun install"),
    };
  }
  return { status: "ok", detail: t(`${version}，${spec}，含 listen`, `${version}, ${spec}, with listen`) };
}

/** `auth whoami` verifies the login with one auth.test call. */
async function slackLoginCheck(): Promise<Body> {
  const r = await runProcess([SLACKCLI, "auth", "whoami", "--json"], { timeoutMs: 30_000, env: SLACKCLI_ENV() });
  let who: { status?: string; workspace_name?: string; error?: { meaning?: string; message?: string; code?: string } } = {};
  try {
    who = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  } catch {
    return { status: "fail", detail: clip(r.stderr || r.stdout || t("slackcli 没有输出", "slackcli printed nothing"), 200), ...loginFix() };
  }
  if (who.status === "ok") {
    const ws = who.workspace_name ?? "";
    return { status: "ok", detail: ws ? t(`已登录 ${ws}`, `Signed in to ${ws}`) : t("已登录", "Signed in") };
  }
  if (who.status === "unreachable") {
    const msg = clip(who.error?.message ?? "", 160);
    return {
      status: "warn",
      detail: t(`连不上 Slack：${msg}`, `Cannot reach Slack: ${msg}`),
      fix: t("多半是网络问题，恢复后自动好；Slack 本身也可能在故障", "Most likely a network problem; it clears up on its own once the network is back. Slack itself may also be down"),
    };
  }
  const why = clip(who.error?.meaning ?? who.error?.code ?? who.status ?? t("未知", "unknown"), 160);
  return { status: "fail", detail: t(`登录失效：${why}`, `Sign-in expired: ${why}`), ...loginFix() };
}

function collectCheck(slack: SlackStatus | undefined, enabled: boolean): Body {
  if (!enabled) return { status: "ok", detail: t("profile 里关了 Slack", "Slack is off in the profile") };
  if (!slack) return { status: "warn", detail: t("daemon 没在跑，看不到采集情况", "The daemon is not running, so there is no collect status") };
  const c = slack.lastCollect;
  const every = t(`每 ${slack.pollMinutes} 分钟一次`, `every ${slack.pollMinutes} min`);
  if (!c) return { status: "ok", detail: slack.collectingSince ? t("第一次采集进行中", "First collect in progress") : t(`还没采集过，${every}`, `No collect yet; ${every}`) };
  if (c.error) {
    return {
      status: "fail",
      detail: t(`${clock(c.at)} 采集失败：${clip(c.error, 200)}`, `Collect at ${clock(c.at)} failed: ${clip(c.error, 200)}`),
      fix: t("先看上面的 Slack 登录一项；登录没问题就是网络或 Slack 接口在变", "Check the Slack sign-in item above first; if that is fine, it is the network or a change in Slack's API"),
    };
  }
  const secs = (c.ms / 1000).toFixed(1);
  return {
    status: "ok",
    detail: t(`${clock(c.at)} 采集成功，新增 ${c.added} 条，用时 ${secs} 秒；${every}`, `Collected at ${clock(c.at)}, ${c.added} new, took ${secs} s; ${every}`),
  };
}

export function realtimeCheck(realtimeOn: boolean, slack: SlackStatus | undefined, now: number): Body {
  if (!realtimeOn) return { status: "ok", detail: t("未开启，只轮询", "Off, polling only") };
  if (!slack) return { status: "warn", detail: t("daemon 没在跑，看不到实时连接", "The daemon is not running, so there is no realtime connection to show") };
  const v = slack.realtime;
  switch (v.state) {
    case "connected":
      return { status: "ok", detail: t(`已连接 ${minutes(now - v.since)}`, `Connected for ${minutes(now - v.since)}`) };
    case "connecting":
      return now - v.since < 60_000
        ? { status: "ok", detail: t("正在连接", "Connecting") }
        : {
            status: "warn",
            detail: t(`${minutes(now - v.since)}没连上${v.error ? `：${v.error}` : ""}`, `Not connected for ${minutes(now - v.since)}${v.error ? `: ${v.error}` : ""}`),
            fix: t("不用处理：连不上 3 分钟会自动回退到轮询", "Nothing to do: after 3 minutes without a connection it falls back to polling"),
          };
    case "fallback": {
      const detail = t(`已回退轮询：${v.reason}；${clock(v.retryAt)} 再试`, `Fell back to polling: ${v.reason}; retrying at ${clock(v.retryAt)}`);
      if (v.fatal === "login_expired") return { status: "fail", detail, ...loginFix() };
      if (v.fatal === "force_reload") {
        return {
          status: "warn",
          detail,
          fix: t(
            "Slack 网页版升级了，slackcli 内置的版本号失效。升级 sidekick 锁定的 slackcli；在那之前可以先关掉实时模式，轮询不受影响",
            "Slack's web app was updated and the version built into slackcli no longer works. Upgrade the slackcli sidekick pins; until then you can turn off Realtime mode. Polling is not affected",
          ),
        };
      }
      return {
        status: "warn",
        detail,
        fix: t(
          "多半是网络不稳或 Slack 在改动，轮询不受影响；一直这样就先关掉实时模式",
          "Most likely an unstable network or a change on Slack's side. Polling is not affected; if it keeps happening, turn off Realtime mode",
        ),
      };
    }
    case "off":
      return { status: "warn", detail: t("设置里开了，但 daemon 还没启用（profile 里关了 Slack？）", "On in Settings, but the daemon has not started it (Slack off in the profile?)") };
  }
}

function personaCheck(profile: Profile): Body {
  const files = readPersona(profile);
  const missing = files.filter((f) => !f.exists).map((f) => f.path);
  const written = files.filter((f) => f.exists && !isUnwritten(f.content));
  if (written.length === 0) {
    return {
      status: "warn",
      detail: t(
        "还没写：agent 不知道你是谁、负责什么、怎么回话，拿不准的会更多地交给你",
        "Not written yet: the agent does not know who you are, what you own or how you talk, so it hands more of what it is unsure about to you",
      ),
      fix: t(
        "面板 → 分身，点「用模板开始」，每节写几条就行；写完用「试跑」看效果",
        "In the panel, open Persona and click \"Start from the template\"; a few lines per section is enough. Then use \"Dry run\" to see the effect",
      ),
    };
  }
  if (missing.length) {
    return {
      status: "warn",
      detail: t(`${missing.join("、")} 不存在`, `${missing.join(", ")} not found`),
      fix: t("面板 → 分身里新建，或从 profile.yaml 的 persona 里去掉", "Create it under Persona in the panel, or remove it from persona in profile.yaml"),
    };
  }
  const chars = written.reduce((n, f) => n + f.content.length, 0);
  return { status: "ok", detail: t(`${written.map((f) => f.path).join("、")}，共 ${chars} 字`, `${written.map((f) => f.path).join(", ")}, ${chars} characters`) };
}

function ledgerCheck(db: Database | null): Body {
  if (!db) return { status: "fail", detail: t("打不开账本（profile 没加载）", "Cannot open the ledger (no profile loaded)") };
  const n = (db.prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n;
  return { status: "ok", detail: t(`${n} 个任务`, n === 1 ? "1 task" : `${n} tasks`) };
}

interface DaemonApi { ok: boolean; error?: string; slack?: SlackStatus; version?: string }

/** From the CLI: ask the running daemon for its live state (and whether it answers at all). */
async function askDaemon(): Promise<DaemonApi> {
  try {
    const rt = JSON.parse(readFileSync(RUNTIME_FILE, "utf8")) as { port: number; token: string };
    const res = await fetch(`http://127.0.0.1:${Number(rt.port)}/api/state`, {
      headers: { Authorization: `Bearer ${rt.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const state = (await res.json()) as { slack?: SlackStatus | null; version?: string };
    return { ok: true, slack: state.slack ?? undefined, version: state.version };
  } catch (e) {
    return { ok: false, error: clip(String((e as Error).message ?? e), 160) };
  }
}

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const inDaemon = input.inDaemon ?? input.slack !== undefined;
  const api: DaemonApi = inDaemon ? { ok: true, slack: input.slack, version: VERSION } : await askDaemon();
  const settings = loadSettings();
  const slackOn = input.profile?.slack.enabled ?? false;
  const now = Date.now();
  const checks = await Promise.all([
    check("profile", t("工作区配置", "Workspace config"), () => profileCheck(input)),
    check("daemon", t("常驻服务", "Background service"), () => daemonCheck(inDaemon, api)),
    check("claude", "Claude Code", claudeCheck),
    check("slackcli", t("slackcli（锁定版本）", "slackcli (pinned)"), () => slackcliCheck(settings.realtime)),
    ...(slackOn && input.profile
      ? [
          check("slack-login", t("Slack 登录", "Slack sign-in"), slackLoginCheck),
          check("collect", t("Slack 采集", "Slack collect"), () => collectCheck(api.slack, slackOn)),
          check("realtime", t("Slack 实时连接", "Slack realtime connection"), () => realtimeCheck(settings.realtime, api.slack, now)),
        ]
      : []),
    ...(input.profile ? [check("persona", t("分身", "Persona"), () => personaCheck(input.profile!))] : []),
    ...(input.profile ? [check("ledger", t("账本", "Ledger"), () => ledgerCheck(input.db))] : []),
  ]);
  return { at: Date.now(), checks };
}

export const failing = (r: DoctorReport) => r.checks.filter((c) => c.status === "fail");

const FIRST_RUN_MS = 60_000; // give the socket and the first collect a moment
const EVERY_MS = 6 * 3600_000;
const MIN_GAP_MS = 30 * 60_000;

/**
 * The daemon's automatic diagnosis: shortly after start, every 6 hours, and soon after something
 * went wrong. Announces a failing check once, not on every run while it stays broken.
 */
export class AutoDoctor {
  private last: DoctorReport | null = null;
  private nextAt: number;
  private running: Promise<DoctorReport> | null = null;
  private announced = new Set<string>();

  constructor(
    private readonly run: () => Promise<DoctorReport>,
    private readonly announce: (newlyFailing: Check[]) => void,
    now = Date.now(),
  ) {
    this.nextAt = now + FIRST_RUN_MS;
  }

  report(): DoctorReport | null {
    return this.last;
  }

  /** Run now. A run asked for from the panel is shown there, so it does not announce. */
  runNow(manual = false): Promise<DoctorReport> {
    this.running ??= this.run()
      .then((r) => {
        this.last = r;
        this.nextAt = r.at + EVERY_MS;
        const bad = failing(r);
        const fresh = bad.filter((c) => !this.announced.has(c.id));
        this.announced = new Set(bad.map((c) => c.id));
        if (fresh.length && !manual) this.announce(fresh);
        return r;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** Something looked wrong (a collect failed): check soon, but at most every 30 minutes. */
  soon(): void {
    this.nextAt = Math.min(this.nextAt, (this.last?.at ?? 0) + MIN_GAP_MS);
  }

  tick(now = Date.now()): void {
    if (now >= this.nextAt && !this.running) this.runNow().catch((e) => log(`doctor: failed: ${String(e).slice(0, 300)}`));
  }
}
