import { render, type ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, appChecks, copyText, isNative, native, pickFolder, setToken, subscribe, token, type Approval, type Check, type Detail, type DoctorReport, type LogItem, type RealtimeView, type LoginJob, type Run, type SlackStatus, type State, type Status, type Task } from "./api.ts";

// ---- helpers ------------------------------------------------------------------------------------------

const STATUS: Record<Status, { label: string; tone: string }> = {
  needs_approval: { label: "待审批", tone: "warn" },
  needs_me: { label: "要你看", tone: "warn" },
  failed: { label: "失败", tone: "bad" },
  running: { label: "运行中", tone: "info" },
  queued: { label: "排队", tone: "muted" },
  paused: { label: "接管中", tone: "info" },
  done: { label: "完成", tone: "good" },
  closed: { label: "已关闭", tone: "muted" },
  cancelled: { label: "已取消", tone: "muted" },
};

const SOURCE: Record<string, string> = { dm: "私信", mention: "@我", thread: "thread", manual: "手动" };

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const money = (v?: number | null) => (v ? `$${v.toFixed(v < 1 ? 3 : 2)}` : "");
const pad2 = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const span = (ms: number) => (ms < 60_000 ? "不到 1 分钟" : ms < 3600_000 ? `${Math.round(ms / 60_000)} 分钟` : `${(ms / 3600_000).toFixed(1)} 小时`);

/** The header chip for the Slack connection. */
function realtimeChip(v: RealtimeView): { text: string; tone: string; title: string } {
  switch (v.state) {
    case "off": return { text: "轮询", tone: "muted", title: "实时模式没开，按间隔轮询 Slack" };
    case "connecting": return { text: "连接中", tone: "warn", title: `正在连 Slack 实时${v.error ? `：${v.error}` : ""}；轮询照常` };
    case "connected": return { text: "实时", tone: "good", title: "Slack 实时连接中，新消息几秒内处理" };
    case "fallback": return { text: "已回退轮询", tone: "warn", title: `${v.reason}；${clock(v.retryAt)} 再试实时` };
  }
}

function openLink(url: string) {
  if (!native({ type: "open", url })) window.open(url, "_blank", "noopener");
}

/** Two-step button for things that cannot be undone (no confirm(): WKWebView would need a UI delegate). */
function ConfirmButton({ label, confirmLabel, onConfirm, cls = "" }: { label: string; confirmLabel: string; onConfirm: () => void; cls?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button class={`${cls} ${armed ? "armed" : ""}`} onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? confirmLabel : label}
    </button>
  );
}

function Pill({ status }: { status: Status }) {
  const s = STATUS[status] ?? { label: status, tone: "muted" };
  return <span class={`pill ${s.tone}`}>{s.label}</span>;
}

// ---- token gate (plain browser only) --------------------------------------------------------------------

function TokenGate({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState("");
  return (
    <div class="gate">
      <p>在浏览器里打开时，需要 daemon 的 token。它在 <code>~/.config/sidekick/runtime.json</code> 的 <code>token</code> 字段。</p>
      <p class="muted">菜单栏 app 里不用这一步。</p>
      <input type="password" placeholder="粘贴 token" value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} />
      <button class="primary" disabled={!v.trim()} onClick={() => { setToken(v); onDone(); }}>继续</button>
    </div>
  );
}

// ---- dispatch box --------------------------------------------------------------------------------------

function Dispatch({ onSent }: { onSent: (id: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ id: string }>("/api/tasks", { method: "POST", body: { text } });
      setText("");
      onSent(r.id);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="dispatch">
      <textarea
        rows={2}
        placeholder="派活：一句话或一个链接（⌘↩ 发送）"
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
      />
      <button class="primary" disabled={!text.trim() || busy} onClick={send}>{busy ? "…" : "派活"}</button>
      {err && <div class="error">{err}</div>}
    </div>
  );
}

// ---- approval card -------------------------------------------------------------------------------------

/** How a decided card ended, in words (results are written by approvals.ts and queries.ts). */
function decisionLabel(a: Approval): string {
  if (a.result === "sent in Slack") return "你在 Slack 里发出了";
  if (a.result === "draft deleted in Slack") return "你在 Slack 里删了草稿，不回";
  if (a.result === "discarded: task cancelled") return "任务已取消";
  if (a.result === "superseded") return "又来了新消息，被新的回复替换";
  if (a.status === "executed") return "已发出";
  if (a.status === "approved") return "已批准";
  if (a.status === "denied") return "已拒绝";
  if (a.status === "failed") return `失败${a.result ? `：${a.result.replace(/^failed: /, "")}` : ""}`;
  return a.status;
}

function ApprovalCard({ a, onDone }: { a: Approval; onDone: () => void }) {
  const original: string = a.kind === "outbound" ? String(a.payload.text ?? "") : "";
  const [text, setText] = useState(original);
  const [note, setNote] = useState("");
  const [denying, setDenying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const pending = a.status === "pending";

  const act = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await api(`/api/approvals/${a.id}/${path}`, { method: "POST", body });
      onDone();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const edited = a.kind === "outbound" && text !== original;
  return (
    <div class={`card approval ${pending ? "pending" : ""}`}>
      <div class="card-head">
        <strong>{a.kind === "outbound" ? "回复审批" : "操作审批"}</strong>
        <span class="muted">{ago(a.created_at)}{!pending && ` · ${decisionLabel(a)}`}</span>
      </div>
      {a.kind === "outbound" ? (
        <>
          {pending ? (
            <textarea class="reply" rows={Math.min(10, Math.max(3, text.split("\n").length + 1))} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          ) : (
            <div class="quote">{original}</div>
          )}
          {typeof a.payload.sentText === "string" && a.payload.sentText !== original && (
            <>
              <div class="muted small">你实际发出的：</div>
              <div class="quote">{a.payload.sentText}</div>
            </>
          )}
          {a.payload.reason && <div class="muted small">理由：{a.payload.reason}</div>}
          {pending && a.payload.draftId && <div class="muted small">Slack 输入框里也有这份草稿，在 Slack 里改了发出、或者删掉都行，这张卡会跟着自己结掉。</div>}
          {pending && a.payload.draftError && <div class="muted small">草稿没建成，批准后会直接发送。</div>}
        </>
      ) : (
        <pre class="code">{`${a.payload.tool_name}\n${typeof a.payload.input?.command === "string" ? a.payload.input.command : JSON.stringify(a.payload.input, null, 2)}`}</pre>
      )}
      {a.decision_note && <div class="muted small">意见：{a.decision_note}</div>}
      {pending && (
        <div class="actions">
          {!denying ? (
            <>
              <button class="primary" disabled={busy || (a.kind === "outbound" && !text.trim())} onClick={() => act("approve", edited ? { text } : {})}>
                {a.kind === "outbound" ? (edited ? "改后发送" : "批准发送") : "批准"}
              </button>
              <button disabled={busy} onClick={() => setDenying(true)}>拒绝…</button>
            </>
          ) : (
            <>
              <input placeholder="意见（可选，填了会让它按意见重做）" value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
              <button class="danger" disabled={busy} onClick={() => act("deny", note.trim() ? { note } : {})}>确认拒绝</button>
              <button disabled={busy} onClick={() => setDenying(false)}>算了</button>
            </>
          )}
        </div>
      )}
      {err && <div class="error">{err}</div>}
    </div>
  );
}

// ---- run log -------------------------------------------------------------------------------------------

function LogView({ run }: { run: Run }) {
  const [items, setItems] = useState<LogItem[]>([]);
  const live = !run.ended_at;
  useEffect(() => {
    setItems([]);
    if (live) {
      return subscribe(`/api/runs/${run.id}/stream`, (ev, data) => { if (ev === "log") setItems((xs) => [...xs, ...data]); });
    }
    api<LogItem[]>(`/api/runs/${run.id}/log`).then(setItems).catch(() => setItems([]));
  }, [run.id, live]);

  return (
    <div class="log">
      {items.length === 0 && <div class="muted small">{live ? "等待输出…" : "没有日志"}</div>}
      {items.map((it, i) => {
        switch (it.kind) {
          case "init": return <div key={i} class="muted small">开始 · {it.model}</div>;
          case "text": return <div key={i} class="log-text">{it.text}</div>;
          case "tool": return <details key={i} class="log-tool"><summary>⚙︎ {it.name} <span class="muted">{it.input.split("\n")[0].slice(0, 80)}</span></summary><pre class="code">{it.input}</pre></details>;
          case "tool_result": return <details key={i} class={`log-result ${it.error ? "bad" : ""}`}><summary>{it.error ? "✗ 出错" : "↳ 结果"} <span class="muted">{it.text.split("\n")[0].slice(0, 80)}</span></summary><pre class="code">{it.text}</pre></details>;
          case "result": return <div key={i} class={`log-end ${it.error ? "bad" : ""}`}>结束 · {it.turns ?? "?"} 轮 · {money(it.cost)}{it.denials ? ` · 被拒 ${it.denials} 次` : ""}</div>;
          case "stderr": return <pre key={i} class="code bad">{it.text}</pre>;
        }
      })}
      {live && <div class="muted small live-dot">运行中</div>}
    </div>
  );
}

// ---- task detail ---------------------------------------------------------------------------------------

function TaskDetail({ id, tick, onBack }: { id: string; tick: number; onBack: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [handbackMsg, setHandbackMsg] = useState("");
  const [cmd, setCmd] = useState<string | null>(null);
  const [info, setInfo] = useState("");

  const load = useCallback(() => api<Detail>(`/api/tasks/${id}`).then((x) => { setD(x); setErr(""); }).catch((e) => setErr(String(e.message))), [id]);
  useEffect(() => { load(); }, [load, tick]);
  useEffect(() => {
    // follow the newest run by default
    if (d && !openRun && d.runs.length) setOpenRun(d.runs[d.runs.length - 1].id);
  }, [d]);

  if (!d) return <div class="detail"><button class="link" onClick={onBack}>← 返回</button>{err && <div class="error">{err}</div>}</div>;
  const t = d.task;
  const pending = d.approvals.filter((a) => a.status === "pending");
  const decided = d.approvals.filter((a) => a.status !== "pending");
  const open = ["queued", "running", "needs_approval", "needs_me", "paused", "failed"].includes(t.status);

  const remove = async () => {
    try {
      await api(`/api/tasks/${id}`, { method: "DELETE" });
      onBack();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const act = async (path: string, body?: unknown) => {
    try {
      setInfo("");
      const r = await api<{ cwd?: string; command?: string; args?: string[]; where?: "terminal" | "desktop"; session?: string; name?: string }>(`/api/tasks/${id}/${path}`, { method: "POST", body: body ?? {} });
      if (path === "takeover" && r.command) {
        if (!native({ type: "takeover", cwd: r.cwd!, args: r.args ?? [] })) setCmd(`cd '${r.cwd}' && ${r.command}`);
      }
      if (path === "continue" && r.where === "desktop") {
        setInfo("已在 Claude 桌面 app 里打开这个会话。之后它归你：这个任务再跑时，sidekick 会另开一个会话。");
      } else if (path === "continue") {
        if (native({ type: "continue", cwd: r.cwd!, session: r.session!, name: r.name! })) setInfo("已在终端打开：从这个会话分叉出来的新会话，sidekick 这边不受影响。");
        else setCmd(`cd '${r.cwd}' && ${r.command}`);
      }
      load();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  return (
    <div class="detail">
      <div class="detail-head">
        <button class="link" onClick={onBack}>← 返回</button>
        <Pill status={t.status} />
      </div>
      <h2>{t.title}</h2>
      <div class="muted small">
        {SOURCE[t.kind] ?? t.kind} · {ago(t.created_at)} 创建 · {t.id}
        {t.link && <> · <a href="#" onClick={(e) => { e.preventDefault(); openLink(t.link!); }}>在 Slack 打开</a></>}
      </div>
      {t.summary && <div class="summary"><span class="muted small">结论{t.outcome ? `（${t.outcome}）` : ""}</span><div>{t.summary}</div></div>}
      {t.status === "queued" && t.not_before && t.not_before > Date.now() && (
        <div class="actions"><span class="muted small">下班时间进来的，{clock(t.not_before)} 开始处理。</span><button onClick={() => act("process")}>现在处理</button></div>
      )}
      {t.status === "closed" && t.outcome === "skipped" && (
        <div class="actions"><span class="muted small">按设置里的规则跳过了。</span><button onClick={() => act("process")}>仍然处理</button></div>
      )}
      {err && <div class="error">{err}</div>}

      {pending.map((a) => <ApprovalCard key={a.id} a={a} onDone={load} />)}

      <div class="actions">
        {t.session_id && t.status !== "running" && <button onClick={() => act("continue")} title="带着 sidekick 这个会话的全部上下文，在你自己的 Claude Code 里接着做；sidekick 这边不暂停、不用交还">在 Claude Code 里继续</button>}
        {t.session_id && t.status !== "running" && t.status !== "paused" && open && <button onClick={() => act("takeover")} title="暂停任务，在终端里接着它的会话做（仍受 sidekick 的限制），做完点「交还」让 sidekick 收尾">接管</button>}
        {t.status === "paused" && (
          <>
            <input placeholder="交还时带一句话（可选）" value={handbackMsg} onInput={(e) => setHandbackMsg((e.target as HTMLInputElement).value)} />
            <button class="primary" onClick={() => act("handback", handbackMsg.trim() ? { message: handbackMsg } : {})}>交还</button>
          </>
        )}
        {t.session_id && t.status === "paused" && <button onClick={() => act("takeover")}>再开一次终端</button>}
        {t.status === "running" && <ConfirmButton cls="danger" label="终止" confirmLabel="确认终止" onConfirm={() => act("cancel")} />}
        {open && t.status !== "running" && <button class="danger" onClick={() => act("cancel")}>取消任务</button>}
        <ConfirmButton cls="danger right" label="删除记录" confirmLabel="确认删除" onConfirm={remove} />
      </div>
      {info && <div class="muted small">{info}</div>}
      {cmd && <pre class="code selectable">{cmd}</pre>}

      {d.events.length > 0 && <h3>消息</h3>}
      {d.events.map((e) => (
        <div key={e.id} class="card">
          <div class="card-head"><strong>{e.user_name ?? "?"}</strong><span class="muted">{e.channel_name ?? ""} · {ago(e.received_at)}</span></div>
          <div class="quote">{e.text}</div>
        </div>
      ))}

      {d.runs.length > 0 && <h3>运行</h3>}
      {d.runs.map((r) => (
        <div key={r.id} class="card run">
          <button class="run-head" onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
            <span>{openRun === r.id ? "▾" : "▸"} {ago(r.started_at)}</span>
            <span class="muted">{r.ended_at ? `${Math.round((r.ended_at - r.started_at) / 1000)}s · ${r.turns ?? "?"} 轮 · ${money(r.cost_usd)}` : "运行中"}{r.error ? ` · ${r.error}` : ""}</span>
          </button>
          {openRun === r.id && <LogView run={r} />}
        </div>
      ))}

      {decided.length > 0 && <h3>审批记录</h3>}
      {decided.map((a) => <ApprovalCard key={a.id} a={a} onDone={load} />)}
    </div>
  );
}

// ---- list ----------------------------------------------------------------------------------------------

type Tab = "attention" | "active" | "closed" | "all";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "attention", label: "要你处理" },
  { id: "active", label: "进行中" },
  { id: "closed", label: "已结束" },
  { id: "all", label: "全部" },
];

// ---- getting started ------------------------------------------------------------------------------------

const STARTED_KEY = "sidekick-started-dismissed";

/**
 * The few things a new install needs, ticked off from the same checks the diagnosis runs, so there is
 * nothing to remember: it goes away once they all pass, or when dismissed.
 */
function GettingStarted({ doctorAt, onPersona }: { doctorAt?: number; onPersona: () => void }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(STARTED_KEY) === "1"; } catch { return false; } });
  const login = useSlackLogin();
  useEffect(() => {
    Promise.all([api<DoctorReport | null>("/api/doctor").catch(() => null), appChecks()])
      .then(([r, app]) => setChecks([...(r?.checks ?? []), ...app]));
  }, [doctorAt, login.job?.state]);
  if (dismissed || !checks) return null;
  const ok = (id: string) => checks.find((c) => c.id === id)?.status === "ok";
  const steps = [
    { id: "slack-login", label: "登录 Slack", hint: "sidekick 用你的身份读私信和 @ 你的消息。", action: <SlackLoginButton {...login} /> },
    { id: "persona", label: "写分身", hint: "你是谁、负责什么、怎么回话；可以复制 prompt 交给你自己的 agent 写。", action: <button onClick={onPersona}>去写</button> },
    ...(isNative() ? [{ id: "app-notify", label: "允许通知", hint: "有回复等你批时弹通知。系统设置 → 通知 → Sidekick。", action: null }] : []),
  ];
  if (steps.every((x) => ok(x.id))) return null;
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(STARTED_KEY, "1"); } catch { /* private mode: it shows again next time */ }
  };
  return (
    <section class="getting-started">
      <div class="gs-head"><strong>开始用 sidekick</strong><button class="link" onClick={dismiss}>收起</button></div>
      <div class="group-box">
        {steps.map((x) => (
          <Row key={x.id} label={<>{ok(x.id) ? <span class="tone-good">✓ </span> : <span class="muted">○ </span>}{x.label}</>} hint={x.id === "slack-login" && login.job && login.job.state !== "idle" ? <span class={jobTone(login.job)}>{login.job.message}</span> : x.hint}>
            {!ok(x.id) && x.action}
          </Row>
        ))}
      </div>
    </section>
  );
}

function TaskList({ tab, tick, onOpen }: { tab: Tab; tick: number; onOpen: (id: string) => void }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<Task[]>(`/api/tasks?filter=${tab}`).then((x) => { setTasks(x); setErr(""); }).catch((e) => setErr(String(e.message)));
  }, [tab, tick]);
  if (err) return <div class="error">{err}</div>;
  if (!tasks) return <div class="muted pad">加载中…</div>;
  if (tasks.length === 0) return <div class="muted pad">{tab === "attention" ? "没有要你处理的事。" : "没有任务。"}</div>;
  const clear = async () => {
    try {
      await api("/api/finished-tasks", { method: "DELETE" });
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };
  return (
    <>
    {tab === "closed" && (
      <div class="list-tools"><span class="muted small">{tasks.length} 个已结束</span><ConfirmButton cls="danger" label="清空已结束" confirmLabel="确认全部删除" onConfirm={clear} /></div>
    )}
    <ul class="tasks">
      {tasks.map((t) => (
        <li key={t.id} onClick={() => onOpen(t.id)}>
          <div class="row-top"><Pill status={t.status} />{(t.pending_approvals ?? 0) > 0 && <span class="badge">{t.pending_approvals}</span>}<span class="muted small right">{ago(t.updated_at)}</span></div>
          <div class="title">{t.title}</div>
          <div class="muted small">{SOURCE[t.kind] ?? t.kind}{t.status === "queued" && t.not_before && t.not_before > Date.now() ? ` · ${clock(t.not_before)} 开始处理` : ""}{(t.messages ?? 0) > 1 ? ` · ${t.messages} 条消息` : ""}{t.cost_usd ? ` · ${money(t.cost_usd)}` : ""}{t.summary ? ` · ${t.summary.split("\n")[0].slice(0, 60)}` : ""}</div>
        </li>
      ))}
    </ul>
    </>
  );
}

// ---- persona (分身) -------------------------------------------------------------------------------------

interface PersonaFile { path: string; exists: boolean; content: string; mtime: number | null }
interface Sample { id: number; kind: string; channel_name: string | null; user_name: string | null; text: string; received_at: number }
interface Trial {
  id: string; eventId: number; status: "running" | "done" | "failed"; startedAt: number; endedAt: number | null; costUsd: number | null;
  result: { action: "reply" | "no_reply" | "needs_me"; judgement: string; draft: string | null } | null; error: string | null;
}

const ACTION: Record<string, { label: string; tone: string }> = {
  reply: { label: "会回复", tone: "good" },
  no_reply: { label: "不用回", tone: "muted" },
  needs_me: { label: "交给你看", tone: "warn" },
};

function TrialPanel({ dirty }: { dirty: boolean }) {
  const [samples, setSamples] = useState<Sample[] | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [trial, setTrial] = useState<Trial | null>(null);
  const [err, setErr] = useState("");
  const [, setNow] = useState(0);

  useEffect(() => {
    api<Sample[]>("/api/persona/samples").then((s) => { setSamples(s); if (s[0]) setPick(s[0].id); }).catch((e) => setErr(String(e.message)));
  }, []);

  // Follow a running trial.
  useEffect(() => {
    if (trial?.status !== "running") return;
    const t = setInterval(async () => {
      setNow(Date.now());
      try {
        setTrial(await api<Trial>(`/api/persona/trials/${trial.id}`));
      } catch (e) {
        setErr(String((e as Error).message));
      }
    }, 2000);
    return () => clearInterval(t);
  }, [trial?.id, trial?.status]);

  const start = async () => {
    if (pick === null) return;
    setErr("");
    try {
      setTrial(await api<Trial>("/api/persona/trials", { method: "POST", body: { eventId: pick } }));
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const running = trial?.status === "running";
  const r = trial?.result;
  return (
    <div>
      <h3>试跑</h3>
      <div class="muted small">挑一条最近的 Slack 消息，按已保存的分身走一遍：只看它会怎么判断、怎么回，不建草稿、不发消息。花费和处理一条真消息差不多。</div>
      {!samples ? (
        <div class="muted small pad-y">加载最近的消息…</div>
      ) : samples.length === 0 ? (
        <div class="muted small pad-y">账本里还没有 Slack 消息，收到第一条后就能试跑。</div>
      ) : (
        <div class="field">
          <select value={pick ?? ""} disabled={running} onChange={(e) => setPick(Number((e.target as HTMLSelectElement).value))}>
            {samples.map((s) => (
              <option key={s.id} value={s.id}>
                {ago(s.received_at)} · {s.user_name ?? "?"}{s.channel_name ? ` @ ${s.channel_name}` : ""}：{s.text.replace(/\s+/g, " ").slice(0, 60)}
              </option>
            ))}
          </select>
          <button class="primary" disabled={running || pick === null} onClick={start}>{running ? "试跑中…" : "试跑"}</button>
        </div>
      )}
      {dirty && <div class="warn-line small">有没保存的修改：试跑用的是已保存的版本。</div>}
      {trial && (
        <div class="card">
          {running && <div class="live-dot small">正在处理，已 {Math.round((Date.now() - trial.startedAt) / 1000)} 秒（一般 30–90 秒）</div>}
          {trial.status === "failed" && <div class="error">试跑失败：{trial.error}</div>}
          {r && (
            <>
              <div class="card-head">
                <span class={`pill ${ACTION[r.action].tone}`}>{ACTION[r.action].label}</span>
                <span class="muted small">{money(trial.costUsd)}{trial.endedAt ? ` · ${Math.round((trial.endedAt - trial.startedAt) / 1000)} 秒` : ""}</span>
              </div>
              <div class="small">{r.judgement}</div>
              {r.draft && <div class="quote selectable">{r.draft}</div>}
            </>
          )}
        </div>
      )}
      {err && <div class="error">{err}</div>}
    </div>
  );
}

/** Few people write the persona by hand: hand the job to their own agent, with their corrections as evidence. */
function RefinePrompt({ stamp, canReload, onReload }: { stamp: string; canReload: boolean; onReload: () => void }) {
  const [p, setP] = useState<{ prompt: string; corrections: number } | null>(null);
  const [note, setNote] = useState("");
  const [show, setShow] = useState(false);
  // Fetched ahead: only the click itself may write to the clipboard, not a fetch that finishes later.
  useEffect(() => { api<{ prompt: string; corrections: number }>("/api/persona/prompt").then(setP).catch(() => setP(null)); }, [stamp]);
  const copy = async () => {
    if (!p) return;
    if (await copyText(p.prompt)) {
      setNote(p.corrections ? `已复制，里面带了你最近改过、拒绝过的 ${p.corrections} 条回复。` : "已复制。");
    } else {
      setShow(true);
      setNote("复制失败，在下面全选手动复制。");
    }
  };
  return (
    <div class="card">
      <strong>让你自己的 agent 来写</strong>
      <div class="muted small">复制这段 prompt，贴给你本机的 Claude Code 或别的 agent。它会先读现有资料和你最近改过、拒绝过的回复；查得到的自己查，查不到的一次问你一个问题；改完给你看过再保存。</div>
      <div class="actions">
        <button disabled={!p} onClick={copy}>复制 prompt</button>
        {canReload && <button class="link" onClick={onReload}>agent 改完了，重新加载</button>}
        {note && <span class="muted small">{note}</span>}
      </div>
      {show && p && <textarea class="persona-editor" readOnly rows={10} value={p.prompt} />}
    </div>
  );
}

function Persona({ onBack }: { onBack: () => void }) {
  const [files, setFiles] = useState<PersonaFile[] | null>(null);
  const [template, setTemplate] = useState("");
  const [active, setActive] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [conflict, setConflict] = useState(false);

  const load = async () => {
    try {
      const x = await api<{ files: PersonaFile[]; template: string }>("/api/persona");
      setFiles(x.files);
      setTemplate(x.template);
      setDrafts(Object.fromEntries(x.files.map((f) => [f.path, f.content])));
      setConflict(false);
      setErr("");
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };
  useEffect(() => { load(); }, []);

  if (!files) return <div class="detail"><button class="link" onClick={onBack}>← 返回</button>{err && <div class="error">{err}</div>}</div>;
  const f = files[active];
  const text = drafts[f.path] ?? "";
  const dirtyPaths = files.filter((x) => (drafts[x.path] ?? "") !== x.content).map((x) => x.path);
  const dirty = dirtyPaths.includes(f.path);

  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const next = await api<PersonaFile>("/api/persona", { method: "PUT", body: { path: f.path, content: text, baseMtime: f.mtime } });
      setFiles(files.map((x) => (x.path === next.path ? next : x)));
      setSaved({ ...saved, [f.path]: Date.now() });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="detail settings persona">
      <div class="detail-head">
        {dirtyPaths.length
          ? <ConfirmButton label="← 返回" confirmLabel="放弃没保存的修改并返回" cls="link" onConfirm={onBack} />
          : <button class="link" onClick={onBack}>← 返回</button>}
      </div>
      <h2>分身</h2>
      <div class="muted small">每次处理消息，agent 都会先读这份资料：你是谁、负责什么、怎么说话、哪些事不能替你答应。保存后下一个任务就用上。</div>
      <RefinePrompt stamp={files.map((x) => x.mtime ?? 0).join(",")} canReload={dirtyPaths.length === 0} onReload={load} />

      {files.length > 1 && (
        <nav class="tabs file-tabs">
          {files.map((x, i) => (
            <button key={x.path} class={i === active ? "active" : ""} onClick={() => setActive(i)}>
              {x.path.split("/").pop()}{dirtyPaths.includes(x.path) ? " •" : ""}
            </button>
          ))}
        </nav>
      )}
      <div class="persona-meta small">
        <code>{f.path}</code>
        <span class="muted">
          {dirty ? (f.exists ? "有修改未保存" : "未保存，保存后新建这个文件") : !f.exists ? "还没有这个文件" : saved[f.path] ? `已保存 ${clock(saved[f.path])}` : "已是最新"}
        </span>
      </div>
      <textarea
        class="persona-editor"
        value={text}
        placeholder="还没写。点下面的「用模板开始」。"
        onInput={(e) => setDrafts({ ...drafts, [f.path]: (e.target as HTMLTextAreaElement).value })}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (dirty && !busy) save(); } }}
      />
      <div class="actions">
        <button class="primary" disabled={busy || !dirty || conflict} onClick={save}>{busy ? "保存中…" : "保存"}</button>
        <button disabled={busy || !dirty} onClick={() => setDrafts({ ...drafts, [f.path]: f.content })}>撤销修改</button>
        {!text.trim() && <button disabled={busy} onClick={() => setDrafts({ ...drafts, [f.path]: template })}>用模板开始</button>}
        <span class="muted small">⌘S 保存</span>
      </div>
      {conflict && (
        <div class="warn-line small">
          文件在别处改过了（编辑器或 git）。先复制你的修改，再 <button class="link" onClick={load}>重新加载</button>。
        </div>
      )}
      {err && !conflict && <div class="error">{err}</div>}

      <TrialPanel dirty={dirtyPaths.length > 0} />
    </div>
  );
}

// ---- settings ------------------------------------------------------------------------------------------

interface SettingsView {
  mode: "semi" | "full"; model: string | null; effort: string | null; root: string; runningRoot: string;
  realtime: boolean; pollMinutes: number | null; threadMergeHours: number | null; dmMergeHours: number | null;
  continueIn: "terminal" | "desktop";
  notifyMacos: boolean; notifySlackDm: boolean;
  skipUsers: string[]; skipChannels: string[]; workHours: { start: number; end: number; weekends: boolean } | null;
  autoFull: { windows: Array<{ start: number; end: number }>; weekends: boolean } | null;
  signReplies: boolean;
  defaults: { model: string; effort: string | null; pollMinutes: number }; models: string[]; efforts: string[]; restartNeeded?: boolean;
}

const POLL_CHOICES = [1, 2, 3, 5, 10, 15, 30, 60];

/** How long a conversation keeps its task (settings.ts threadMergeHours / dmMergeHours); null: no limit. */
const MERGE_CHOICES: Array<{ hours: number | null; label: string }> = [
  { hours: null, label: "不限时间" },
  { hours: 24, label: "1 天内" },
  { hours: 8, label: "8 小时内" },
  { hours: 2, label: "2 小时内" },
  { hours: 0.5, label: "30 分钟内" },
  { hours: 0, label: "不并，上一个处理完就开新的" },
];

function MergeSelect({ value, busy, onPick }: { value: number | null; busy: boolean; onPick: (hours: number | null) => void }) {
  const known = MERGE_CHOICES.some((c) => c.hours === value);
  return (
    <select value={value === null ? "none" : String(value)} disabled={busy} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; onPick(v === "none" ? null : Number(v)); }}>
      {!known && <option value={String(value)}>{value} 小时内</option>}
      {MERGE_CHOICES.map((c) => <option key={c.label} value={c.hours === null ? "none" : String(c.hours)}>{c.label}</option>)}
    </select>
  );
}

function SlackLines({ slack }: { slack: SlackStatus }) {
  const v = slack.realtime;
  const now = Date.now();
  const c = slack.lastCollect;
  return (
    <div class="status-lines small">
      <span class="k">实时</span>
      <span class={`v ${v.state === "connected" ? "tone-good" : v.state === "off" ? "" : "tone-warn"}`}>
        {v.state === "off" && "未开启"}
        {v.state === "connecting" && `连接中（${span(now - v.since)}）${v.error ? `：${v.error}` : ""}`}
        {v.state === "connected" && `已连接 ${span(now - v.since)}`}
        {v.state === "fallback" && `已回退轮询：${v.reason}；${clock(v.retryAt)} 再试`}
      </span>
      <span class="k">轮询</span>
      <span class="v">每 {slack.pollMinutes} 分钟{slack.nextCollectAt ? `，下次 ${clock(slack.nextCollectAt)}` : ""}</span>
      <span class="k">上次采集</span>
      <span class={`v ${c?.error ? "tone-bad" : ""}`}>
        {!c ? "还没采集" : c.error ? `${clock(c.at)} 失败：${c.error}` : `${clock(c.at)}，新增 ${c.added} 条，用时 ${(c.ms / 1000).toFixed(1)} 秒`}
        {slack.collectingSince ? `（${clock(slack.collectingSince)} 起正在采集）` : ""}
      </span>
    </div>
  );
}

/** Sign in to Slack from the panel: the daemon opens a browser and waits; poll until it settles. */
function useSlackLogin() {
  const [job, setJob] = useState<LoginJob | null>(null);
  useEffect(() => { api<LoginJob>("/api/slack/login").then(setJob).catch(() => setJob(null)); }, []);
  useEffect(() => {
    if (job?.state !== "running") return;
    const t = setInterval(() => { api<LoginJob>("/api/slack/login").then(setJob).catch(() => {}); }, 2000);
    return () => clearInterval(t);
  }, [job?.state]);
  const start = async () => {
    try {
      setJob(await api<LoginJob>("/api/slack/login", { method: "POST" }));
    } catch (e) {
      setJob({ state: "failed", startedAt: null, message: String((e as Error).message) });
    }
  };
  return { job, start };
}

function SlackLoginButton({ job, start }: ReturnType<typeof useSlackLogin>) {
  return <button disabled={job?.state === "running"} onClick={start}>{job?.state === "running" ? "等你在浏览器里登录…" : "登录 Slack"}</button>;
}

const jobTone = (job: LoginJob | null) => (job?.state === "ok" ? "tone-good" : job?.state === "failed" ? "tone-bad" : "");

/** The one check fixed by a click: Slack sign-in. */
function SlackLoginFix() {
  const login = useSlackLogin();
  return (
    <div class="check-fix small">
      <div class="actions"><SlackLoginButton {...login} />{login.job && login.job.state !== "idle" && <span class={jobTone(login.job)}>{login.job.message}</span>}</div>
    </div>
  );
}

function CheckRow({ c }: { c: Check }) {
  const [copied, setCopied] = useState("");
  const tone = { ok: "good", warn: "warn", fail: "bad" }[c.status];
  const copy = async () => {
    setCopied((await copyText(c.command ?? "")) ? "已复制" : "复制失败，手动选中");
    setTimeout(() => setCopied(""), 2000);
  };
  return (
    <li>
      <div class="check-head">
        <span class={`check-icon tone-${tone}`}>{{ ok: "✓", warn: "!", fail: "✗" }[c.status]}</span>
        <span><strong>{c.name}</strong> <span class="muted small selectable">{c.detail}</span></span>
      </div>
      {c.status !== "ok" && c.id === "slack-login" && <SlackLoginFix />}
      {c.status !== "ok" && c.id !== "slack-login" && (c.fix || c.command) && (
        <div class="check-fix small">
          {c.fix && <div>→ {c.fix}</div>}
          {c.command && <div class="code"><span>{c.command}</span><button onClick={copy}>{copied || "复制"}</button></div>}
        </div>
      )}
    </li>
  );
}

// Settings are laid out like a system settings pane: titled groups of rows, what a setting is on the
// left, its control on the right (wrapping below it in the narrow popover), and the feedback of a
// change shown under the group it was made in.

type Note = { group: string; text: string; tone: "ok" | "bad" };

function Group({ title, note, children }: { title: string; note?: Note | null; children: ComponentChildren }) {
  return (
    <section class="group">
      <h3>{title}</h3>
      <div class="group-box">{children}</div>
      {note && <div class={`group-note tone-${note.tone === "ok" ? "good" : "bad"}`}>{note.text}</div>}
    </section>
  );
}

function Row({ label, hint, children }: { label: ComponentChildren; hint?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="row">
      <div class="row-text">
        <div class="row-label">{label}</div>
        {hint && <div class="row-hint">{hint}</div>}
      </div>
      {children && <div class="row-control">{children}</div>}
    </div>
  );
}

/** An on/off switch that only moves when the parent says so (`on`), so a change can wait for a confirmation. */
function Switch({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label class="switch">
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={(e) => {
          const box = e.target as HTMLInputElement;
          const want = box.checked;
          box.checked = on;
          onChange(want);
        }}
      />
      <span />
    </label>
  );
}

function Doctor({ at, focus }: { at?: number; focus: boolean }) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [app, setApp] = useState<Check[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Load the daemon's last report, and again whenever it runs one on its own.
  useEffect(() => {
    api<DoctorReport | null>("/api/doctor").then(setReport).catch((e) => setErr(String(e.message)));
    appChecks().then(setApp);
  }, [at]);
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: "start" });
  }, []);

  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      setReport(await api<DoctorReport>("/api/doctor", { method: "POST" }));
      setApp(await appChecks());
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const checks = [...(report?.checks ?? []), ...app];
  const bad = checks.filter((c) => c.status !== "ok");
  const good = checks.filter((c) => c.status === "ok");
  return (
    <div ref={ref}>
      <Group title="诊断" note={err ? { group: "doctor", tone: "bad", text: err } : null}>
        <Row
          label={!report ? "还没跑过" : bad.length ? <span class="tone-warn">{bad.length} 项要处理</span> : <span class="tone-good">全部正常</span>}
          hint={`${report ? `${clock(report.at)} 的结果。` : ""}daemon 启动后、每 6 小时、采集出错后会自动跑，有问题会通知你。`}
        >
          <button disabled={busy} onClick={run}>{busy ? "诊断中…" : "运行诊断"}</button>
        </Row>
        {bad.length > 0 && <ul class="checks">{bad.map((c) => <CheckRow key={c.id} c={c} />)}</ul>}
        {good.length > 0 && (
          <details class="row-details">
            <summary>{bad.length ? `其余 ${good.length} 项正常` : `查看 ${good.length} 项检查`}</summary>
            <ul class="checks">{good.map((c) => <CheckRow key={c.id} c={c} />)}</ul>
          </details>
        )}
      </Group>
    </div>
  );
}

interface Known { id: string; name: string; messages: number }

/** Skipped people or channels as removable chips, plus the recent ones to add. */
function SkipList({ ids, known, busy, prefix, onChange }: { ids: string[]; known: Known[]; busy: boolean; prefix: string; onChange: (ids: string[]) => void }) {
  const name = (id: string) => known.find((k) => k.id === id)?.name ?? id;
  const addable = known.filter((k) => !ids.includes(k.id));
  return (
    <div class="skip-list">
      {ids.map((id) => (
        <button key={id} class="chip" disabled={busy} title="不再跳过" onClick={() => onChange(ids.filter((x) => x !== id))}>{prefix}{name(id)} ✕</button>
      ))}
      {addable.length > 0 && (
        <select value="" disabled={busy} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) onChange([...ids, v]); }}>
          <option value="">添加…</option>
          {addable.map((k) => <option key={k.id} value={k.id}>{prefix}{k.name}（{k.messages} 条）</option>)}
        </select>
      )}
      {ids.length === 0 && addable.length === 0 && <span class="muted small">账本里还没有最近的消息。</span>}
    </div>
  );
}

const HOURS = Array.from({ length: 25 }, (_, h) => h);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const minutes = (v: string) => { const [h, m] = v.split(":").map(Number); return (h || 0) * 60 + (m || 0); };

function Settings({ state, focus, onBack }: { state: State | null; focus: "top" | "doctor" | "about"; onBack: () => void }) {
  const [s, setS] = useState<SettingsView | null>(null);
  const [root, setRoot] = useState("");
  const [editingRoot, setEditingRoot] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRealtime, setConfirmRealtime] = useState(false);
  const login = useSlackLogin();
  const [upgradeCmd, setUpgradeCmd] = useState("");
  const aboutRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus === "about") aboutRef.current?.scrollIntoView({ block: "start" }); }, []);
  const [known, setKnown] = useState<{ people: Known[]; channels: Known[] }>({ people: [], channels: [] });
  useEffect(() => { api<{ people: Known[]; channels: Known[] }>("/api/slack/people").then(setKnown).catch(() => {}); }, []);

  useEffect(() => {
    api<SettingsView>("/api/settings").then((x) => { setS(x); setRoot(x.root); }).catch((e) => setLoadErr(String(e.message)));
  }, []);
  // A confirmation fades; an error stays until the next change.
  useEffect(() => {
    if (!note || note.tone === "bad") return;
    const t = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(t);
  }, [note]);

  const save = async (group: string, patch: Record<string, unknown>, text: string): Promise<boolean> => {
    setBusy(true);
    try {
      const x = await api<SettingsView>("/api/settings", { method: "PUT", body: patch });
      setS(x);
      setNote({ group, tone: "ok", text: x.restartNeeded ? "已保存，重启 daemon 后生效。" : text });
      return true;
    } catch (e) {
      setNote({ group, tone: "bad", text: String((e as Error).message) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const post = async (group: string, path: string, text: string) => {
    try {
      await api(path, { method: "POST" });
      setNote({ group, tone: "ok", text });
    } catch (e) {
      setNote({ group, tone: "bad", text: String((e as Error).message) });
    }
  };
  const noteFor = (group: string) => (note?.group === group ? note : null);
  const setWindow = (i: number, w: { start: number; end: number }) => {
    if (!s?.autoFull) return;
    save("mode", { autoFull: { ...s.autoFull, windows: s.autoFull.windows.map((x, k) => (k === i ? w : x)) } }, "时段已保存。");
  };
  const choose = async () => {
    const p = await pickFolder();
    if (p) setRoot(p);
  };

  if (!s) return <div class="detail"><button class="link" onClick={onBack}>← 返回</button>{loadErr && <div class="error">{loadErr}</div>}</div>;
  const slack = state?.slack;
  const pendingRoot = s.root !== s.runningRoot;
  return (
    <div class="detail settings">
      <div class="detail-head"><button class="link" onClick={onBack}>← 返回</button></div>
      <h2>设置</h2>

      <Group title="回复方式" note={noteFor("mode")}>
        <Row
          label="托管模式"
          hint={s.mode === "semi"
            ? "agent 起草的 Slack 回复，都要你批了才发。"
            : "agent 的回复直接以你的名义发出，适合请假值班。拿不准的仍交给你，每条发出后私信你一份；切换前已在等你的回复，仍然等你批。"}
        >
          <div class={`segmented ${s.mode === "full" ? "is-full" : ""}`}>
            <button class={s.mode === "semi" ? "on" : ""} disabled={busy} onClick={() => s.mode !== "semi" && save("mode", { mode: "semi" }, "已切到半托管：回复都要你批。")}>半托管</button>
            <button class={s.mode === "full" ? "on" : ""} disabled={busy} onClick={() => s.mode !== "full" && save("mode", { mode: "full" }, "已切到全托管：之后的回复会直接发出，每条都私信你一份。")}>全托管</button>
          </div>
        </Row>
        <Row
          label="回复带署名行"
          hint={<>sidekick 发出的回复上面加一行灰色小字：你批准的是「🗣️ Drafted by sidekick · approved by me」，全托管自动发出的是「🗣️ Auto-reply by sidekick · not yet reviewed by me」。你在 Slack 里自己把草稿发出去的不带。</>}
        >
          <Switch on={s.signReplies} disabled={busy} onChange={(on) => save("mode", { signReplies: on }, on ? "之后的回复会带署名行。" : "之后的回复不带署名行。")} />
        </Row>
        <Row
          label="定时全托管"
          hint={s.mode === "full"
            ? "上面选了全托管，就一直是全托管，时段不起作用。"
            : state?.mode === "full" && state.modeUntil
              ? <span class="tone-warn">现在就在全托管时段里，到 {clock(state.modeUntil)}。</span>
              : "比如午休：时段内回复直接发出，其他时间要你批。切换时会提醒你。"}
        >
          <Switch
            on={s.autoFull !== null}
            disabled={busy}
            onChange={(on) => save("mode", { autoFull: on ? { windows: [{ start: 12 * 60, end: 13 * 60 + 30 }], weekends: false } : null }, on ? "已打开定时全托管。" : "已关闭定时全托管。")}
          />
        </Row>
        {s.autoFull && (
          <>
            {s.autoFull.windows.map((w, i) => (
              <Row key={i} label={s.autoFull!.windows.length > 1 ? `时段 ${i + 1}` : "时段"}>
                <input type="time" class="time" value={hhmm(w.start)} disabled={busy} onChange={(e) => setWindow(i, { ...w, start: minutes((e.target as HTMLInputElement).value) })} />
                <span class="muted">到</span>
                <input type="time" class="time" value={hhmm(w.end % 1440)} disabled={busy} onChange={(e) => setWindow(i, { ...w, end: minutes((e.target as HTMLInputElement).value) || 1440 })} />
                {s.autoFull!.windows.length > 1 && <button class="link" disabled={busy} onClick={() => save("mode", { autoFull: { ...s.autoFull!, windows: s.autoFull!.windows.filter((_, k) => k !== i) } }, "已删掉这个时段。")}>删除</button>}
              </Row>
            ))}
            {s.autoFull.windows.length < 6 && (
              <Row label="" hint={undefined}>
                <button disabled={busy} onClick={() => save("mode", { autoFull: { ...s.autoFull!, windows: [...s.autoFull!.windows, { start: 18 * 60, end: 19 * 60 }] } }, "已加一个时段。")}>加一个时段</button>
              </Row>
            )}
            <Row label="周末也按时段" hint="关着时，周六、周日不自动切换。">
              <Switch on={s.autoFull.weekends} disabled={busy} onChange={(on) => save("mode", { autoFull: { ...s.autoFull!, weekends: on } }, on ? "周末也按时段切换。" : "周末不自动切换。")} />
            </Row>
          </>
        )}
      </Group>

      <Group title="Slack" note={noteFor("slack")}>
        {slack?.enabled ? (
          <div class="row row-status">
            <SlackLines slack={slack} />
            {slack.realtime.state === "fallback" && <button onClick={() => post("slack", "/api/realtime/retry", "正在重连实时。")}>现在重试实时</button>}
          </div>
        ) : (
          <Row label="连接" hint={slack ? "profile 里关了 Slack。" : "连不上 daemon，看不到状态。"} />
        )}
        <Row
          label="Slack 登录"
          hint={login.job && login.job.state !== "idle"
            ? <span class={jobTone(login.job)}>{login.job.message}</span>
            : "用 slackcli 自己的浏览器配置登录。登录过期时再点一次，已经登录过的会自己完成。"}
        >
          <SlackLoginButton {...login} />
        </Row>
        <Row label="实时模式" hint="新私信和 @ 你的消息几秒内就处理，不用等下一轮轮询。">
          <Switch
            on={s.realtime}
            disabled={busy}
            onChange={(on) => {
              if (on) return setConfirmRealtime(true); // only after the confirmation below
              setConfirmRealtime(false);
              save("slack", { realtime: false }, "实时模式已关，只按间隔轮询。");
            }}
          />
        </Row>
        {confirmRealtime && (
          <div class="row row-confirm">
            <div>实时模式连的是 <strong>Slack 网页版内部的 websocket</strong>，不是官方 API，Slack 一改版就可能失效。</div>
            <div class="muted">断线频繁、3 分钟连不上或登录失效时，自动回退到轮询，15 分钟后再试，并通知你一次。轮询一直在跑，不会漏消息。</div>
            <div class="actions">
              <button class="primary" disabled={busy} onClick={() => { setConfirmRealtime(false); save("slack", { realtime: true }, "实时模式已开，几秒内连上。"); }}>知道了，开启</button>
              <button onClick={() => setConfirmRealtime(false)}>算了</button>
            </div>
          </div>
        )}
        <Row label="轮询间隔" hint={s.realtime ? "实时开着时，轮询只是兜底，可以放长些。" : "没开实时时，靠它收消息。"}>
          <select value={s.pollMinutes ?? ""} disabled={busy} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; save("slack", { pollMinutes: v ? Number(v) : null }, "轮询间隔已保存，马上生效。"); }}>
            <option value="">默认（每 {s.defaults.pollMinutes} 分钟）</option>
            {POLL_CHOICES.map((m) => <option key={m} value={m}>每 {m} 分钟</option>)}
          </select>
        </Row>
      </Group>

      <Group title="同一对话的新消息" note={noteFor("merge")}>
        <Row label="同一个 thread" hint="一个 thread 就是一个话题，默认不限时间。">
          <MergeSelect value={s.threadMergeHours} busy={busy} onPick={(h) => save("merge", { threadMergeHours: h }, "已保存，下一条新消息生效。")} />
        </Row>
        <Row label="同一个私信" hint="私信不分话题，默认只并 2 小时内的。">
          <MergeSelect value={s.dmMergeHours} busy={busy} onPick={(h) => save("merge", { dmMergeHours: h }, "已保存，下一条新消息生效。")} />
        </Row>
        <div class="row row-foot">上一个任务在这段时间里还有动静，新消息就并进去，接着原来的会话处理：agent 记得前面查过、起草过什么，一个对话只留一张审批卡。超过时间就开新任务。</div>
      </Group>

      <Group title="处理哪些消息" note={noteFor("filter")}>
        <Row label="下班时间只收不处理" hint="下班时间进来的 Slack 消息照样记下，到上班时间再处理。你自己在面板里的操作不受影响。">
          <Switch
            on={s.workHours !== null}
            disabled={busy}
            onChange={(on) => save("filter", { workHours: on ? { start: 9, end: 20, weekends: false } : null }, on ? "已打开：下班时间进来的消息，上班时间再处理。" : "已关闭：随时处理。")}
          />
        </Row>
        {s.workHours && (
          <>
            <Row label="上班时间" hint="按这台电脑的时间。">
              <select class="hour" value={s.workHours.start} disabled={busy} onChange={(e) => save("filter", { workHours: { ...s.workHours!, start: Number((e.target as HTMLSelectElement).value) } }, "上班时间已保存。")}>
                {HOURS.slice(0, 24).map((h) => <option key={h} value={h}>{h}:00</option>)}
              </select>
              <span class="muted">到</span>
              <select class="hour" value={s.workHours.end} disabled={busy} onChange={(e) => save("filter", { workHours: { ...s.workHours!, end: Number((e.target as HTMLSelectElement).value) } }, "下班时间已保存。")}>
                {HOURS.slice(1).map((h) => <option key={h} value={h}>{h}:00</option>)}
              </select>
            </Row>
            <Row label="周末也处理" hint="关着时，周六、周日进来的消息等到周一上班再处理。">
              <Switch on={s.workHours.weekends} disabled={busy} onChange={(on) => save("filter", { workHours: { ...s.workHours!, weekends: on } }, on ? "周末也处理。" : "周末只收不处理。")} />
            </Row>
          </>
        )}
        <Row label="不处理这些人的消息" hint="比如通知机器人、不用你回的人。">
          <SkipList ids={s.skipUsers} known={known.people} busy={busy} prefix="" onChange={(ids) => save("filter", { skipUsers: ids }, "已保存，下一条新消息生效。")} />
        </Row>
        <Row label="不处理这些频道里的 @" hint="比如 @ 全员的公告频道。">
          <SkipList ids={s.skipChannels} known={known.channels} busy={busy} prefix="#" onChange={(ids) => save("filter", { skipChannels: ids }, "已保存，下一条新消息生效。")} />
        </Row>
        <div class="row row-foot">跳过的消息照样记下，在「已结束」里能看到，点开后可以「仍然处理」。这些规则在启动 agent 之前就判断，不花钱。</div>
      </Group>

      <Group title="模型" note={noteFor("model")}>
        <Row label="模型" hint="派活和 Slack 任务共用，下一个任务生效。「默认」取工作区 profile.yaml 里的。">
          <select value={s.model ?? ""} disabled={busy} onChange={(e) => save("model", { model: (e.target as HTMLSelectElement).value || null }, "模型已保存，下一个任务生效。")}>
            <option value="">默认（{s.defaults.model}）</option>
            {s.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Row>
        <Row label="思考强度" hint="effort：越高越仔细，也越慢、越贵。">
          <select value={s.effort ?? ""} disabled={busy} onChange={(e) => save("model", { effort: (e.target as HTMLSelectElement).value || null }, "思考强度已保存，下一个任务生效。")}>
            <option value="">默认（{s.defaults.effort ?? "由模型决定"}）</option>
            {s.efforts.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Row>
      </Group>

      <Group title="通知" note={noteFor("notify")}>
        <Row label="macOS 通知" hint="有回复等你批、有事要你看、任务失败时弹系统通知。关掉后，诊断和实时连接出问题仍会提醒。">
          <Switch on={s.notifyMacos} disabled={busy} onChange={(on) => save("notify", { notifyMacos: on }, on ? "macOS 通知已打开。" : "macOS 通知已关闭。")} />
        </Row>
        <Row label="Slack 私信提醒" hint="同样的事给你自己发一条 Slack 私信，手机上也能看到；回复的草稿就在对话输入框里，点链接过去直接发出。">
          <Switch on={s.notifySlackDm} disabled={busy} onChange={(on) => save("notify", { notifySlackDm: on }, on ? "Slack 私信提醒已打开。" : "Slack 私信提醒已关闭。")} />
        </Row>
      </Group>

      <Group title="在 Claude Code 里继续" note={noteFor("continue")}>
        <Row
          label="打开方式"
          hint={s.continueIn === "terminal"
            ? "在终端里从 sidekick 的会话分叉出一个新会话：上下文都在，sidekick 这边不受影响。"
            : "在 Claude 桌面 app 里打开 sidekick 的原会话（桌面 app 不能分叉）。之后它归你，这个任务再跑时 sidekick 另开一个会话。"}
        >
          <select value={s.continueIn} disabled={busy} onChange={(e) => save("continue", { continueIn: (e.target as HTMLSelectElement).value }, "已保存。")}>
            <option value="terminal">终端（分叉新会话）</option>
            <option value="desktop">Claude 桌面 app</option>
          </select>
        </Row>
      </Group>

      <Group title="工作区" note={noteFor("root")}>
        <Row label="工作区目录" hint={<code class="path">{s.root}</code>}>
          {!editingRoot && <button onClick={() => { setRoot(s.root); setEditingRoot(true); }}>更改…</button>}
        </Row>
        {editingRoot && (
          <div class="row row-edit">
            <input value={root} onInput={(e) => setRoot((e.target as HTMLInputElement).value)} />
            {isNative() && <button disabled={busy} onClick={choose}>选择…</button>}
            <button class="primary" disabled={busy || !root.trim() || root === s.root} onClick={async () => { if (await save("root", { root }, "已保存。")) setEditingRoot(false); }}>保存</button>
            <button onClick={() => setEditingRoot(false)}>取消</button>
          </div>
        )}
        {pendingRoot && <div class="row row-foot tone-warn">当前仍在用 {s.runningRoot}，重启 daemon 后换成新目录。</div>}
        <div class="row row-foot">agent 在这个目录里干活，读它的 CLAUDE.md、skill 和 <code>sidekick/profile.yaml</code>。改了要重启 daemon。</div>
      </Group>

      <Doctor at={state?.doctor?.at} focus={focus === "doctor"} />

      <Group title="关于" note={noteFor("daemon")}>
        {state?.update && (
          <div ref={aboutRef}>
            <Row label={<span class="tone-good">有新版本 {state.update.version}</span>} hint={<>升级会退出菜单栏 app、换成新版再打开；正在跑的任务会重新排队。{state.update.url && <> <a href="#" onClick={(e) => { e.preventDefault(); openLink(state.update!.url); }}>看更新了什么</a></>}</>}>
              <button class="primary" onClick={() => { if (!native({ type: "upgrade" })) setUpgradeCmd(state.installCommand ?? ""); }}>升级</button>
            </Row>
            {upgradeCmd && <div class="row row-foot">在终端里运行：<pre class="code selectable">{upgradeCmd}</pre></div>}
          </div>
        )}
        <Row label="sidekick" hint={state?.version ? `版本 ${state.version}` : undefined}>
          <ConfirmButton label="重启 daemon" confirmLabel="确认重启（正在跑的任务会重新排队）" onConfirm={() => post("daemon", "/api/daemon/restart", "daemon 正在重启，几秒后自动重连。")} />
        </Row>
      </Group>
    </div>
  );
}

// ---- setup (no workspace yet) ---------------------------------------------------------------------------

function Setup({ setup, doctorAt }: { setup: NonNullable<State["setup"]>; doctorAt?: number }) {
  const [root, setRoot] = useState(setup.suggestedRoot);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ root: string; created: string[] } | null>(null);
  const firstRun = /config\.yaml/.test(setup.reason);

  const choose = async () => {
    const p = await pickFolder();
    if (p) setRoot(p);
  };
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      setDone(await api<{ root: string; created: string[] }>("/api/setup", { method: "POST", body: { root } }));
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="detail settings">
      <h2>{firstRun ? "开始用 sidekick" : "工作区要重新设置"}</h2>
      {firstRun ? (
        <div class="small">sidekick 在你的 Mac 上常驻，处理私信你和 @ 你的 Slack 消息：查资料、起草回复，你批了才发。</div>
      ) : (
        <div class="error">现在的工作区用不了：{setup.reason}</div>
      )}

      <h3>选一个工作区</h3>
      <div class="muted small">agent 在这个文件夹里运行，能读里面的代码。建议选放代码仓库的上一级目录，也可以新建一个。sidekick 会在里面建 <code>sidekick/</code> 子目录，放配置、处理 Slack 的流程和你的分身；已经有的不会覆盖。</div>
      <div class="field">
        <input value={root} disabled={busy || Boolean(done)} onInput={(e) => setRoot((e.target as HTMLInputElement).value)} />
        {isNative() && <button disabled={busy || Boolean(done)} onClick={choose}>选择…</button>}
      </div>
      <div class="actions">
        <button class="primary" disabled={busy || Boolean(done) || !root.trim()} onClick={submit}>{busy ? "设置中…" : "用这个文件夹"}</button>
      </div>
      {err && <div class="error">{err}</div>}
      {done && (
        <div class="ok small">
          工作区：{done.root}{done.created.length ? `，新建了 ${done.created.join("、")}` : "，用它已有的配置"}。daemon 正在重启，几秒后进入主界面。之后先去「✎ 分身」写几条。
        </div>
      )}

      <Doctor at={doctorAt} focus={false} />
    </div>
  );
}

// ---- app -----------------------------------------------------------------------------------------------

function App() {
  const [authed, setAuthed] = useState(Boolean(token()));
  const [state, setState] = useState<State | null>(null);
  const [tab, setTab] = useState<Tab>("attention");
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<false | "top" | "doctor" | "about">(false);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [online, setOnline] = useState(false);
  const [err, setErr] = useState("");
  const stopRef = useRef<(() => void) | null>(null);

  // #task=<id> opens a task: the menu bar app sets it when a notification is clicked.
  useEffect(() => {
    const follow = () => {
      const m = /^#task=([a-z]_[a-z0-9]+)$/.exec(location.hash);
      if (m) setSelected(m[1]);
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);

  useEffect(() => {
    if (!authed) return;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      stopRef.current = subscribe("/api/stream", (ev, data) => {
        if (ev === "changed") {
          setState((s) => ({ ...(s ?? { profile: "" }), ...data }));
          setTick((n) => n + 1);
          setOnline(true);
          native({ type: "refreshBadge" });
        }
      }, () => { setOnline(false); retry = setTimeout(connect, 3000); });
    };
    api<State>("/api/state").then((s) => { setState(s); setOnline(true); setErr(""); }).catch((e) => {
      if (e instanceof ApiError && e.status === 401) { setAuthed(false); return; }
      setErr(String(e.message));
    });
    connect();
    return () => { stopRef.current?.(); clearTimeout(retry); };
  }, [authed]);

  if (!authed) return <TokenGate onDone={() => setAuthed(true)} />;

  const c = state?.counts ?? {};
  return (
    <div class="app">
      <header>
        <div class="brand">
          <span class={`dot ${online ? "on" : "off"}`} title={online ? "已连接 daemon" : "连不上 daemon"} />sidekick<span class="muted small">{state?.profile}</span>
          <span class="right head-tools">
            {isNative() && <button class="link" title="在独立窗口中打开" onClick={() => native({ type: "openWindow" })}>⧉ 窗口</button>}
            {!state?.setup && <button class="link" onClick={() => { setPersonaOpen(true); setSettingsOpen(false); setSelected(null); }}>✎ 分身</button>}
            {!state?.setup && <button class="link" onClick={() => { setSettingsOpen("top"); setPersonaOpen(false); setSelected(null); }}>⚙︎ 设置</button>}
          </span>
        </div>
        {!state?.setup && <div class="chips">
          {state?.mode === "full" && <span class="chip bad" title="agent 的回复会直接发出，不经你确认">全托管中{state.modeUntil ? `（到 ${clock(state.modeUntil)}）` : ""}</span>}
          {state?.slack?.enabled && (() => {
            const chip = realtimeChip(state.slack.realtime);
            return <span class={`chip ${chip.tone}`} title={chip.title}>{chip.text}</span>;
          })()}
          {state?.doctor && state.doctor.fail + state.doctor.warn > 0 && (
            <button class={`chip ${state.doctor.fail ? "bad" : "warn"}`} title="打开诊断看怎么修" onClick={() => { setSettingsOpen("doctor"); setPersonaOpen(false); setSelected(null); }}>
              诊断：{state.doctor.fail ? `${state.doctor.fail} 项异常` : `${state.doctor.warn} 项需注意`}
            </button>
          )}
          {state?.update && (
            <button class="chip good" title="打开设置里的「关于」升级" onClick={() => { setSettingsOpen("about"); setPersonaOpen(false); setSelected(null); }}>
              新版本 {state.update.version}
            </button>
          )}
          <span class={`chip ${state?.pendingApprovals ? "warn" : ""}`}>待审批 {state?.pendingApprovals ?? 0}</span>
          <span class="chip">运行中 {c.running ?? 0}</span>
          <span class="chip muted" title="今天所有运行的花费（按 API 价折算）">今日 {money(state?.costToday) || "$0"}</span>
        </div>}
      </header>
      {err && <div class="error pad">{err}</div>}
      {state?.setup ? (
        <Setup setup={state.setup} doctorAt={state.doctor?.at} />
      ) : personaOpen ? (
        <Persona onBack={() => setPersonaOpen(false)} />
      ) : settingsOpen ? (
        <Settings key={settingsOpen} state={state} focus={settingsOpen} onBack={() => { setSettingsOpen(false); setTick((n) => n + 1); }} />
      ) : selected ? (
        <TaskDetail id={selected} tick={tick} onBack={() => setSelected(null)} />
      ) : (
        <>
          <GettingStarted doctorAt={state?.doctor?.at} onPersona={() => setPersonaOpen(true)} />
          <Dispatch onSent={(id) => { setSelected(id); setTick((n) => n + 1); }} />
          <nav class="tabs">
            {TABS.map((t) => (
              <button key={t.id} class={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
                {t.label}{t.id === "attention" && state?.attention ? <span class="badge">{state.attention}</span> : null}
              </button>
            ))}
          </nav>
          <TaskList tab={tab} tick={tick} onOpen={setSelected} />
        </>
      )}
      {!isNative() && <footer class="muted small">在浏览器里打开。接管会话需要菜单栏 app，这里只显示命令。</footer>}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
