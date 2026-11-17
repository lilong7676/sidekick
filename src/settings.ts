// Settings changed from the menu bar app. They live on this machine (~/.config/sidekick/), not in
// the workspace's profile.yaml, and override the profile's defaults:
//
//   settings.json   mode (semi / full), model, effort,    — read on every tick / run, no restart
//                   realtime, pollMinutes, how long a conversation keeps its task (thread / DM),
//                   where 「在 Claude Code 里继续」 opens, notifications (macOS / Slack DM to me),
//                   what not to work on (people, channels, off-hours), full mode on a timetable
//   config.yaml     the workspace folder (profile root)  — needs a daemon restart

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ENGINE_CONFIG } from "./config.ts";
import { expandHome, HOME, log } from "./util.ts";

export const SETTINGS_FILE = join(HOME, ".config/sidekick/settings.json");

export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const MergeHours = z.number().min(0).max(720).nullable();

const SettingsSchema = z.object({
  /** semi: every Slack reply waits for my approval. full: replies go out on their own (on leave / on call). */
  mode: z.enum(["semi", "full"]).default("semi"),
  model: z.enum(MODELS).optional(),
  effort: z.enum(EFFORTS).optional(),
  /**
   * Listen on Slack web's own websocket for new DMs / @me. Opt-in: it is not an official API and can
   * break whenever Slack ships a new web build; the daemon falls back to polling when it misbehaves.
   */
  realtime: z.boolean().default(false),
  /** Overrides the profile's slack.pollMinutes. */
  pollMinutes: z.number().int().min(1).max(60).optional(),
  /**
   * A new message in a conversation sidekick already handled joins that task, and resumes its Claude
   * session, if the task was active within this many hours. null: no limit; 0: only while it is still
   * queued or running. A thread is one topic, so by default it always joins; a DM is one endless
   * stream, so only a burst does (decided 2026-11-16). See intake.ts findJoinableTask.
   */
  threadMergeHours: MergeHours.default(null),
  dmMergeHours: MergeHours.default(2),
  /**
   * Where 「在 Claude Code 里继续」 opens a task's conversation (queries.ts continueInClaude). terminal:
   * a fork of sidekick's session, in Terminal. desktop: sidekick's own session, in the Claude desktop
   * app, which cannot fork (claude refuses --desktop with --fork-session).
   */
  continueIn: z.enum(["terminal", "desktop"]).default("terminal"),
  /**
   * What not to work on (intake.ts): messages from these people, @-mentions in these channels (Slack
   * ids). They still become tasks, closed as skipped, so I can see them and run one anyway.
   */
  skipUsers: z.array(z.string().regex(/^[UW][A-Z0-9]+$/)).max(200).default([]),
  skipChannels: z.array(z.string().regex(/^[CG][A-Z0-9]+$/)).max(200).default([]),
  /**
   * Outside these hours Slack messages are taken in but not worked on until the next start (local
   * time, hours [start, end)); weekends too unless `weekends`. null: any time.
   */
  workHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(1).max(24), weekends: z.boolean() })
    .refine((w) => w.start < w.end, "上班时间要早于下班时间")
    .nullable()
    .default(null),
  /**
   * Full mode on a timetable, e.g. the lunch break: inside these windows replies go out on their own,
   * outside them `mode` applies (a hand-set full mode stays full). Minutes from local midnight,
   * [start, end); weekdays only unless `weekends`. See effectiveMode.
   */
  autoFull: z.object({
    windows: z.array(z.object({ start: z.number().int().min(0).max(1439), end: z.number().int().min(1).max(1440) })
      .refine((w) => w.start < w.end, "时段的开始要早于结束")).min(1).max(6),
    weekends: z.boolean(),
  }).nullable().default(null),
  /** Put a signature line above replies sidekick sends (approvals.ts replyBlocks). */
  signReplies: z.boolean().default(true),
  /** Override the profile's notify.macos / notify.slackSelfDm (unset: the profile decides). */
  notifyMacos: z.boolean().optional(),
  notifySlackDm: z.boolean().optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;

const DEFAULTS: Settings = SettingsSchema.parse({});

export function loadSettings(file = SETTINGS_FILE): Settings {
  if (!existsSync(file)) return { ...DEFAULTS };
  try {
    return SettingsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    // A broken file must never silently turn on full mode: fall back to the safe default.
    log(`settings: ${file} is invalid, using defaults: ${String(e).slice(0, 200)}`);
    return { ...DEFAULTS };
  }
}

export interface SettingsPatch {
  mode?: unknown; model?: unknown; effort?: unknown; realtime?: unknown; pollMinutes?: unknown;
  threadMergeHours?: unknown; dmMergeHours?: unknown; continueIn?: unknown;
  notifyMacos?: unknown; notifySlackDm?: unknown;
  skipUsers?: unknown; skipChannels?: unknown; workHours?: unknown; autoFull?: unknown; signReplies?: unknown;
}

/**
 * Validate and apply a patch from the UI. `null` clears model / effort / pollMinutes back to the
 * profile default; for the merge windows it means no limit.
 */
export function updateSettings(patch: SettingsPatch, file = SETTINGS_FILE): Settings {
  const cur = loadSettings(file);
  const next: Record<string, unknown> = { ...cur };
  if (patch.mode !== undefined) next.mode = patch.mode;
  if (patch.realtime !== undefined) next.realtime = patch.realtime;
  if (patch.signReplies !== undefined) next.signReplies = patch.signReplies;
  if (patch.threadMergeHours !== undefined) next.threadMergeHours = patch.threadMergeHours;
  if (patch.dmMergeHours !== undefined) next.dmMergeHours = patch.dmMergeHours;
  if (patch.continueIn !== undefined) next.continueIn = patch.continueIn;
  for (const k of ["skipUsers", "skipChannels", "workHours", "autoFull"] as const) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  for (const k of ["model", "effort", "pollMinutes", "notifyMacos", "notifySlackDm"] as const) {
    if (patch[k] === null || patch[k] === "") delete next[k];
    else if (patch[k] !== undefined) next[k] = patch[k];
  }
  const parsed = SettingsSchema.safeParse(next);
  if (!parsed.success) throw new Error(`设置不合法：${z.prettifyError(parsed.error)}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(parsed.data, null, 2));
  return parsed.data;
}

/** The mode in force at `now`, and whether a timetable put it there (`until`: when that window ends). */
export interface EffectiveMode { mode: Settings["mode"]; scheduled: boolean; until: number | null }

/**
 * Full when set by hand, or inside an autoFull window; semi otherwise. A run takes the mode in force
 * when it starts, for its rules and for whether its reply goes out unseen (handle.ts, mcp.ts).
 */
export function effectiveMode(s: Pick<Settings, "mode" | "autoFull">, now = new Date()): EffectiveMode {
  if (s.mode === "full") return { mode: "full", scheduled: false, until: null };
  const a = s.autoFull;
  if (a && (a.weekends || (now.getDay() !== 0 && now.getDay() !== 6))) {
    const minute = now.getHours() * 60 + now.getMinutes();
    const w = a.windows.find((x) => minute >= x.start && minute < x.end);
    if (w) {
      const until = new Date(now);
      until.setHours(0, w.end, 0, 0);
      return { mode: "full", scheduled: true, until: until.getTime() };
    }
  }
  return { mode: "semi", scheduled: false, until: null };
}

/** What the daemon last saw: the mode set by hand and the one in force. */
export interface ModeSeen { manual: Settings["mode"]; mode: Settings["mode"] }

/**
 * Since `prev`, did the timetable switch the mode? Only then is it worth telling me: a change I made
 * by hand I already know about. Returns what to remember next, and the switch to announce, if any.
 */
export function timetableSwitch(prev: ModeSeen, s: Pick<Settings, "mode" | "autoFull">, now = new Date()): { seen: ModeSeen; announce: EffectiveMode | null } {
  const m = effectiveMode(s, now);
  const byTimetable = s.mode === prev.manual && m.mode !== prev.mode;
  return { seen: { manual: s.mode, mode: m.mode }, announce: byTimetable ? m : null };
}

/** Settings as a run should see them: the mode in force now rather than the one set by hand. */
export function runSettings(now = new Date()): Settings {
  const s = loadSettings();
  return { ...s, mode: effectiveMode(s, now).mode };
}

// ---- workspace folder (engine config) -----------------------------------------------------------------

export function readEngineConfig(file = ENGINE_CONFIG): { name: string; root: string } {
  const cfg = Bun.YAML.parse(readFileSync(file, "utf8")) as { profiles: Array<{ name: string; root: string }> };
  return cfg.profiles[0];
}

/** Point the (single) profile at another workspace folder. It must already hold sidekick/profile.yaml. */
export function setWorkspaceRoot(root: string, file = ENGINE_CONFIG): string {
  const abs = expandHome(root.trim());
  mkdirSync(dirname(file), { recursive: true });
  if (!abs.startsWith("/")) throw new Error("工作区目录要写绝对路径或 ~/ 开头");
  if (!existsSync(join(abs, "sidekick/profile.yaml"))) throw new Error(`${abs} 下没有 sidekick/profile.yaml`);
  const { name } = existsSync(file) ? readEngineConfig(file) : { name: "work" };
  const display = abs.startsWith(`${HOME}/`) ? `~/${abs.slice(HOME.length + 1)}` : abs;
  writeFileSync(file, `profiles:\n  - name: ${name}\n    root: ${JSON.stringify(display)}\n`);
  return abs;
}
