// The daemon loop: collect → intake (events → tasks) → act on decisions → start queued tasks → notify.
// Reconciles the ledger with reality first, so a restart never double-dispatches (plan §6).

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_NOTE, processDecisions, reconcileDrafts } from "./approvals.ts";
import type { Profile } from "./config.ts";
import { openDb, setTaskStatus, type RunRow, type TaskRow } from "./db.ts";
import { AutoDoctor, runDoctor } from "./doctor.ts";
import { notifyAutoSent, notifyLocal, notifyPending } from "./notify.ts";
import { Realtime, type SlackStatus } from "./realtime.ts";
import { startServer, startSetupServer } from "./server.ts";
import { Trials } from "./trial.ts";
import { SlackLogin } from "./slacklogin.ts";
import { checkForUpdate, type UpdateInfo } from "./update.ts";
import type { RunHandle } from "./runner.ts";
import { setLang, t } from "./i18n.ts";
import { effectiveMode, loadSettings, timetableSwitch, uiLang } from "./settings.ts";
import { cachedMe, collectSlack, dmSelf } from "./slack.ts";
import { intakeSlack } from "./intake.ts";
import { startTaskRun } from "./handle.ts";
import { log, setLogDir } from "./util.ts";

const TICK_MS = 15_000;

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One daemon per profile state dir. */
function lock(stateDir: string): void {
  const file = join(stateDir, "daemon.pid");
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8"));
    if (pid !== process.pid && alive(pid)) throw new Error(`sidekick daemon already running (pid ${pid})`);
  }
  writeFileSync(file, String(process.pid));
}

/** Runs the ledger thinks are live but whose process is gone: end them and requeue their tasks. */
export function reconcile(db: Database): number {
  const stale = db.prepare("SELECT * FROM runs WHERE ended_at IS NULL").all() as RunRow[];
  let n = 0;
  for (const r of stale) {
    if (alive(r.pid)) {
      // A claude from a previous daemon still running: its output pipe is gone, stop it.
      try { process.kill(r.pid!, "SIGTERM"); } catch { /* already gone */ }
    }
    db.prepare("UPDATE runs SET ended_at = ?, error = 'daemon restart' WHERE id = ?").run(Date.now(), r.id);
    n += 1;
  }
  const running = db.prepare("SELECT * FROM tasks WHERE status = 'running'").all() as TaskRow[];
  for (const t of running) setTaskStatus(db, t.id, "queued");
  return n + running.length;
}

export interface DaemonOptions {
  /** Do not touch Slack at all: no collecting, no self DM. For local testing. */
  noSlack?: boolean;
}

/** No usable workspace yet: serve only the setup page (and diagnosis) until one is chosen. */
export async function runSetup(reason: string): Promise<never> {
  log(`daemon: waiting to be set up: ${reason.split("\n")[0]}`);
  const doctor = new AutoDoctor(() => runDoctor({ profile: null, profileError: reason, db: null, inDaemon: true }), () => {});
  startSetupServer({ reason, doctor });
  const stop = () => process.exit(0);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return new Promise<never>(() => {}); // the server keeps the process alive; setup restarts it
}

export async function runDaemon(profiles: Profile[], opts: DaemonOptions = {}): Promise<never> {
  setLang(uiLang());
  const states = profiles.map((p) => {
    setLogDir(join(p.stateDir, "logs"));
    const db = openDb(p.stateDir);
    lock(p.stateDir);
    const fixed = reconcile(db);
    log(`daemon: started for profile ${p.name} (pid ${process.pid})${fixed ? `, reconciled ${fixed}` : ""}`);
    return {
      profile: p,
      db,
      running: new Map<string, RunHandle>(),
      /** When the last collect started (also a failed one: the next waits a full poll interval). */
      lastAttempt: 0,
      collectingSince: null as number | null,
      lastCollect: null as SlackStatus["lastCollect"],
    };
  });
  const first = states[0];
  const slackOn = (p: Profile) => !opts.noSlack && p.slack.enabled;
  const pollMinutes = (p: Profile) => loadSettings().pollMinutes ?? p.slack.pollMinutes;

  // Sleep between ticks, but let the Slack listener cut it short.
  let wake: (() => void) | null = null;
  const nap = () => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, TICK_MS);
    wake = () => { clearTimeout(t); resolve(); };
  });

  // Real-time Slack (opt-in): a DM or @me on the socket means "collect now" instead of on the next poll.
  let collectRequested = false;
  // I posted where a reply card waits: maybe I sent its draft from Slack. Look a moment later, once
  // Slack has taken the draft off its list.
  let draftsRequested = false;
  const realtime = new Realtime({
    me: () => cachedMe(first.db)?.userId ?? "",
    onCollect: (reason) => {
      log(`listener: collect now (${reason})`);
      collectRequested = true;
      wake?.();
    },
    onMine: (channel) => {
      const waiting = first.db.prepare("SELECT 1 FROM approvals WHERE status = 'pending' AND kind = 'outbound' AND json_extract(payload, '$.channel') = ? LIMIT 1").get(channel);
      if (!waiting) return;
      setTimeout(() => {
        draftsRequested = true;
        wake?.();
      }, 3_000);
    },
    onFallback: (reason) => notifyLocal(
      t("sidekick：Slack 实时连接已回退到轮询", "sidekick: Slack realtime fell back to polling"),
      t(
        `${reason}。轮询照常，15 分钟后再试实时；面板 → 设置 → 诊断 有详情。`,
        `${reason}. Polling goes on, and realtime is tried again in 15 min. Details in the panel → Settings → Diagnostics.`,
      ),
    ),
  });
  const applyRealtime = () => realtime.update(slackOn(first.profile) && loadSettings().realtime);

  const slackStatus = (): SlackStatus => ({
    enabled: slackOn(first.profile),
    realtime: realtime.view(),
    pollMinutes: pollMinutes(first.profile),
    collectingSince: first.collectingSince,
    lastCollect: first.lastCollect,
    nextCollectAt: slackOn(first.profile) && first.lastAttempt ? first.lastAttempt + pollMinutes(first.profile) * 60_000 : null,
  });

  // Diagnosis: shortly after start, every 6 h, soon after a collect fails, and from the panel.
  const doctor = new AutoDoctor(
    () => runDoctor({ profile: first.profile, db: first.db, slack: slackStatus() }),
    (bad) => notifyLocal(
      t("sidekick 诊断发现问题", "sidekick diagnostics found a problem"),
      t(
        `${bad.map((c) => c.name).join("、")}有问题。面板 → 设置 → 诊断 看怎么修。`,
        `Problem with ${bad.map((c) => c.name).join(", ")}. See how to fix it in the panel → Settings → Diagnostics.`,
      ),
    ),
  );

  // Signing in to Slack from the panel: afterwards the cached account may be someone else's, a fallen-back
  // socket can try again, and the panel's diagnosis should say so at once.
  const slackLogin = new SlackLogin(() => {
    first.db.prepare("DELETE FROM meta WHERE k = 'slack.whoami'").run();
    if (loadSettings().realtime) realtime.retryNow();
    doctor.runNow(true).catch((e) => log(`doctor: after sign-in failed: ${String(e).slice(0, 200)}`));
  });

  // The API serves the first profile; the menu bar app talks to it.
  let lastClient = 0;
  const trials = new Trials(first.profile, first.db);
  startServer({
    profile: first.profile,
    db: first.db,
    onClientSeen: () => { lastClient = Date.now(); },
    slack: slackStatus,
    update: () => update,
    doctor,
    onSettingsChanged: () => { setLang(uiLang()); applyRealtime(); wake?.(); },
    realtimeRetry: () => realtime.retryNow(),
    trials,
    slackLogin,
  });
  if (opts.noSlack) log("daemon: --no-slack, Slack is left alone");

  const shutdown = () => {
    realtime.stop();
    trials.stop();
    for (const s of states) {
      for (const [taskId, h] of s.running) {
        h.cancel();
        setTaskStatus(s.db, taskId, "queued");
      }
      log("daemon: stopping");
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Full mode on a timetable: tell me when it starts and ends, so a lunch break never goes unnoticed.
  // A change I made by hand needs no telling.
  let seen = { manual: loadSettings().mode, mode: effectiveMode(loadSettings()).mode };
  const announceMode = async () => {
    const s = loadSettings();
    const r = timetableSwitch(seen, s);
    seen = r.seen;
    const now = r.announce;
    if (!now) return;
    const until = now.until ? new Date(now.until).toTimeString().slice(0, 5) : "";
    const [title, body] = now.mode === "full"
      ? [
          t("sidekick：已切到全托管", "sidekick: switched to Full auto"),
          t(
            `按时间表，到 ${until}。这段时间起草的回复会直接以你的名义发出，每条都私信你一份。`,
            `On schedule, until ${until}. Replies drafted until then go out in your name directly, and you get a copy of each in a Slack DM.`,
          ),
        ]
      : [
          t("sidekick：已切回半托管", "sidekick: back to Approve first"),
          t("全托管时段结束，之后的回复都要你批。", "The Full auto time window has ended; replies need your approval again."),
        ];
    log(`mode: ${now.mode} by timetable`);
    if (s.notifyMacos ?? first.profile.notify.macos) notifyLocal(title, body);
    if (!opts.noSlack && (s.notifySlackDm ?? first.profile.notify.slackSelfDm)) {
      await dmSelf(first.db, `${title}\n${body}`).catch((e) => log(`notify: slack self DM failed: ${String(e).slice(0, 200)}`));
    }
  };

  // A newer release on GitHub: checked at start and every 6 hours, never in the way of the loop.
  let update: UpdateInfo | null = null;
  let updateCheckedAt = 0;

  for (;;) {
    setLang(uiLang()); // a hand-edited settings.json takes effect on the next tick
    await announceMode();
    if (Date.now() - updateCheckedAt > 6 * 3_600_000) {
      updateCheckedAt = Date.now();
      checkForUpdate().then((u) => { update = u; });
    }
    applyRealtime();
    doctor.tick();
    for (const s of states) {
      const { profile, db, running } = s;
      try {
        const due = Date.now() - s.lastAttempt >= pollMinutes(profile) * 60_000;
        let collected = false;
        if (slackOn(profile) && (due || (s === first && collectRequested))) {
          if (s === first) collectRequested = false;
          collected = true;
          const at = Date.now();
          s.lastAttempt = at;
          s.collectingSince = at;
          try {
            const added = await collectSlack(profile, db);
            s.lastCollect = { at, ms: Date.now() - at, added };
            if (added) log(`slack: ${added} new event(s)`);
          } catch (e) {
            const error = String((e as Error).message ?? e).slice(0, 300);
            s.lastCollect = { at, ms: Date.now() - at, added: 0, error };
            log(`slack: collect failed: ${error}`);
            if (s === first) doctor.soon();
          } finally {
            s.collectingSince = null;
          }
        }
        if (slackOn(profile) && (collected || (s === first && draftsRequested))) {
          if (s === first) draftsRequested = false;
          try {
            const settled = await reconcileDrafts(db, (id) => running.has(id));
            if (settled) log(`slack: ${settled} reply card(s) settled from Slack`);
          } catch (e) {
            log(`slack: checking drafts failed: ${String((e as Error).message ?? e).slice(0, 300)}`);
          }
        }
        intakeSlack(db);
        const settings = loadSettings();
        const channels = {
          // The menu bar app shows its own notifications with buttons while it is open.
          macos: (settings.notifyMacos ?? profile.notify.macos) && Date.now() - lastClient > 60_000,
          slack: !opts.noSlack && (settings.notifySlackDm ?? profile.notify.slackSelfDm),
        };
        await processDecisions(db, (id) => running.has(id), undefined, async (a, text) => {
          // Full mode said something on my behalf: always tell me what, so I can follow up.
          if (a.decision_note === AUTO_NOTE) await notifyAutoSent(db, a, text, { macos: settings.notifyMacos ?? profile.notify.macos, slack: !opts.noSlack });
        }, { sign: settings.signReplies });
        const free = profile.agent.concurrency - running.size;
        if (free > 0) {
          // Off-hours Slack work waits for its not_before (intake.ts); everything else runs in turn.
          const queued = db.prepare("SELECT * FROM tasks WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?) ORDER BY updated_at LIMIT ?").all(Date.now(), free) as TaskRow[];
          for (const t of queued) {
            const h = await startTaskRun(profile, db, t, (id) => running.delete(id));
            if (h) running.set(t.id, h);
          }
        }
        await notifyPending(db, channels);
      } catch (e) {
        log(`daemon: tick failed: ${String((e as Error).stack ?? e).slice(0, 600)}`);
      }
    }
    await nap();
  }
}
