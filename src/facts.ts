// Facts the daemon looks up before a run and puts at the end of its prompt, so the agent does not spend
// turns finding them out: every tool call re-reads the whole context. The workspace's PR rules had each
// run read two user groups and `gh pr view` before deciding anything (2026-11-19). A fact that cannot be
// looked up is left out, and the agent looks it up itself, as before.

import type { Profile } from "./config.ts";
import { usergroup } from "./slack.ts";
import { cleanEnv, log, parseJsonLoose, runProcess } from "./util.ts";

// ---- who sent it ------------------------------------------------------------------------------------

export interface Sender { id: string; name: string | null }
export interface Group { id: string; handle: string | null; members: string[] }

/** The user groups the profile names (autoReply `from`): the groups a decision may turn on. */
export function profileGroups(profile: Pick<Profile, "autoReply">): string[] {
  return [...new Set(profile.autoReply.flatMap((r) => r.from.filter((f) => f.startsWith("S"))))];
}

export function groupLines(senders: Sender[], groups: Group[]): string[] {
  if (!groups.length) return [];
  const name = (g: Group) => (g.handle ? `@${g.handle}` : g.id);
  return senders.map((s) => {
    const inside = groups.filter((g) => g.members.includes(s.id)).map(name);
    const outside = groups.filter((g) => !g.members.includes(s.id)).map(name);
    const parts = [inside.length ? `在 ${inside.join("、")} 里` : "", outside.length ? `不在 ${outside.join("、")} 里` : ""].filter(Boolean);
    return `- 发消息的人 ${s.name ?? s.id}（${s.id}）${parts.join("，")}。`;
  });
}

const GROUP_TTL_MS = 60 * 60_000;
const groupCache = new Map<string, { at: number; group: Group }>();

async function cachedGroup(id: string): Promise<Group | null> {
  const hit = groupCache.get(id);
  if (hit && Date.now() - hit.at < GROUP_TTL_MS) return hit.group;
  try {
    const group = { id, ...(await usergroup(id)) };
    groupCache.set(id, { at: Date.now(), group });
    return group;
  } catch (e) {
    log(`facts: user group ${id} failed: ${String(e).slice(0, 200)}`);
    return null;
  }
}

// ---- GitHub PRs it links to -------------------------------------------------------------------------

export interface PrRef { repo: string; number: number }

/** GitHub PR links in the text, first ones first, at most `max`. */
export function prLinks(text: string, max = 3): PrRef[] {
  const out: PrRef[] = [];
  for (const m of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) {
    if (out.some((p) => p.repo === m[1] && p.number === Number(m[2]))) continue;
    out.push({ repo: m[1], number: Number(m[2]) });
    if (out.length >= max) break;
  }
  return out;
}

export interface PrView {
  title: string;
  author: { login: string };
  state: string;
  isDraft: boolean;
  reviewDecision: string;
  reviewRequests: Array<{ login?: string }>;
  latestReviews: Array<{ author: { login: string }; state: string }>;
}

const STATE: Record<string, string> = { OPEN: "开着", MERGED: "已合并", CLOSED: "已关闭" };
const DECISION: Record<string, string> = { APPROVED: "已通过", CHANGES_REQUESTED: "被要求修改", REVIEW_REQUIRED: "还要 review" };
const MY_REVIEW: Record<string, string> = { APPROVED: "已经 approve 过", CHANGES_REQUESTED: "要求过修改", COMMENTED: "评论过", DISMISSED: "review 被撤销了" };

/** `me`: the user's GitHub login, null when unknown (then nothing is said about them). */
export function prLine(ref: PrRef, pr: PrView, me: string | null): string {
  const parts = [
    `作者 ${pr.author.login}${me && pr.author.login === me ? "（就是使用者自己）" : ""}`,
    `${STATE[pr.state] ?? pr.state}${pr.isDraft ? "，草稿" : ""}`,
    `review 状态：${DECISION[pr.reviewDecision] ?? "没有要求"}`,
  ];
  if (me && pr.author.login !== me) {
    const mine = pr.latestReviews.find((r) => r.author.login === me);
    const asked = pr.reviewRequests.some((r) => r.login === me);
    parts.push(`使用者${mine ? MY_REVIEW[mine.state] ?? mine.state : "还没 review"}${asked ? "，在待 review 名单里" : ""}`);
  }
  return `- PR ${ref.repo}#${ref.number}「${pr.title}」：${parts.join("；")}。`;
}

const GH_TIMEOUT_MS = 20_000;
const PR_FIELDS = "title,author,state,isDraft,reviewDecision,reviewRequests,latestReviews";

/** gh's JSON output, or null when gh is missing, not signed in, or says no. */
async function ghJson<T>(args: string[]): Promise<T | null> {
  const env = cleanEnv();
  const gh = Bun.which("gh", { PATH: env.PATH });
  if (!gh) return null;
  const { code, stdout, stderr } = await runProcess([gh, ...args], { env, timeoutMs: GH_TIMEOUT_MS });
  if (code !== 0) {
    log(`facts: gh ${args.slice(0, 3).join(" ")} failed: ${(stderr || stdout).trim().slice(-200)}`);
    return null;
  }
  try {
    return parseJsonLoose<T>(stdout);
  } catch {
    return null;
  }
}

let ghLogin: string | null = null;

/** The user's GitHub login, kept once found. */
async function myLogin(): Promise<string | null> {
  ghLogin ??= (await ghJson<{ login: string }>(["api", "user"]))?.login ?? null;
  return ghLogin;
}

// ---- the block ----------------------------------------------------------------------------------------

/** The facts for a run: whether each sender is in the profile's groups, and the state of linked PRs. "" when none. */
export async function runFacts(profile: Pick<Profile, "autoReply">, text: string, senders: Sender[]): Promise<string> {
  const refs = prLinks(text);
  const [groups, me, prs] = await Promise.all([
    senders.length ? Promise.all(profileGroups(profile).map(cachedGroup)) : Promise.resolve([]),
    refs.length ? myLogin() : Promise.resolve(null),
    Promise.all(refs.map((r) => ghJson<PrView>(["pr", "view", String(r.number), "-R", r.repo, "--json", PR_FIELDS]))),
  ]);
  const lines = [
    ...groupLines(senders, groups.filter((g): g is Group => g !== null)),
    ...refs.flatMap((r, i) => (prs[i] ? [prLine(r, prs[i]!, me)] : [])),
  ];
  if (!lines.length) return "";
  return ["sidekick 在这一轮开始前查好的事实（直接用，不用再查）：", ...lines].join("\n");
}
