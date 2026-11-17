// Engine config (which profiles exist) and profile config (what one workspace wants).
//
// ~/.config/sidekick/config.yaml        profiles: [{ name, root }]
// <root>/sidekick/profile.yaml          sources, stages, policy for that workspace
//
// The engine knows nothing about any company or person; everything specific lives in the profile.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isSafeRelative } from "./persona.ts";
import { expandHome, HOME } from "./util.ts";

export const ENGINE_CONFIG = join(HOME, ".config/sidekick/config.yaml");

const EngineSchema = z.object({
  profiles: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), root: z.string() })).min(1),
});

const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

const ProfileSchema = z.object({
  slack: z.object({
    enabled: z.boolean().default(true),
    pollMinutes: z.number().positive().default(5),
    maxConversations: z.number().int().positive().default(10),
    contextMessages: z.number().int().positive().default(50),
  }),
  /** The agent that handles each Slack task (one session per task). */
  agent: z.object({
    model: z.string(),
    effort: Effort.optional(),
    maxTurns: z.number().int().positive().default(40),
    concurrency: z.number().int().positive().default(2),
    timeoutMinutes: z.number().positive().default(30),
    /** Skill file (relative to the profile root) the agent reads before handling a Slack task. */
    skill: z.string(),
  }),
  manual: z.object({
    model: z.string(),
    effort: Effort.optional(),
    maxTurns: z.number().int().positive().default(40),
    skill: z.string().optional(),
  }),
  /** Permission rules in Claude Code syntax. Mode is always auto (ADR 0003 ⑤). */
  policy: z.object({
    allow: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  }),
  approvals: z.object({
    /** How long a permission request blocks the run before it is turned into a card (plan §7). */
    waitMinutes: z.number().positive().default(5),
  }),
  /**
   * The persona (分身) files, relative to the root: who I am, what I own, how I talk, what must never
   * be promised for me. Put into every run's system prompt; edited from the panel.
   */
  persona: z.array(z.string().refine((p) => isSafeRelative(p), "分身文件要写工作区里的相对路径，以 .md 结尾")).min(1).default(["sidekick/me.md"]),
  notify: z.object({
    macos: z.boolean().default(true),
    /** DM myself on Slack for approvals, interrupts and failures. Only ever to my own DM. */
    slackSelfDm: z.boolean().default(false),
  }),
});

export type Profile = z.infer<typeof ProfileSchema> & { name: string; root: string; stateDir: string };

export function loadProfiles(): Profile[] {
  if (!existsSync(ENGINE_CONFIG)) {
    throw new Error(`missing ${ENGINE_CONFIG}; create it with: profiles: [{ name: work, root: ~/path/to/workspace }]`);
  }
  const engine = EngineSchema.parse(Bun.YAML.parse(readFileSync(ENGINE_CONFIG, "utf8")));
  return engine.profiles.map(({ name, root }) => loadProfile(name, expandHome(root)));
}

export function loadProfile(name: string, root: string): Profile {
  const file = join(root, "sidekick/profile.yaml");
  if (!existsSync(file)) throw new Error(`profile ${name}: missing ${file}`);
  const parsed = ProfileSchema.safeParse(Bun.YAML.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`profile ${name}: invalid ${file}\n${z.prettifyError(parsed.error)}`);
  for (const rel of [parsed.data.agent.skill, parsed.data.manual.skill].filter(Boolean)) {
    if (!existsSync(join(root, rel as string))) throw new Error(`profile ${name}: ${rel} does not exist under ${root}`);
  }
  return { ...parsed.data, name, root, stateDir: join(root, ".state/sidekick") };
}

export function pickProfile(profiles: Profile[], name?: string): Profile {
  const p = name ? profiles.find((x) => x.name === name) : profiles[0];
  if (!p) throw new Error(`no profile named ${name}`);
  return p;
}
