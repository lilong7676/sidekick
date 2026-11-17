// Health checks shared by `sidekick doctor`, the daemon (shortly after start, every 6 h, and after a
// Slack collect fails) and the panel's 诊断 button. Every failing check says how to fix it, so a
// colleague who just installed sidekick can get it running without reading the code.

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "./config.ts";
import { isUnwritten, readPersona } from "./persona.ts";
import { FORCE_RELOAD, LOGIN_EXPIRED, type SlackStatus } from "./realtime.ts";
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
const minutes = (ms: number) => (ms < 60_000 ? "不到 1 分钟" : ms < 3600_000 ? `${Math.round(ms / 60_000)} 分钟` : `${(ms / 3600_000).toFixed(1)} 小时`);
const SLACKCLI_ENV = () => cleanEnv({ SLACKCLI_NO_UPDATE_NOTIFIER: "1", SLACKCLI_LOG_LEVEL: "warning" });
const LOGIN_FIX = { fix: "在面板 设置 → Slack 点「登录 Slack」；用命令行的话，运行下面这条", command: `${shellQuote(SLACKCLI)} auth login-auto` };
/** How to (re)install the daemon: the app installs it itself; a checkout builds and installs the app. */
const INSTALL_FIX = COMPILED
  ? { fix: "打开 Sidekick.app，它会把 daemon 装成常驻服务（~/Library/LaunchAgents/local.sidekick.daemon.plist）；系统设置 → 通用 → 登录项 里要允许 sidekick 在后台运行" }
  : { fix: "构建并安装菜单栏 app，打开后它会装好常驻服务", command: inRepo("cd app && make install && make run") };

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
    return { status: "fail", detail: "还没选工作区", fix: "在面板的「开始用 sidekick」里选一个文件夹" };
  }
  return {
    status: "fail",
    detail: clip(input.profileError ?? "没有加载到 profile", 300),
    fix: "按上面的报错改工作区里的 sidekick/profile.yaml（字段见 sidekick 的 src/config.ts），或在面板里换一个工作区",
  };
}

/** launchd keeps the daemon alive and the restart button relies on it. From the CLI, also ask its API. */
async function daemonCheck(inDaemon: boolean, api: DaemonApi): Promise<Body> {
  const r = await runProcess(["/bin/launchctl", "print", `gui/${process.getuid!()}/${DAEMON_LABEL}`], { timeoutMs: 10_000 });
  if (r.code !== 0) {
    return inDaemon
      ? { status: "warn", detail: "daemon 在跑，但不是 launchd 托管的（手动起的？），崩溃后不会自动拉起，「重启 daemon」也会直接把它停掉", ...INSTALL_FIX }
      : { status: "fail", detail: "没有装成常驻服务", ...INSTALL_FIX };
  }
  const state = /\n\s*state = (\S+)/.exec(r.stdout)?.[1] ?? "?";
  const pid = /\n\s*pid = (\d+)/.exec(r.stdout)?.[1];
  if (!inDaemon && !api.ok) {
    return { status: "fail", detail: `launchd 里有（${state}），但 API 没响应：${api.error}`, fix: "看 daemon 的日志找原因", command: `tail -n 50 "$(ls -t ${shellQuote(DAEMON_LOG_DIR)}/*.log | head -1)"` };
  }
  // Where the running daemon comes from: the binary inside Sidekick.app, or bun on a checkout.
  const fromApp = /\n\s*program = \S*\.app\/Contents\/Resources\/bin\/sidekick\n/.test(r.stdout);
  const from = fromApp ? "Sidekick.app 自带" : /\n\s*program = \S*\/bun\n/.test(r.stdout) ? "从源码运行（开发用）" : "";
  const version = api.version ? `，版本 ${api.version}` : "";
  return { status: "ok", detail: `launchd 托管，${state}${pid ? `，pid ${pid}` : ""}${version}${from ? `，${from}` : ""}` };
}

async function claudeCheck(): Promise<Body> {
  if (!existsSync(CLAUDE)) return { status: "fail", detail: `找不到 ${tilde(CLAUDE)}`, fix: "安装 Claude Code（原生安装方式会装到 ~/.local/bin/claude）" };
  const v = await runProcess([CLAUDE, "--version"], { timeoutMs: 15_000 });
  if (v.code !== 0) return { status: "fail", detail: `claude --version 失败：${clip(v.stderr || v.stdout, 200)}`, fix: "在终端运行 claude 看报错" };
  const version = v.stdout.trim();
  const a = await runProcess([CLAUDE, "auth", "status", "--json"], { timeoutMs: 15_000 });
  let loggedIn = false;
  try {
    loggedIn = JSON.parse(a.stdout).loggedIn === true; // only this field: the rest names the account
  } catch {
    // not JSON: treated as not logged in
  }
  if (!loggedIn) return { status: "fail", detail: `${version}，未登录`, fix: "在终端运行 claude，按提示登录", command: "claude" };
  return { status: "ok", detail: `${version}，已登录` };
}

async function slackcliCheck(realtimeOn: boolean): Promise<Body> {
  const spec = String((pkg.dependencies as Record<string, string>).slackcli ?? "").replace(/#([0-9a-f]{7})[0-9a-f]+$/, "@$1");
  const v = await runProcess([SLACKCLI, "--version"], { timeoutMs: 20_000, env: SLACKCLI_ENV() });
  if (v.code !== 0) {
    return COMPILED
      ? { status: "fail", detail: `app 自带的 slackcli 跑不起来：${clip(v.stderr, 160)}`, fix: "重新下载安装 Sidekick.app" }
      : { status: "fail", detail: "锁定的 slackcli 跑不起来", fix: "在 sidekick 目录里装依赖", command: inRepo("bun install") };
  }
  const version = v.stdout.trim();
  const l = await runProcess([SLACKCLI, "listen", "--help"], { timeoutMs: 20_000, env: SLACKCLI_ENV() });
  if (l.code !== 0) {
    return {
      status: realtimeOn ? "fail" : "warn",
      detail: `${version}（${spec}），没有 listen 命令，实时模式用不了`,
      fix: COMPILED ? "升级 Sidekick.app" : "把 package.json 里的 slackcli 升到带 listen 的版本，再 bun install",
    };
  }
  return { status: "ok", detail: `${version}，${spec}，含 listen` };
}

/** `auth whoami` verifies the login with one auth.test call. */
async function slackLoginCheck(): Promise<Body> {
  const r = await runProcess([SLACKCLI, "auth", "whoami", "--json"], { timeoutMs: 30_000, env: SLACKCLI_ENV() });
  let who: { status?: string; workspace_name?: string; error?: { meaning?: string; message?: string; code?: string } } = {};
  try {
    who = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  } catch {
    return { status: "fail", detail: clip(r.stderr || r.stdout || "slackcli 没有输出", 200), ...LOGIN_FIX };
  }
  if (who.status === "ok") return { status: "ok", detail: `已登录 ${who.workspace_name ?? ""}`.trim() };
  if (who.status === "unreachable") {
    return { status: "warn", detail: `连不上 Slack：${clip(who.error?.message ?? "", 160)}`, fix: "多半是网络问题，恢复后自动好；Slack 本身也可能在故障" };
  }
  return { status: "fail", detail: `登录失效：${clip(who.error?.meaning ?? who.error?.code ?? who.status ?? "未知", 160)}`, ...LOGIN_FIX };
}

function collectCheck(slack: SlackStatus | undefined, enabled: boolean): Body {
  if (!enabled) return { status: "ok", detail: "profile 里关了 Slack" };
  if (!slack) return { status: "warn", detail: "daemon 没在跑，看不到采集情况" };
  const c = slack.lastCollect;
  if (!c) return { status: "ok", detail: slack.collectingSince ? "第一次采集进行中" : `还没采集过，每 ${slack.pollMinutes} 分钟一次` };
  if (c.error) {
    return { status: "fail", detail: `${clock(c.at)} 采集失败：${clip(c.error, 200)}`, fix: "先看上面的 Slack 登录一项；登录没问题就是网络或 Slack 接口在变" };
  }
  return { status: "ok", detail: `${clock(c.at)} 采集成功，新增 ${c.added} 条，用时 ${(c.ms / 1000).toFixed(1)} 秒；每 ${slack.pollMinutes} 分钟一次` };
}

function realtimeCheck(realtimeOn: boolean, slack: SlackStatus | undefined, now: number): Body {
  if (!realtimeOn) return { status: "ok", detail: "未开启，只轮询" };
  if (!slack) return { status: "warn", detail: "daemon 没在跑，看不到实时连接" };
  const v = slack.realtime;
  switch (v.state) {
    case "connected":
      return { status: "ok", detail: `已连接 ${minutes(now - v.since)}` };
    case "connecting":
      return now - v.since < 60_000
        ? { status: "ok", detail: "正在连接" }
        : { status: "warn", detail: `${minutes(now - v.since)}没连上${v.error ? `：${v.error}` : ""}`, fix: "不用处理：连不上 3 分钟会自动回退到轮询" };
    case "fallback": {
      const detail = `已回退轮询：${v.reason}；${clock(v.retryAt)} 再试`;
      if (v.reason === LOGIN_EXPIRED) return { status: "fail", detail, ...LOGIN_FIX };
      if (v.reason === FORCE_RELOAD) {
        return { status: "warn", detail, fix: "Slack 网页版升级了，slackcli 内置的版本号失效。升级 sidekick 锁定的 slackcli；在那之前可以先关掉实时模式，轮询不受影响" };
      }
      return { status: "warn", detail, fix: "多半是网络不稳或 Slack 在改动，轮询不受影响；一直这样就先关掉实时模式" };
    }
    case "off":
      return { status: "warn", detail: "设置里开了，但 daemon 还没启用（profile 里关了 Slack？）" };
  }
}

function personaCheck(profile: Profile): Body {
  const files = readPersona(profile);
  const missing = files.filter((f) => !f.exists).map((f) => f.path);
  const written = files.filter((f) => f.exists && !isUnwritten(f.content));
  if (written.length === 0) {
    return {
      status: "warn",
      detail: "还没写：agent 不知道你是谁、负责什么、怎么回话，拿不准的会更多地交给你",
      fix: "面板 → 分身，点「用模板开始」，每节写几条就行；写完用「试跑」看效果",
    };
  }
  if (missing.length) return { status: "warn", detail: `${missing.join("、")} 不存在`, fix: "面板 → 分身里新建，或从 profile.yaml 的 persona 里去掉" };
  const chars = written.reduce((n, f) => n + f.content.length, 0);
  return { status: "ok", detail: `${written.map((f) => f.path).join("、")}，共 ${chars} 字` };
}

function ledgerCheck(db: Database | null): Body {
  if (!db) return { status: "fail", detail: "打不开账本（profile 没加载）" };
  const n = (db.prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n;
  return { status: "ok", detail: `${n} 个任务` };
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
    check("profile", "工作区配置", () => profileCheck(input)),
    check("daemon", "常驻服务", () => daemonCheck(inDaemon, api)),
    check("claude", "Claude Code", claudeCheck),
    check("slackcli", "slackcli（锁定版本）", () => slackcliCheck(settings.realtime)),
    ...(slackOn && input.profile
      ? [
          check("slack-login", "Slack 登录", slackLoginCheck),
          check("collect", "Slack 采集", () => collectCheck(api.slack, slackOn)),
          check("realtime", "Slack 实时连接", () => realtimeCheck(settings.realtime, api.slack, now)),
        ]
      : []),
    ...(input.profile ? [check("persona", "分身", () => personaCheck(input.profile!))] : []),
    ...(input.profile ? [check("ledger", "账本", () => ledgerCheck(input.db))] : []),
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
