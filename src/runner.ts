// The runner: one `claude -p` process per run. Its interface follows ACP v1's shape
// (new / prompt / resume / cancel, a stream of updates, permission requests) so another agent
// can be slotted in later (ADR 0001); today the only implementation spawns the Claude Code CLI.

import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "./config.ts";
import { CLAUDE, cleanEnv, SELF } from "./util.ts";

export interface LaunchSpec {
  cwd: string;
  model: string;
  effort?: string;
  maxTurns: number;
  /** "" disables every built-in tool (stage 1). Omit for the default set. */
  tools?: string;
  /** No MCP servers but sidekick's own: not the user's, the workspace's, nor the claude.ai connectors (handle.ts ToolSet). */
  strictMcp?: boolean;
  /** Skip user-level settings, plugins and connectors (ADR 0003 ④). */
  lean: boolean;
  allow: string[];
  ask: string[];
  deny: string[];
  /** Policy file for the `sidekick guard` PreToolUse hook (normalizes git -C, bash -c, …). */
  guardPolicyPath?: string;
  /** Wire the sidekick MCP server (approve / propose / report) into the run. */
  /** `mode`: the one the run started in, which decides whether its reply goes out unseen (mcp.ts). */
  sidekickMcp?: {
    dbPath: string; taskId: string; runId: string; waitMs: number; profileRoot: string; mode: "semi" | "full";
    /** profile.yaml autoReply: replies that need no approval (mcp.ts autoReplyAllowed). */
    autoReply?: Profile["autoReply"];
  };
  appendSystemPrompt?: string;
  addDirs?: string[];
  timeoutMs: number;
}

export interface RunResult {
  exitCode: number | null;
  sessionId: string | null;
  text: string;
  isError: boolean;
  costUsd: number | null;
  turns: number | null;
  denials: Array<{ tool_name: string; tool_use_id: string; tool_input: unknown }>;
  timedOut: boolean;
  /** Stopped because Claude only kept retrying the API (apiStall): try again later, not a failure. */
  apiStalled: boolean;
}

/** How long a run may only retry the API before it is stopped. */
export const API_STALL_MS = 5 * 60_000;

/**
 * Claude retrying the API with nothing else happening: offline, asleep, or an outage. Such a run used
 * to sit out the whole timeout, three times over: three overnight tasks lost about two hours each
 * (2026-11-18). Any other event means it is getting somewhere.
 */
export function apiStall(now = () => Date.now()) {
  let since: number | null = null;
  return {
    see(ev: { type?: string; subtype?: string }): void {
      if (ev.type === "system" && ev.subtype === "api_retry") since ??= now();
      else if (ev.type !== "system") since = null;
    },
    stalledFor(): number {
      return since === null ? 0 : now() - since;
    },
  };
}

/** ask rules plus the guard hook, as one --settings JSON (hooks run before rules). */
export function settingsJson(spec: LaunchSpec): string | null {
  const settings: Record<string, unknown> = {};
  if (spec.ask.length) settings.permissions = { ask: spec.ask };
  if (spec.guardPolicyPath) {
    settings.hooks = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: [...SELF, "guard", "--policy", spec.guardPolicyPath].map(shellQuote).join(" ") }] }],
    };
  }
  return Object.keys(settings).length ? JSON.stringify(settings) : null;
}

export function writeGuardPolicy(dir: string, runId: string, spec: Pick<LaunchSpec, "ask" | "deny">): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.policy.json`);
  writeFileSync(path, JSON.stringify({ ask: spec.ask, deny: spec.deny }));
  return path;
}

/** Build argv for one run. Pure, so it can be unit-tested and shown in `sidekick task`. */
export function claudeArgs(spec: LaunchSpec, prompt: string, session: { id: string; resume: boolean }, mcpConfigPath?: string): string[] {
  const args = [
    "-p", prompt,
    session.resume ? "--resume" : "--session-id", session.id,
    "--output-format", "stream-json", "--verbose",
    "--model", spec.model,
    "--max-turns", String(spec.maxTurns),
    // auto is decided (ADR 0003 ⑤). Pass it explicitly: lean runs do not read the user-level default.
    "--permission-mode", "auto",
  ];
  if (spec.effort) args.push("--effort", spec.effort);
  if (spec.tools !== undefined) args.push("--tools", spec.tools);
  if (spec.lean) args.push("--setting-sources", "project,local");
  // ask rules route "tell me first" actions to the approval tool; auto mode still honours them.
  const settings = settingsJson(spec);
  if (settings) args.push("--settings", settings);
  if (spec.allow.length) args.push("--allowedTools", ...spec.allow);
  if (spec.deny.length) args.push("--disallowedTools", ...spec.deny);
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath, "--permission-prompt-tool", "mcp__sidekick__approve");
  if (spec.strictMcp) args.push("--strict-mcp-config", ...(mcpConfigPath ? [] : ["--mcp-config", '{"mcpServers":{}}']));
  if (spec.appendSystemPrompt) args.push("--append-system-prompt", spec.appendSystemPrompt);
  for (const d of spec.addDirs ?? []) args.push("--add-dir", d);
  return args;
}

/**
 * argv for taking a session over in a terminal: same session, same sidekick tools and rules, but
 * interactive and with my normal user-level setup (no --setting-sources), since a human is driving.
 */
export function takeoverArgs(spec: LaunchSpec, sessionId: string, mcpConfigPath: string): string[] {
  const args = ["--resume", sessionId, "--mcp-config", mcpConfigPath, "--permission-prompt-tool", "mcp__sidekick__approve"];
  const settings = settingsJson(spec);
  if (settings) args.push("--settings", settings);
  if (spec.deny.length) args.push("--disallowedTools", ...spec.deny);
  return args;
}

export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** resume does not carry --mcp-config / --settings / --add-dir over, so every run rewrites them. */
export function writeMcpConfig(dir: string, runId: string, mcp: NonNullable<LaunchSpec["sidekickMcp"]>): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.mcp.json`);
  writeFileSync(path, JSON.stringify({
    mcpServers: {
      sidekick: {
        command: SELF[0],
        args: [...SELF.slice(1), "mcp"],
        env: {
          SIDEKICK_DB: mcp.dbPath,
          SIDEKICK_TASK_ID: mcp.taskId,
          SIDEKICK_RUN_ID: mcp.runId,
          SIDEKICK_WAIT_MS: String(mcp.waitMs),
          SIDEKICK_PROFILE_ROOT: mcp.profileRoot,
          SIDEKICK_MODE: mcp.mode,
          SIDEKICK_AUTO_REPLY: JSON.stringify(mcp.autoReply ?? []),
        },
      },
    },
  }));
  return path;
}

export interface RunHandle {
  pid: number;
  done: Promise<RunResult>;
  cancel: () => void;
}

/** Spawn one run, tee stream-json to `logPath`, resolve with the parsed result event. */
export function startRun(spec: LaunchSpec, prompt: string, session: { id: string; resume: boolean }, logPath: string, runDir: string): RunHandle {
  const mcpPath = spec.sidekickMcp ? writeMcpConfig(runDir, spec.sidekickMcp.runId, spec.sidekickMcp) : undefined;
  const args = claudeArgs(spec, prompt, session, mcpPath);
  const proc = Bun.spawn([CLAUDE, ...args], { cwd: spec.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: cleanEnv() });
  const out = createWriteStream(logPath, { flags: "a" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGTERM"); }, spec.timeoutMs);
  const stall = apiStall();
  let apiStalled = false;
  const watch = setInterval(() => {
    if (!apiStalled && stall.stalledFor() > API_STALL_MS) { apiStalled = true; proc.kill("SIGTERM"); }
  }, 15_000);

  const done = (async (): Promise<RunResult> => {
    let result: Record<string, any> | null = null;
    let sessionId: string | null = null;
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      const s = dec.decode(chunk, { stream: true });
      out.write(s);
      buf += s;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "system" && ev.subtype === "init") sessionId = ev.session_id ?? sessionId;
          if (ev.type === "result") result = ev;
          stall.see(ev);
        } catch {
          // Unknown or partial lines stay in the log; parsing is deliberately lenient.
        }
      }
    }
    const stderr = await new Response(proc.stderr).text();
    if (stderr.trim()) out.write(JSON.stringify({ type: "sidekick_stderr", text: stderr.slice(-4000) }) + "\n");
    const exitCode = await proc.exited;
    clearTimeout(timer);
    clearInterval(watch);
    out.end();
    return {
      exitCode,
      sessionId: result?.session_id ?? sessionId,
      text: typeof result?.result === "string" ? result.result : "",
      isError: Boolean(result?.is_error) || !result,
      costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
      turns: typeof result?.num_turns === "number" ? result.num_turns : null,
      denials: Array.isArray(result?.permission_denials) ? result.permission_denials : [],
      timedOut,
      apiStalled,
    };
  })();

  return { pid: proc.pid, done, cancel: () => proc.kill("SIGTERM") };
}

/** One-shot call with no tools that returns the final text (stage 1). */
export async function oneShot(spec: Omit<LaunchSpec, "allow" | "ask" | "deny">, prompt: string): Promise<{ text: string; costUsd: number | null }> {
  const args = ["-p", prompt, "--output-format", "json", "--model", spec.model, "--max-turns", String(spec.maxTurns),
    "--permission-mode", "auto", "--tools", spec.tools ?? ""];
  if (spec.lean) args.push("--setting-sources", "project,local");
  const proc = Bun.spawn([CLAUDE, ...args], { cwd: spec.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: cleanEnv() });
  const timer = setTimeout(() => proc.kill("SIGTERM"), spec.timeoutMs);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  clearTimeout(timer);
  let res: { result?: string; total_cost_usd?: number; is_error?: boolean };
  try {
    res = JSON.parse(stdout);
  } catch {
    throw new Error(`claude returned no JSON: ${(stderr || stdout).slice(-300)}`);
  }
  if (res.is_error) throw new Error(`claude error: ${String(res.result).slice(0, 300)}`);
  return { text: res.result ?? "", costUsd: res.total_cost_usd ?? null };
}
