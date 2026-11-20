// Slack: the event source (unread DMs and @me), conversation context, and the few write actions
// the DAEMON may take. The agent never gets any of these: its slackcli write commands are denied
// by policy (plan §7).
//
// Every call is an async child process. A collect takes ~18 s of Slack time (mostly
// `conversations unread --messages`); a synchronous call would freeze the whole daemon for that
// long: the API, the panel, the real-time listener and every run's bookkeeping.

import type { Database } from "bun:sqlite";
import type { Profile } from "./config.ts";
import { getMeta, setMeta } from "./db.ts";
import { cleanEnv, clip, log, runProcess, parseJsonLoose, SLACKCLI } from "./util.ts";

const MAX_TEXT = 2000;
const DEFAULT_TIMEOUT_MS = 90_000;

export class SlackCliError extends Error {
  constructor(message: string, public stdout: string, public stderr: string, public exitCode: number | null) {
    super(message);
  }
}

/** Run slackcli without blocking the event loop. `input` goes to stdin (for `--message-file -`). */
export async function slack(args: string[], input?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const { code, stdout, stderr } = await runProcess([process.env.SIDEKICK_SLACKCLI || SLACKCLI, ...args], {
    input,
    timeoutMs,
    env: cleanEnv({ SLACKCLI_NO_UPDATE_NOTIFIER: "1", SLACKCLI_LOG_LEVEL: "warning" }),
  });
  if (code !== 0) {
    throw new SlackCliError(`slackcli ${args.slice(0, 2).join(" ")} exited ${code}: ${(stderr || stdout).trim().slice(-300)}`, stdout, stderr, code);
  }
  return stdout;
}

export async function slackJson<T = any>(args: string[], timeoutMs?: number): Promise<T> {
  return parseJsonLoose<T>(await slack([...args, "--json"], undefined, timeoutMs));
}

// ---- identity, names, links -------------------------------------------------------------------------

export interface Me { userId: string; workspace: string }

/** Who I am, cached in the ledger after the first lookup. */
export async function whoami(db: Database): Promise<Me> {
  const cached = cachedMe(db);
  if (cached) return cached;
  const r = await slackJson<{ user_id: string; workspace_name: string }>(["auth", "whoami"]);
  const me = { userId: r.user_id, workspace: r.workspace_name };
  setMeta(db, "slack.whoami", JSON.stringify(me));
  return me;
}

/** The cached identity, without calling Slack (for read paths such as links in a listing). */
export function cachedMe(db: Database): Me | null {
  const cached = getMeta(db, "slack.whoami");
  return cached ? (JSON.parse(cached) as Me) : null;
}

export function permalink(me: Me, channel: string, ts: string, threadTs?: string | null): string {
  const base = `https://${me.workspace}.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

export interface SlackLink { url: string; channel: string; ts: string; threadTs: string | null }

/**
 * The first Slack message link in some text, the inverse of permalink(): Slack's "Copy link" gives
 * https://<workspace>.slack.com/archives/<channel>/p<ts without its dot>, with ?thread_ts=<root> when
 * the message is a reply inside a thread.
 */
export function parsePermalink(text: string): SlackLink | null {
  const m = /https:\/\/[a-z0-9-]+(?:\.enterprise)?\.slack\.com\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})(\?[^\s<>|)]*)?/.exec(text);
  if (!m) return null;
  const ts = `${m[2]}.${m[3]}`;
  const thread = /[?&]thread_ts=(\d{10}\.\d{6})/.exec(m[4] ?? "")?.[1] ?? null;
  return { url: m[0], channel: m[1], ts, threadTs: thread && thread !== ts ? thread : null };
}

const CHANNEL_CACHE = "slack.channel_cache";
const CHANNEL_NAME_TTL = 7 * 24 * 3600_000;

type ChannelCache = Record<string, { name: string; at: number }>;

/**
 * A channel's name by id. slackcli has no conversations.info, and listing every conversation the
 * workspace exposes takes 60+ pages, so: one message search scoped to the channel (its result
 * carries the channel name), cached per id for a week. Returns null when nothing can be found.
 */
export async function searchChannelName(id: string): Promise<string | null> {
  const r = await slackJson<{ matches?: Array<{ channel?: { id?: string; name?: string } }> }>(
    ["search", "messages", `in:<#${id}>`, "--limit", "1", "--fields", "channel.id,channel.name"],
  );
  const ch = r.matches?.[0]?.channel;
  return ch?.id === id && ch.name ? ch.name : null;
}

export async function channelName(
  db: Database,
  id: string,
  search: (id: string) => string | null | Promise<string | null> = searchChannelName,
  now = Date.now(),
): Promise<string | null> {
  const cache = JSON.parse(getMeta(db, CHANNEL_CACHE) ?? "{}") as ChannelCache;
  const hit = cache[id];
  if (hit && now - hit.at < CHANNEL_NAME_TTL) return hit.name;
  let name: string | null = null;
  try {
    name = await search(id);
  } catch (e) {
    log(`slack: channel name for ${id} failed: ${String(e).slice(0, 200)}`);
  }
  if (!name) return hit?.name ?? null; // keep a stale name rather than none
  const fresh = JSON.parse(getMeta(db, CHANNEL_CACHE) ?? "{}") as ChannelCache; // re-read: another call may have written meanwhile
  fresh[id] = { name, at: now };
  setMeta(db, CHANNEL_CACHE, JSON.stringify(fresh));
  return name;
}

// ---- collect ---------------------------------------------------------------------------------------

export interface SlackMessage { ts: string; thread_ts?: string; user?: string; text?: string; bot_id?: string; subtype?: string }
export interface UnreadChannel {
  id: string; name?: string; mention_count?: number; is_im?: boolean; is_mpim?: boolean; messages?: SlackMessage[];
}
export interface UnreadRich {
  unread_channels?: UnreadChannel[];
  users?: Array<{ id: string; name?: string; real_name?: string }>;
  threads?: { items?: Array<{ channel_id: string; thread_ts: string; unread_replies?: SlackMessage[] }> };
}
export interface Picked { kind: "dm" | "mention"; key: string; channel: string; channelName: string | null; message: SlackMessage }

/**
 * Which unread messages are mine to handle. Only two kinds (decided 2026-11-13):
 *   - a 1:1 DM to me (its threads included)
 *   - a message that @-mentions me personally, in a channel, a group DM or a thread
 * Everything else — other replies in threads I took part in, @here / @channel / group handles,
 * group-DM chatter — is ignored. Pure, so it is unit-tested. Channel names it cannot know from
 * the payload come back null for the caller to look up.
 */
export function pickSlackMessages(rich: UnreadRich, meId: string, channelName: (id: string) => string | null): Picked[] {
  const nameOf = new Map((rich.users ?? []).map((u) => [u.id, u.real_name || u.name || u.id]));
  const human = (m: SlackMessage) => !m.bot_id && m.subtype !== "bot_message" && m.user !== meId;
  const mentionsMe = (m: SlackMessage) => (m.text ?? "").includes(`<@${meId}>`);
  const out: Picked[] = [];

  for (const ch of rich.unread_channels ?? []) {
    const messages = (ch.messages ?? []).filter(human);
    if (ch.is_im) {
      for (const m of messages) out.push({ kind: "dm", key: `slack:${ch.id}:${m.ts}`, channel: ch.id, channelName: nameOf.get(m.user ?? "") ?? ch.name ?? null, message: m });
      continue;
    }
    for (const m of messages.filter(mentionsMe)) {
      out.push({ kind: "mention", key: `slack:${ch.id}:${m.ts}`, channel: ch.id, channelName: ch.name ?? channelName(ch.id), message: m });
    }
  }

  // Thread replies: only from 1:1 DMs, or replies that @ me. One event per reply that qualifies.
  for (const t of rich.threads?.items ?? []) {
    if (!t.channel_id || !t.thread_ts) continue;
    const isDm = t.channel_id.startsWith("D");
    for (const m of (t.unread_replies ?? []).filter(human)) {
      if (!isDm && !mentionsMe(m)) continue;
      out.push({
        kind: isDm ? "dm" : "mention",
        key: `slack:${t.channel_id}:${m.ts}`,
        channel: t.channel_id,
        channelName: isDm ? nameOf.get(m.user ?? "") ?? null : channelName(t.channel_id),
        message: { ...m, thread_ts: t.thread_ts },
      });
    }
  }
  return out;
}

/** Channel names already in the cache, without calling Slack (for pickSlackMessages). */
function cachedChannelName(db: Database): (id: string) => string | null {
  const cache = JSON.parse(getMeta(db, CHANNEL_CACHE) ?? "{}") as ChannelCache;
  return (id) => cache[id]?.name ?? null;
}

/**
 * Pull unread Slack activity into `events` (task_id NULL until intake). Cheap call first, the expensive
 * one with message bodies only when there is something to read. Messages older than the first
 * collect are ignored, so installing the daemon never sweeps an old backlog.
 */
export async function collectSlack(profile: Profile, db: Database): Promise<number> {
  const cfg = profile.slack;
  const me = await whoami(db);
  let since = getMeta(db, "slack.since");
  if (!since) {
    since = String(Date.now() / 1000);
    setMeta(db, "slack.since", since);
    log(`slack: first collect, ignoring messages before ${new Date(Number(since) * 1000).toISOString()}`);
  }

  const cheap = await slackJson<{ unread_channels?: UnreadChannel[]; threads?: { has_unreads?: boolean } }>(
    ["conversations", "unread", "--types", "dms,channels,groups"],
  );
  const channels = cheap.unread_channels ?? [];
  const wanted = channels.filter((c) => c.is_im || (c.mention_count ?? 0) > 0);
  if (wanted.length === 0 && !cheap.threads?.has_unreads) return 0;

  const rich = await slackJson<UnreadRich>(["conversations", "unread", "--types", "dms,channels,groups", "--messages",
    "--max-conversations", String(cfg.maxConversations), "--limit", "20"]);
  const nameOf = new Map((rich.users ?? []).map((u) => [u.id, u.real_name || u.name || u.id]));

  const picked = pickSlackMessages(rich, me.userId, cachedChannelName(db)).filter((p) => Number(p.message.ts) >= Number(since));
  for (const p of picked) {
    if (p.kind === "mention" && !p.channelName) p.channelName = await channelName(db, p.channel);
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events
      (source, kind, dedupe_key, channel, channel_name, ts, thread_ts, user_id, user_name, text, received_at)
    VALUES ('slack', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let added = 0;
  for (const p of picked) {
    const m = p.message;
    const res = insert.run(p.kind, p.key, p.channel, p.channelName, m.ts, m.thread_ts ?? null, m.user ?? null,
      m.user ? nameOf.get(m.user) ?? null : null, clip(m.text, MAX_TEXT), Date.now());
    added += res.changes;
  }
  return added;
}

// ---- context ---------------------------------------------------------------------------------------

export interface ContextLine { ts: string; who: string; userId: string | null; mine: boolean; text: string; files: string[] }

/** The conversation around a message: the whole thread, or the hour before it in a channel/DM. */
export async function fetchContext(db: Database, channel: string, ts: string, threadTs: string | null, limit: number): Promise<ContextLine[]> {
  const me = await whoami(db);
  const args = threadTs
    ? ["conversations", "read", channel, "--thread-ts", threadTs, "--limit", String(limit)]
    : ["conversations", "read", channel, "--oldest", String(Number(ts) - 3600), "--limit", String(Math.min(limit, 30))];
  const data = await slackJson<{ messages?: any[]; users?: Array<{ id: string; name?: string; real_name?: string }> }>(args);
  const names = new Map((data.users ?? []).map((u) => [u.id, u.real_name || u.name || u.id]));
  return (data.messages ?? [])
    .map((m) => ({
      ts: String(m.ts),
      userId: m.user ?? null,
      who: m.bot_id ? "bot" : names.get(m.user) ?? m.user ?? "?",
      mine: m.user === me.userId,
      text: String(m.text ?? ""),
      files: (m.files ?? []).map((f: { name?: string; id: string }) => f.name ?? f.id),
    }))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

export function mentionedUsers(text: string | null): Set<string> {
  return new Set([...(text ?? "").matchAll(/<@(U[A-Z0-9]+)>/g)].map((m) => m[1]));
}

// ---- did I already answer in Slack? ----------------------------------------------------------------

const DRAFT_LIST_LIMIT = 500;

/** A Slack user group (S…): its handle and member ids, for profile.yaml autoReply rules (mcp.ts) and run facts (facts.ts). */
export async function usergroup(id: string): Promise<{ handle: string | null; members: string[] }> {
  const g = await slackJson<{ handle?: string; member_ids?: string[] }>(["usergroups", "read", id, "--json", "--fields", "handle,member_ids"]);
  return { handle: typeof g?.handle === "string" ? g.handle : null, members: Array.isArray(g?.member_ids) ? g.member_ids : [] };
}

/**
 * Ids of my drafts Slack still holds unsent (list-drafts leaves out sent and deleted ones). Null when
 * the list may be cut off, since then a missing draft could just be unlisted.
 */
export async function liveDraftIds(): Promise<Set<string> | null> {
  const r = await slackJson<{ drafts?: Array<{ draft_id: string }> }>(["messages", "list-drafts", "--limit", String(DRAFT_LIST_LIMIT)]);
  const drafts = r.drafts ?? [];
  return drafts.length >= DRAFT_LIST_LIMIT ? null : new Set(drafts.map((d) => d.draft_id));
}

/** The first message I posted in this conversation (or thread) after `sinceSec`, or null if none. */
export async function myMessageSince(db: Database, channel: string, threadTs: string | null, sinceSec: number): Promise<string | null> {
  const me = await whoami(db);
  const args = ["conversations", "read", channel, "--oldest", String(sinceSec), "--limit", "100"];
  if (threadTs) args.push("--thread-ts", threadTs);
  const data = await slackJson<{ messages?: Array<{ ts: string; user?: string; bot_id?: string; text?: string }> }>(args);
  const mine = (data.messages ?? [])
    .filter((m) => m.user === me.userId && !m.bot_id && Number(m.ts) > sinceSec) // a thread read always includes its parent
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  return mine.length ? mine[0].text ?? "" : null;
}

// ---- daemon-only writes ----------------------------------------------------------------------------

/** An unsent draft in the Slack composer: I can still edit and send it from Slack myself. */
export async function createDraft(channel: string, threadTs: string | null, text: string): Promise<string> {
  const args = ["messages", "draft", "--recipient-id", channel, "--message-file", "-", "--json"];
  if (threadTs) args.push("--thread-ts", threadTs);
  return parseJsonLoose<{ draft_id: string }>(await slack(args, text)).draft_id;
}

export async function sendDraft(draftId: string): Promise<void> {
  await slack(["messages", "send-draft", draftId, "--yes", "--json"]);
}

export async function deleteDraft(draftId: string): Promise<void> {
  try {
    // Non-interactive writes need --yes, or slackcli refuses with confirmation_required.
    await slack(["messages", "delete-draft", draftId, "--yes", "--json"]);
  } catch (e) {
    const err = e as SlackCliError;
    const msg = `${err.stdout ?? ""}${err.stderr ?? ""}${err.message}`;
    // Already sent or deleted from Slack by hand is fine; anything else must surface.
    if (!/not_found|draft_delete_invalid|no such draft|already/i.test(msg)) throw new Error(`delete-draft ${draftId} failed: ${msg.slice(0, 300)}`);
  }
}

/** Post as me. Only called when executing a reply I approved (approvals.ts), never on the agent's behalf. */
export async function sendMessage(channel: string, threadTs: string | null, text: string, blocks?: unknown[]): Promise<void> {
  const args = ["messages", "send", "--recipient-id", channel, "--message-file", "-", "--json"];
  if (threadTs) args.push("--thread-ts", threadTs);
  // With blocks, `text` is only the fallback for notifications and search.
  if (blocks) args.push("--blocks", JSON.stringify(blocks));
  await slack(args, text);
}

/** DM myself. Refuses any other recipient: the only message the daemon posts unasked. */
export async function dmSelf(db: Database, text: string): Promise<void> {
  const me = await whoami(db);
  await slack(["messages", "send", "--recipient-id", me.userId, "--message-file", "-", "--json"], text);
}
