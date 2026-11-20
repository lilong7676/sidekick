// The local HTTP API and the web UI, served by the daemon (plan §8, ADR 0002).
//
// Bound to 127.0.0.1 only. Every /api call needs the bearer token from ~/.config/sidekick/runtime.json
// (0600) and a loopback Host header (DNS-rebinding guard). The menu bar app injects the token into
// its web view, so no other page on this machine can approve anything.

import type { Database } from "bun:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import index from "../web/index.html";
import { decide } from "./approvals.ts";
import type { Profile } from "./config.ts";
import type { RunRow } from "./db.ts";
import type { AutoDoctor, DoctorReport } from "./doctor.ts";
import { MAX_PERSONA_CHARS, PERSONA_TEMPLATE, PersonaConflict, readPersona, refinePrompt, writePersona } from "./persona.ts";
import type { SlackStatus } from "./realtime.ts";
import { trialSamples, type Trials } from "./trial.ts";
import { addManualTask, cancel, clearFinished, continueInClaude, deleteTask, mute, processNow, unmute, slackPeople, fingerprint, handback, listTasks, parseLogLine, pendingApprovals, readRunLog, recentlyDeletedDrafts, stateSummary, takeover, taskDetail, type TaskFilter } from "./queries.ts";
import { EFFORTS, loadSettings, MODELS, readEngineConfig, updateSettings } from "./settings.ts";
import { SUGGESTED_ROOT, useWorkspace } from "./setup.ts";
import type { SlackLogin } from "./slacklogin.ts";
import { lang, t } from "./i18n.ts";
import { INSTALL_COMMAND, type UpdateInfo } from "./update.ts";
import { BINARY_MTIME, expandHome, log, RUNTIME_FILE, VERSION } from "./util.ts";

function settingsView(profile: Profile, file?: string) {
  const s = loadSettings(file);
  let root = profile.root;
  try {
    root = expandHome(readEngineConfig().root);
  } catch {
    // no engine config yet: show the running profile's folder
  }
  return {
    mode: s.mode,
    model: s.model ?? null,
    effort: s.effort ?? null,
    root,
    runningRoot: profile.root,
    realtime: s.realtime,
    pollMinutes: s.pollMinutes ?? null,
    threadMergeHours: s.threadMergeHours,
    dmMergeHours: s.dmMergeHours,
    continueIn: s.continueIn,
    skipUsers: s.skipUsers,
    skipChannels: s.skipChannels,
    workHours: s.workHours,
    autoFull: s.autoFull,
    signReplies: s.signReplies,
    language: s.language,
    notifyMacos: s.notifyMacos ?? profile.notify.macos,
    notifySlackDm: s.notifySlackDm ?? profile.notify.slackSelfDm,
    defaults: { model: profile.agent.model, effort: profile.agent.effort ?? null, pollMinutes: profile.slack.pollMinutes },
    models: MODELS,
    efforts: EFFORTS,
  };
}
const DEFAULT_PORT = 47321;
const ID = /^[a-z]_[a-z0-9]{4,16}$/;

export interface ServerDeps {
  profile: Profile;
  db: Database;
  /** Called on every authenticated request: the daemon skips its own macOS banner while the app is open. */
  onClientSeen?: () => void;
  /** Slack connection status: the real-time socket and polling (shown in the panel). */
  slack?: () => SlackStatus;
  /** A newer Sidekick on GitHub Releases (update.ts), or null. */
  update?: () => UpdateInfo | null;
  doctor?: Pick<AutoDoctor, "report" | "runNow">;
  /** settings.json changed: apply what can be applied without a restart (realtime, poll interval). */
  onSettingsChanged?: () => void;
  realtimeRetry?: () => void;
  /** Signing in to Slack from the panel (slacklogin.ts). */
  slackLogin?: SlackLogin;
  trials?: Pick<Trials, "start" | "get">;
  /** Overrides for tests. */
  port?: number;
  runtimeFile?: string;
  settingsFile?: string;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function body(req: Request, max = 64_000): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, t("请求太大", "Request too large"));
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, t("请求体不是 JSON 对象", "The request body is not a JSON object"));
  }
}

function str(v: unknown, name: string, max: number, required = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, t(`缺少 ${name}`, `${name} is missing`));
    return undefined;
  }
  if (typeof v !== "string") throw new HttpError(400, t(`${name} 必须是字符串`, `${name} must be a string`));
  if (v.length > max) throw new HttpError(400, t(`${name} 超过 ${max} 个字符`, `${name} is longer than ${max} characters`));
  return v;
}

function idParam(v: string | undefined): string {
  if (!v || !ID.test(v)) throw new HttpError(400, t("id 格式不对", "Malformed id"));
  return v;
}

/** Server-sent events over a plain fetch stream (EventSource cannot send the auth header). */
function stream(tick: (send: (event: string, data: unknown) => void, close: () => void) => void | Promise<void>, everyMs: number): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(timer);
        clearInterval(beat);
        try { controller.close(); } catch { /* already closed */ }
      };
      const send = (event: string, data: unknown) => {
        if (open) controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const run = async () => {
        try { await tick(send, close); } catch (e) { send("error", { message: String(e) }); close(); }
      };
      run();
      timer = setInterval(run, everyMs);
      beat = setInterval(() => open && controller.enqueue(enc.encode(": ping\n\n")), 5_000);
    },
    cancel() {
      clearInterval(timer);
      clearInterval(beat);
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
}

/** Tail a run's stream-json log: everything so far, then new lines until the run has ended. */
function tailRun(db: Database, runId: string): Response {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | null;
  if (!run?.log_path) throw new HttpError(404, t("没有这次运行", "No such run"));
  let offset = 0;
  let rest = "";
  return stream((send, close) => {
    if (existsSync(run.log_path!)) {
      const size = statSync(run.log_path!).size;
      if (size > offset) {
        const fd = openSync(run.log_path!, "r");
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        offset = size;
        const text = rest + buf.toString("utf8");
        const lines = text.split("\n");
        rest = lines.pop() ?? "";
        const items = lines.flatMap(parseLogLine);
        if (items.length) send("log", items);
      }
    }
    const ended = (db.prepare("SELECT ended_at FROM runs WHERE id = ?").get(runId) as { ended_at: number | null }).ended_at;
    if (ended) {
      send("end", { ended });
      close();
    }
  }, 700);
}

const doctorSummary = (r: DoctorReport | null | undefined) =>
  r ? { at: r.at, fail: r.checks.filter((c) => c.status === "fail").length, warn: r.checks.filter((c) => c.status === "warn").length } : null;

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Authed = (handler: Handler) => Handler;
export interface Served { port: number; token: string; stop: () => void }
interface LaunchOptions { port?: number; runtimeFile?: string; onClientSeen?: () => void }

/** Token, auth and Host checks, the server itself and the runtime file; the routes come from `build`. */
function launch(opts: LaunchOptions, build: (authed: Authed) => Record<string, unknown>): Served {
  const token = randomBytes(24).toString("hex");
  const tokenBuf = Buffer.from(`Bearer ${token}`);

  const authed = (handler: (req: Request & { params: Record<string, string> }) => Response | Promise<Response>) =>
    async (req: Request & { params: Record<string, string> }) => {
      const host = (req.headers.get("host") ?? "").split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") return json({ error: "forbidden host" }, 403);
      const auth = Buffer.from(req.headers.get("authorization") ?? "");
      if (auth.length !== tokenBuf.length || !timingSafeEqual(auth, tokenBuf)) return json({ error: "unauthorized" }, 401);
      opts.onClientSeen?.();
      try {
        return await handler(req);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        const msg = String((e as Error).message ?? e);
        log(`api: ${req.method} ${new URL(req.url).pathname} failed: ${msg.slice(0, 300)}`);
        return json({ error: msg.slice(0, 300) }, 400);
      }
    };

  const routes = build(authed);
  const serve = (port: number) => Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 60,
    development: process.env.SIDEKICK_DEV === "1",
    // Bun's route types are too narrow to name here; each table is an object literal of handlers.
    routes: routes as never,
    fetch: () => json({ error: "not found" }, 404),
  });
  let server: ReturnType<typeof serve>;
  const wanted = opts.port ?? Number(process.env.SIDEKICK_PORT ?? DEFAULT_PORT);
  try {
    server = serve(wanted);
  } catch {
    server = serve(0); // the usual port is taken: pick any, the runtime file says which
  }

  const runtimeFile = opts.runtimeFile ?? RUNTIME_FILE;
  mkdirSync(dirname(runtimeFile), { recursive: true });
  writeFileSync(runtimeFile, JSON.stringify({ port: server.port, token, pid: process.pid, version: VERSION, binaryMtime: BINARY_MTIME }), { mode: 0o600 });
  chmodSync(runtimeFile, 0o600);
  log(`api: listening on 127.0.0.1:${server.port}`);
  return { port: server.port!, token, stop: () => server.stop(true) };
}

/** Restart through launchd (KeepAlive brings the daemon back), the same path as a normal stop. */
const restartSoon = () => setTimeout(() => process.kill(process.pid, "SIGTERM"), 300);

export function startServer(deps: ServerDeps): Served {
  const { profile, db } = deps;
  const live = () => ({ slack: deps.slack?.() ?? null, doctor: doctorSummary(deps.doctor?.report()), update: deps.update?.() ?? null, installCommand: INSTALL_COMMAND });
  return launch(deps, (authed) => ({
    "/": index,
    "/api/state": {
      GET: authed(() => json({ profile: profile.name, version: VERSION, lang: lang(), notifyMacos: loadSettings(deps.settingsFile).notifyMacos ?? profile.notify.macos, ...stateSummary(db), draftsDeleted: recentlyDeletedDrafts(db), ...live() })),
    },
    "/api/tasks": {
      GET: authed((req) => {
        const f = new URL(req.url).searchParams.get("filter") ?? "all";
        if (!["attention", "active", "closed", "all"].includes(f)) throw new HttpError(400, t("filter 不对", "Unknown filter"));
        return json(listTasks(db, f as TaskFilter));
      }),
      POST: authed(async (req) => {
        const b = await body(req);
        return json({ id: addManualTask(db, str(b.text, "text", 8000, true)!) }, 201);
      }),
    },
    "/api/tasks/:id": {
      GET: authed((req) => {
        const d = taskDetail(db, idParam(req.params.id));
        if (!d) throw new HttpError(404, t("没有这个任务", "No such task"));
        return json(d);
      }),
      DELETE: authed(async (req) => { await deleteTask(db, idParam(req.params.id)); return json({ ok: true }); }),
    },
    "/api/tasks/:id/cancel": { POST: authed(async (req) => json(await cancel(db, idParam(req.params.id)))) },
    "/api/slack/people": { GET: authed(() => json(slackPeople(db))) },
    "/api/slack/login": {
      GET: authed(() => json(deps.slackLogin?.view() ?? { state: "idle", startedAt: null, message: "" })),
      POST: authed(() => {
        if (!deps.slackLogin) throw new HttpError(503, t("daemon 没有接上 Slack 登录", "This daemon has no Slack sign-in"));
        return json(deps.slackLogin.start());
      }),
    },
    "/api/tasks/:id/process": { POST: authed((req) => { processNow(db, idParam(req.params.id)); return json({ ok: true }); }) },
    "/api/tasks/:id/mute": { POST: authed((req) => { mute(db, idParam(req.params.id)); return json({ ok: true }); }) },
    "/api/tasks/:id/unmute": { POST: authed((req) => { unmute(db, idParam(req.params.id)); return json({ ok: true }); }) },
    "/api/tasks/:id/continue": {
      POST: authed(async (req) => json(await continueInClaude(profile, db, idParam(req.params.id), loadSettings(deps.settingsFile).continueIn))),
    },
    "/api/finished-tasks": { DELETE: authed(async () => json({ deleted: await clearFinished(db) })) },
    "/api/settings": {
      GET: authed(() => json(settingsView(profile, deps.settingsFile))),
      PUT: authed(async (req) => {
        const b = await body(req);
        const nullable = (v: unknown, name: string) => (v === null ? null : str(v, name, 100));
        for (const k of ["realtime", "notifyMacos", "notifySlackDm", "signReplies"]) {
          if (b[k] !== undefined && b[k] !== null && typeof b[k] !== "boolean") throw new HttpError(400, t(`${k} 必须是 true / false`, `${k} must be true or false`));
        }
        if (b.realtime === null) throw new HttpError(400, t("realtime 必须是 true / false", "realtime must be true or false"));
        for (const k of ["pollMinutes", "threadMergeHours", "dmMergeHours"]) {
          if (b[k] !== undefined && b[k] !== null && typeof b[k] !== "number") throw new HttpError(400, t(`${k} 必须是数字`, `${k} must be a number`));
        }
        updateSettings({
          mode: str(b.mode, "mode", 10),
          model: nullable(b.model, "model"),
          effort: nullable(b.effort, "effort"),
          realtime: b.realtime,
          pollMinutes: b.pollMinutes,
          threadMergeHours: b.threadMergeHours,
          dmMergeHours: b.dmMergeHours,
          continueIn: b.continueIn === undefined ? undefined : str(b.continueIn, "continueIn", 20),
          skipUsers: b.skipUsers,
          skipChannels: b.skipChannels,
          workHours: b.workHours,
          autoFull: b.autoFull,
          signReplies: b.signReplies,
          language: b.language === undefined ? undefined : str(b.language, "language", 10),
          notifyMacos: b.notifyMacos,
          notifySlackDm: b.notifySlackDm,
        }, deps.settingsFile);
        deps.onSettingsChanged?.();
        let restartNeeded = false;
        const root = str(b.root, "root", 1000);
        if (root !== undefined && expandHome(root.trim()) !== profile.root) {
          useWorkspace(root);
          restartNeeded = true;
        }
        return json({ ...settingsView(profile, deps.settingsFile), restartNeeded });
      }),
    },
    "/api/doctor": {
      GET: authed(() => json(deps.doctor?.report() ?? null)),
      POST: authed(async () => {
        if (!deps.doctor) throw new HttpError(404, t("这个 daemon 没有诊断", "This daemon has no diagnostics"));
        return json(await deps.doctor.runNow(true));
      }),
    },
    "/api/realtime/retry": {
      POST: authed(() => {
        deps.realtimeRetry?.();
        return json(deps.slack?.() ?? null);
      }),
    },
    "/api/persona/prompt": { GET: authed(() => json(refinePrompt(profile, db))) },
    "/api/persona": {
      GET: authed(() => json({ files: readPersona(profile), template: PERSONA_TEMPLATE })),
      PUT: authed(async (req) => {
        const b = await body(req, 3 * MAX_PERSONA_CHARS);
        const path = str(b.path, "path", 300, true)!;
        if (typeof b.content !== "string") throw new HttpError(400, t("content 必须是字符串", "content must be a string"));
        if (b.baseMtime !== null && typeof b.baseMtime !== "number") throw new HttpError(400, t("baseMtime 必须是数字或 null", "baseMtime must be a number or null"));
        try {
          return json(writePersona(profile, path, b.content, b.baseMtime));
        } catch (e) {
          if (e instanceof PersonaConflict) throw new HttpError(409, e.message);
          throw new HttpError(400, String((e as Error).message));
        }
      }),
    },
    "/api/persona/samples": { GET: authed(() => json(trialSamples(db))) },
    "/api/persona/trials": {
      POST: authed(async (req) => {
        if (!deps.trials) throw new HttpError(404, t("这个 daemon 不能试跑", "This daemon cannot do dry runs"));
        const b = await body(req);
        if (typeof b.eventId !== "number" || !Number.isInteger(b.eventId)) throw new HttpError(400, t("eventId 必须是整数", "eventId must be an integer"));
        try {
          return json(deps.trials.start(b.eventId), 201);
        } catch (e) {
          throw new HttpError(409, String((e as Error).message));
        }
      }),
    },
    "/api/persona/trials/:id": {
      GET: authed((req) => {
        const trial = deps.trials?.get(idParam(req.params.id));
        if (!trial) throw new HttpError(404, t("没有这次试跑", "No such dry run"));
        return json(trial);
      }),
    },
    "/api/daemon/restart": {
      POST: authed(() => {
        restartSoon();
        return json({ ok: true });
      }),
    },
    "/api/tasks/:id/handback": {
      POST: authed(async (req) => {
        const b = await body(req);
        handback(db, idParam(req.params.id), str(b.message, "message", 4000));
        return json({ ok: true });
      }),
    },
    "/api/tasks/:id/takeover": { POST: authed((req) => json(takeover(profile, db, idParam(req.params.id)))) },
    "/api/approvals": { GET: authed(() => json(pendingApprovals(db))) },
    "/api/approvals/:id/approve": {
      POST: authed(async (req) => {
        const b = await body(req);
        const a = decide(db, idParam(req.params.id), "approved", str(b.note, "note", 2000), str(b.text, "text", 8000));
        return json({ id: a.id, status: a.status });
      }),
    },
    "/api/approvals/:id/deny": {
      POST: authed(async (req) => {
        const b = await body(req);
        const a = decide(db, idParam(req.params.id), "denied", str(b.note, "note", 2000));
        return json({ id: a.id, status: a.status });
      }),
    },
    "/api/runs/:id/log": {
      GET: authed((req) => {
        const run = db.prepare("SELECT log_path FROM runs WHERE id = ?").get(idParam(req.params.id)) as { log_path: string } | null;
        if (!run) throw new HttpError(404, t("没有这次运行", "No such run"));
        return json(readRunLog(run.log_path));
      }),
    },
    "/api/runs/:id/stream": { GET: authed((req) => tailRun(db, idParam(req.params.id))) },
    "/api/stream": {
      GET: authed(() => {
        let last = "";
        return stream((send) => {
          const extra = live();
          const fp = `${fingerprint(db)}:${JSON.stringify(extra)}`;
          if (fp !== last) {
            last = fp;
            send("changed", { ...stateSummary(db), ...extra });
          }
        }, 1000);
      }),
    },
  }));
}

export interface SetupDeps extends LaunchOptions {
  /** Why there is no profile yet (no config, or the profile there does not load). */
  reason: string;
  doctor?: Pick<AutoDoctor, "report" | "runNow">;
  /** Overrides for tests. */
  engineConfig?: string;
  restart?: () => void;
}

/**
 * The daemon before it has a workspace: the panel shows the setup page, picking a folder writes the
 * config (creating a profile there from the templates), then the daemon restarts into normal mode.
 */
export function startSetupServer(deps: SetupDeps): Served {
  const setupState = () => ({ version: VERSION, setup: { reason: deps.reason, suggestedRoot: SUGGESTED_ROOT }, doctor: doctorSummary(deps.doctor?.report()) });
  return launch(deps, (authed) => ({
    "/": index,
    "/api/state": { GET: authed(() => json(setupState())) },
    "/api/stream": {
      GET: authed(() => stream((send) => send("changed", setupState()), 5000)),
    },
    "/api/setup": {
      POST: authed(async (req) => {
        const b = await body(req);
        try {
          const r = useWorkspace(str(b.root, "root", 1000, true)!, deps.engineConfig);
          (deps.restart ?? restartSoon)();
          return json({ ...r, restarting: true });
        } catch (e) {
          throw new HttpError(400, String((e as Error).message));
        }
      }),
    },
    "/api/doctor": {
      GET: authed(() => json(deps.doctor?.report() ?? null)),
      POST: authed(async () => json(await deps.doctor!.runNow(true))),
    },
    "/api/daemon/restart": { POST: authed(() => { restartSoon(); return json({ ok: true }); }) },
  }));
}

