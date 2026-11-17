// The persona (分身): who I am, what I own, how I talk, what must never be promised for me.
//
// Plain Markdown files in the workspace (profile.persona, default sidekick/me.md), written by the
// person themselves, mostly from the panel. Every run gets them in its system prompt, so the agent
// cannot skip them and a change applies from the next task on.

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import template from "../templates/me.md" with { type: "text" };
import type { Profile } from "./config.ts";
import { clip } from "./util.ts";

export const PERSONA_TEMPLATE: string = template;
/** Per file, in the system prompt. A persona longer than this is not a persona any more. */
const MAX_PROMPT_CHARS = 30_000;
export const MAX_PERSONA_CHARS = 100_000;

export interface PersonaFile {
  path: string;
  exists: boolean;
  content: string;
  /** For conflict detection: the edit must start from what is on disk. */
  mtime: number | null;
}

export class PersonaConflict extends Error {}

/** A persona path must be one the profile lists, and stay inside the workspace. */
export function isSafeRelative(rel: string): boolean {
  if (!rel || rel.startsWith("/") || rel.startsWith("~")) return false;
  const n = normalize(rel);
  return !n.startsWith("..") && !n.split("/").includes("..") && n.endsWith(".md");
}

function resolve(profile: Pick<Profile, "root" | "persona">, rel: string): string {
  if (!profile.persona.includes(rel) || !isSafeRelative(rel)) throw new Error(`${rel} 不是这个 profile 的分身文件`);
  return join(profile.root, normalize(rel));
}

export function readPersona(profile: Pick<Profile, "root" | "persona">): PersonaFile[] {
  return profile.persona.map((rel) => {
    const abs = resolve(profile, rel);
    if (!existsSync(abs)) return { path: rel, exists: false, content: "", mtime: null };
    return { path: rel, exists: true, content: readFileSync(abs, "utf8"), mtime: statSync(abs).mtimeMs };
  });
}

/**
 * Save one persona file. `baseMtime` is the mtime the editor loaded (null: it did not exist); if the
 * file changed on disk since (edited in an editor, pulled from git), refuse instead of overwriting.
 */
export function writePersona(profile: Pick<Profile, "root" | "persona">, rel: string, content: string, baseMtime: number | null): PersonaFile {
  const abs = resolve(profile, rel);
  if (content.length > MAX_PERSONA_CHARS) throw new Error(`分身文件超过 ${MAX_PERSONA_CHARS} 个字符`);
  const current = existsSync(abs) ? statSync(abs).mtimeMs : null;
  if (current !== baseMtime) throw new PersonaConflict(`${rel} 在别处改过了，先重新加载再改`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return { path: rel, exists: true, content, mtime: statSync(abs).mtimeMs };
}

/** Comments, headings and empty bullets removed: what the person actually wrote. */
function writtenPart(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !/^[-*]\s*[^：:]*[：:]\s*$/.test(l))
    .join("\n");
}

/** Whether a persona still says nothing beyond the template. */
export function isUnwritten(content: string): boolean {
  const written = writtenPart(content);
  return written === "" || written === writtenPart(PERSONA_TEMPLATE);
}

/** The persona section of the system prompt; empty when nothing is written yet. */
export function personaPrompt(profile: Pick<Profile, "root" | "persona">): string {
  const files = readPersona(profile).filter((f) => f.exists && !isUnwritten(f.content));
  if (files.length === 0) return "";
  return [
    "下面是使用者自己写的分身资料：他是谁、负责什么、怎么说话、哪些事不能替他答应。",
    "判断要不要回、怎么回，都以这份资料为准；资料没写到、又拿不准的，交给使用者自己看。",
    ...files.map((f) => `\n=== ${f.path} ===\n${clip(f.content.replace(/<!--[\s\S]*?-->/g, ""), MAX_PROMPT_CHARS)}`),
  ].join("\n");
}

// ---- a prompt for refining the persona with my own agent ----------------------------------------------

/** One reply of sidekick's that I changed or turned down: the material the persona is made of. */
export interface Correction { at: number; title: string; draft: string; what: string }

/**
 * Replies I edited before they went out (in Slack or in sidekick), rejected (with or without a word),
 * or whose draft I deleted in Slack. Not replaced or cancelled cards: those say nothing about me.
 */
export function recentCorrections(db: Database, limit = 20): Correction[] {
  const rows = db.prepare(`
    SELECT a.created_at, a.status, a.result, a.decision_note, a.payload, t.title
    FROM approvals a JOIN tasks t ON t.id = a.task_id
    WHERE a.kind = 'outbound' AND (
      (a.result = 'sent in Slack' AND json_extract(a.payload, '$.sentText') IS NOT json_extract(a.payload, '$.text'))
      OR (a.status = 'executed' AND json_extract(a.payload, '$.editedText') IS NOT NULL)
      OR (a.status = 'denied' AND COALESCE(a.result, '') NOT IN ('superseded', 'discarded: task cancelled'))
    )
    ORDER BY a.created_at DESC LIMIT ?`).all(limit) as Array<{ created_at: number; status: string; result: string | null; decision_note: string | null; payload: string; title: string }>;
  return rows.map((r) => {
    const p = JSON.parse(r.payload) as { text?: string; sentText?: string; editedText?: string };
    const what =
      r.result === "sent in Slack" ? `我在 Slack 里改成：${clip(p.sentText ?? "", 300)}`
      : typeof p.editedText === "string" ? `我改成：${clip(p.editedText, 300)}`
      : r.result === "draft deleted in Slack" ? "我在 Slack 里删了草稿，没有回"
      : r.decision_note ? `我拒绝了，意见：${clip(r.decision_note, 300)}`
      : "我拒绝了，没写原因";
    return { at: r.created_at, title: clip(r.title.replace(/<@[A-Z0-9]+>/g, "@某人"), 80), draft: clip(p.text ?? "", 300), what };
  });
}

const day = (ms: number) => new Date(ms).toLocaleDateString("sv-SE"); // YYYY-MM-DD, local time

/**
 * What the persona page copies for my own agent (Claude Code or any other): where the files are, what
 * each part is for, how to go about it, and the replies I corrected lately as evidence. Few people
 * will write the persona by hand; an agent that interviews them and reads their corrections will.
 */
export function refinePrompt(profile: Pick<Profile, "root" | "persona">, db: Database): { prompt: string; corrections: number } {
  const files = readPersona(profile).map((f) => {
    const state = !f.exists ? "还没有这个文件，新建" : isUnwritten(f.content) ? "还是模板，没写" : `已写 ${f.content.length} 字`;
    return `- ${join(profile.root, f.path)}（${state}）`;
  });
  const corrections = recentCorrections(db);
  const evidence = corrections.length
    ? corrections.map((c) => `- ${day(c.at)} ${c.title}\n  sidekick 起草：${c.draft}\n  ${c.what}`)
    : ["（暂时没有。用 sidekick 审批一段时间后再复制一次，这里会有更多依据。）"];
  const prompt = [
    "帮我完善 sidekick 的「分身」资料。",
    "",
    "sidekick 是我电脑上常驻的 Slack 助手：私信我、@ 我的消息，它先判断要不要回，要回就查证据、起草，交给我审批后再发。分身资料会原样放进它每次处理消息的系统提示，它照着判断要不要回、怎么回、哪些事一定交给我。写得越具体，它越像我。",
    "",
    "要完善的文件（直接改这些文件，sidekick 下一条消息就会用上）：",
    ...files,
    "",
    "每一节写什么（按文件里已有的标题来，没有的就补上）：",
    "- 我是谁：角色和团队，平时用什么语言回消息。",
    "- 我负责什么：负责的产品和模块，代码在本机哪些目录，哪些事不归我管、该找谁。",
    "- 怎么回话：语气、长短、常用说法；对工程师和对非工程师有什么不同。",
    "- 红线：不能替我答应的事，比如排期、上线时间、新需求、会议。",
    "- 一定交给我自己看的：哪些人、哪些话题、哪些情况。",
    "- 被纠正记录：从下面我改过、拒绝过的回复里总结教训，每条带日期。",
    "",
    "怎么做：",
    "1. 先读上面的文件，再看下面我最近改过和拒绝过的回复，总结出我在意什么。",
    "2. 能自己查到的先查，比如我负责哪些仓库，就看本机的代码目录和 git 提交记录。查不到的再问我，一次只问一个问题，不要猜。",
    "3. 每一节写几条短句，不要写成文章。不要写进 token、密码和客户数据。单个文件不要超过 3 万字，多出来的 sidekick 不会读。",
    "4. 改完先把改动给我看，我确认了再保存。",
    "",
    `我最近改过和拒绝过的回复（sidekick 账本里最近 ${corrections.length} 条）：`,
    ...evidence,
  ].join("\n");
  return { prompt, corrections: corrections.length };
}
