// Test runs (试跑) for the persona editor: handle a past Slack message the way a real task would,
// with the persona as it is on disk now, but outside the task system. No sidekick MCP server, so
// nothing can be proposed; no task, so no draft in Slack, no reaction, no card, no notification.

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Profile } from "./config.ts";
import type { EventRow, TaskRow } from "./db.ts";
import { runFacts } from "./facts.ts";
import { launchSpec, slackTaskPrompt, toolSetFor } from "./handle.ts";
import { t } from "./i18n.ts";
import { startRun, type RunHandle } from "./runner.ts";
import { loadSettings } from "./settings.ts";
import { fetchContext, permalink, whoami } from "./slack.ts";
import { clip, extractJson, log, newId } from "./util.ts";

const TRIAL_RULES = [
  "这是一次试跑，用来检验使用者的分身资料写得好不好。假装现在是这条消息刚到的时候：上下文里只有它之前的消息。",
  "这次没有 mcp__sidekick__propose 和 mcp__sidekick__report：skill 里要你调用它们的地方，都改成最后输出下面的 JSON。",
  "只读：可以按 skill 查资料，但不要发消息、建草稿、加 reaction、评论、流转、approve、合并、部署，也不要改任何文件。规则里让你直接做的动作（比如直接 approve PR），这里都只写进 JSON 说你会做什么。",
  "最后只输出一个 JSON 对象，不要代码块，不要别的话：",
  '{"action":"reply、no_reply 或 needs_me","judgement":"为什么这样判断，一两句","draft":"要回复时的正文，否则 null"}',
].join("\n");

export interface TrialSample {
  id: number;
  kind: string;
  channel_name: string | null;
  user_name: string | null;
  text: string;
  received_at: number;
}

/** Recent Slack messages to try the persona on. */
export function trialSamples(db: Database, limit = 20): TrialSample[] {
  const rows = db.prepare(`SELECT id, kind, channel_name, user_name, text, received_at FROM events
    WHERE source = 'slack' AND text IS NOT NULL AND text != '' ORDER BY received_at DESC LIMIT ?`).all(limit) as TrialSample[];
  // Mentions are raw ids (<@U123>) in the ledger; the label only needs to be recognisable.
  const someone = t("@某人", "@someone");
  return rows.map((r) => ({ ...r, text: clip(r.text.replace(/<@[A-Z0-9]+>/g, someone), 300) }));
}

export interface TrialResult {
  action: "reply" | "no_reply" | "needs_me";
  judgement: string;
  draft: string | null;
}

export interface Trial {
  id: string;
  eventId: number;
  status: "running" | "done" | "failed";
  startedAt: number;
  endedAt: number | null;
  costUsd: number | null;
  result: TrialResult | null;
  error: string | null;
}

/** The model's answer, checked: an action we know, a judgement, a draft only when replying. */
export function parseTrialResult(text: string): TrialResult {
  const o = extractJson<Record<string, unknown>>(text, "object");
  const action = String(o.action ?? "");
  if (action !== "reply" && action !== "no_reply" && action !== "needs_me") throw new Error(t(`试跑结果的 action 不对：${clip(action, 40)}`, `The dry run returned an unknown action: ${clip(action, 40)}`));
  const draft = typeof o.draft === "string" && o.draft.trim() ? o.draft.trim() : null;
  return { action, judgement: clip(String(o.judgement ?? ""), 2000), draft: action === "reply" ? draft : null };
}

const KEEP = 10;

export class Trials {
  private readonly trials = new Map<string, Trial>();
  private handle: RunHandle | null = null;

  constructor(private readonly profile: Profile, private readonly db: Database) {}

  get(id: string): Trial | null {
    return this.trials.get(id) ?? null;
  }

  /** One at a time: each costs about as much as handling a real message. */
  start(eventId: number): Trial {
    if ([...this.trials.values()].some((x) => x.status === "running")) throw new Error(t("已经有一个试跑在跑了，等它结束", "A dry run is already running; wait for it to finish"));
    const ev = this.db.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as EventRow | null;
    if (!ev || ev.source !== "slack" || !ev.channel || !ev.ts) throw new Error(t("没有这条 Slack 消息", "No such Slack message"));
    const trial: Trial = { id: newId("x"), eventId, status: "running", startedAt: Date.now(), endedAt: null, costUsd: null, result: null, error: null };
    this.trials.set(trial.id, trial);
    for (const old of [...this.trials.keys()].slice(0, -KEEP)) this.trials.delete(old);
    this.run(trial, ev).catch((e) => {
      trial.status = "failed";
      trial.error = clip(String((e as Error).message ?? e), 500);
      trial.endedAt = Date.now();
      log(`trial: ${trial.id} failed: ${trial.error}`);
    });
    return trial;
  }

  stop(): void {
    this.handle?.cancel();
  }

  private async run(trial: Trial, ev: EventRow): Promise<void> {
    const { profile, db } = this;
    const me = await whoami(db);
    let context: Awaited<ReturnType<typeof fetchContext>> = [];
    try {
      context = (await fetchContext(db, ev.channel!, ev.ts!, ev.thread_ts, profile.slack.contextMessages)).filter((l) => Number(l.ts) <= Number(ev.ts));
    } catch (e) {
      log(`trial: context for event ${ev.id} failed: ${String(e).slice(0, 200)}`);
    }
    const task = { id: trial.id, source: "slack" } as TaskRow;
    const base = slackTaskPrompt(profile, task, ev, permalink(me, ev.channel!, ev.ts!, ev.thread_ts), context);
    const facts = await runFacts(profile, base, ev.user_id ? [{ id: ev.user_id, name: ev.user_name }] : []);
    const prompt = [base, facts, TRIAL_RULES].filter(Boolean).join("\n\n");
    const runDir = join(profile.stateDir, "runs");
    // The same launch as a real task (model, rules, persona, deny list), minus the sidekick tools.
    const spec = { ...launchSpec(profile, task, trial.id, join(profile.stateDir, "sidekick.db"), loadSettings(), toolSetFor(null, false, prompt)), sidekickMcp: undefined };
    log(`trial: ${trial.id} on event ${ev.id}`);
    this.handle = startRun(spec, prompt, { id: crypto.randomUUID(), resume: false }, join(runDir, `${trial.id}.jsonl`), runDir);
    const r = await this.handle.done;
    this.handle = null;
    trial.costUsd = r.costUsd;
    trial.endedAt = Date.now();
    if (r.isError || r.timedOut) throw new Error(r.timedOut ? t("超时", "Timed out") : clip(r.text, 300) || t("没有结果", "No result"));
    trial.result = parseTrialResult(r.text);
    trial.status = "done";
    log(`trial: ${trial.id} → ${trial.result.action} $${r.costUsd?.toFixed(3) ?? "?"}`);
  }
}
