// Small shared helpers: paths, the clean child environment, ids, logging, JSON from noisy CLIs.

import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import pkg from "../package.json";

export const HOME = homedir();
export const CLAUDE = join(HOME, ".local/bin/claude");
/**
 * Running as the compiled binary inside Sidekick.app (Contents/Resources/bin/sidekick), rather than
 * `bun src/cli.ts` from a checkout. The app carries no source, only the two compiled binaries.
 */
export const COMPILED = import.meta.dir.startsWith("/$bunfs");
/** The sidekick checkout (src/..); null inside the app. */
export const SIDEKICK_ROOT: string | null = COMPILED ? null : join(import.meta.dir, "..");
/**
 * Holds only the pinned slackcli, and comes first on every child's PATH: bin/ in a checkout
 * (bin/slackcli → node_modules), Contents/Resources/slackcli/ in the app. Never the sidekick binary
 * itself: the agent must not find a way to decide its own approvals.
 */
export const SIDEKICK_BIN = COMPILED ? join(dirname(process.execPath), "../slackcli") : join(SIDEKICK_ROOT!, "bin");
/** The slackcli pinned in package.json, not whatever happens to be installed on the machine. */
export const SLACKCLI = join(SIDEKICK_BIN, "slackcli");
/** argv that runs this program again (claude spawns it as the MCP server and the guard hook). */
export const SELF: string[] = COMPILED ? [process.execPath] : [process.execPath, join(import.meta.dir, "cli.ts")];
/** Where the running daemon says which port and token its API uses (0600). */
export const RUNTIME_FILE = join(HOME, ".config/sidekick/runtime.json");
/** package.json's version: the app, the daemon and the release tag all carry this one. */
export const VERSION: string = pkg.version;
/**
 * When the running binary was built (mtime, whole seconds), or null from a checkout. The app compares
 * it with the binary it carries: different means an upgrade the daemon has not picked up yet.
 */
export const BINARY_MTIME: number | null = COMPILED ? Math.floor(statSync(process.execPath).mtimeMs / 1000) : null;

export function expandHome(p: string): string {
  return p === "~" ? HOME : p.startsWith("~/") ? join(HOME, p.slice(2)) : p;
}

/**
 * The environment every child process gets: a fixed allow-list, nothing inherited.
 * A daemon started from inside a Claude Code session would otherwise leak ~30 CLAUDE_CODE_* /
 * ANTHROPIC_* variables into `claude`, which changes auth and turns off transcript saving
 * (ADR 0003 ②).
 */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME,
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    // sidekick's bin first: the daemon and the agent's own `slackcli ...` calls run the pinned version.
    PATH: `${SIDEKICK_BIN}:${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    ...extra,
  };
}

export interface ProcessResult { code: number | null; stdout: string; stderr: string }

/**
 * Run a command without blocking the event loop. Never throws: a missing binary comes back as
 * code null with the reason in stderr, a timeout as the signal's exit code.
 */
export async function runProcess(cmd: string[], opts: { input?: string; timeoutMs?: number; env?: Record<string, string>; cwd?: string } = {}): Promise<ProcessResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      stdin: opts.input === undefined ? "ignore" : new Blob([opts.input]),
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env ?? cleanEnv(),
      cwd: opts.cwd,
    });
  } catch (e) {
    return { code: null, stdout: "", stderr: String((e as Error).message ?? e) };
  }
  const timer = setTimeout(() => proc.kill("SIGTERM"), opts.timeoutMs ?? 90_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** Short, sortable-enough ids: `t_k3j9x2`. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36).slice(-4)}${randomBytes(2).toString("hex")}`;
}

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** CLIs sometimes print a spinner or a banner before their JSON: parse from the first bracket. */
export function parseJsonLoose<T = unknown>(text: string): T {
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0);
  if (starts.length === 0) throw new Error(`no JSON in output: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(Math.min(...starts))) as T;
}

/** Pull the first JSON array or object out of model text (it may add prose or code fences). */
export function extractJson<T = unknown>(text: string, kind: "array" | "object"): T {
  const [open, close] = kind === "array" ? ["[", "]"] : ["{", "}"];
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end <= start) throw new Error(`no JSON ${kind} in model output`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}

let logDir: string | null = null;
export function setLogDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  logDir = dir;
}

export function log(line: string): void {
  const now = new Date();
  const stamp = now.toTimeString().slice(0, 8);
  const text = `[${stamp}] ${line}\n`;
  if (!logDir) {
    process.stderr.write(text);
    return;
  }
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  appendFileSync(join(logDir, `${day}.log`), text);
  if (process.env.SIDEKICK_LOG_STDERR) process.stderr.write(text);
}

export function clip(text: string | null | undefined, n: number): string {
  const t = (text ?? "").trim();
  return t.length > n ? `${t.slice(0, n)} …` : t;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
