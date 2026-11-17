// First run, and switching workspaces: point sidekick at a folder. A folder without a profile gets
// one from the templates (profile, Slack skill, persona), so a colleague who just installed
// Sidekick.app picks a folder in the panel and is running, with nothing to write by hand.

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENGINE_CONFIG, loadProfile } from "./config.ts";
import { PERSONA_TEMPLATE } from "./persona.ts";
import { setWorkspaceRoot } from "./settings.ts";
import profileTemplate from "../templates/profile.yaml" with { type: "text" };
import slackTemplate from "../templates/slack.md" with { type: "text" };
import { expandHome, HOME } from "./util.ts";

const TEMPLATES: Array<[string, string]> = [
  ["sidekick/profile.yaml", profileTemplate],
  ["sidekick/slack.md", slackTemplate],
  ["sidekick/me.md", PERSONA_TEMPLATE],
];

/** What the panel suggests on first run. */
export const SUGGESTED_ROOT = join(HOME, "sidekick");

/**
 * Give a folder the files sidekick needs. A folder that already has sidekick/profile.yaml is left
 * alone (its profile names its own files); otherwise missing template files are created, existing
 * ones never overwritten. Returns the files it created.
 */
export function scaffoldWorkspace(root: string): string[] {
  if (existsSync(join(root, "sidekick/profile.yaml"))) return [];
  const created: string[] = [];
  for (const [rel, text] of TEMPLATES) {
    const abs = join(root, rel);
    if (existsSync(abs)) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    created.push(rel);
  }
  return created;
}

/** Use this folder as the workspace (creating it if asked for a new one). Takes effect after a daemon restart. */
export function useWorkspace(input: string, engineConfig = ENGINE_CONFIG): { root: string; created: string[] } {
  const root = expandHome(input.trim()).replace(/\/+$/, "");
  if (!root.startsWith("/")) throw new Error("要写绝对路径，或 ~/ 开头");
  if (existsSync(root) && !statSync(root).isDirectory()) throw new Error(`${root} 不是文件夹`);
  mkdirSync(root, { recursive: true });
  const created = scaffoldWorkspace(root);
  loadProfile("work", root); // a broken profile already there says why, before anything points at it
  setWorkspaceRoot(root, engineConfig);
  return { root, created };
}
