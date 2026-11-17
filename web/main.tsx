import { render, type ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, appChecks, copyText, isNative, native, pickFolder, setToken, subscribe, token, type Approval, type Check, type Detail, type DoctorReport, type LogItem, type RealtimeView, type LoginJob, type Run, type SlackStatus, type State, type Status, type Task } from "./api.ts";
import { langFromPreferred, setLang, t, type LangSetting } from "../src/i18n.ts";

// Until /api/state says which language the daemon resolved, go by the browser's.
setLang(langFromPreferred(navigator.languages ?? [navigator.language]));

// ---- helpers ------------------------------------------------------------------------------------------

// Labels are looked up at render time: module constants are built before the language is known.
const statuses = (): Record<Status, { label: string; tone: string }> => ({
  needs_approval: { label: t("待审批", "To approve"), tone: "warn" },
  needs_me: { label: t("要你看", "Needs you"), tone: "warn" },
  failed: { label: t("失败", "Failed"), tone: "bad" },
  running: { label: t("运行中", "Running"), tone: "info" },
  queued: { label: t("排队", "Queued"), tone: "muted" },
  paused: { label: t("接管中", "Taken over"), tone: "info" },
  done: { label: t("完成", "Done"), tone: "good" },
  closed: { label: t("已关闭", "Closed"), tone: "muted" },
  cancelled: { label: t("已取消", "Cancelled"), tone: "muted" },
});

const sourceLabel = (kind: string): string =>
  ({ dm: t("私信", "DM"), mention: t("@我", "@me"), thread: t("thread", "Thread"), manual: t("手动", "Manual") } as Record<string, string>)[kind] ?? kind;

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return t("刚刚", "just now");
  if (s < 3600) return t(`${Math.floor(s / 60)} 分钟前`, `${Math.floor(s / 60)} min ago`);
  if (s < 86400) return t(`${Math.floor(s / 3600)} 小时前`, `${Math.floor(s / 3600)} h ago`);
  const d = new Date(ms);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const money = (v?: number | null) => (v ? `$${v.toFixed(v < 1 ? 3 : 2)}` : "");
const pad2 = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const span = (ms: number) => (ms < 60_000
  ? t("不到 1 分钟", "under 1 min")
  : ms < 3600_000
    ? t(`${Math.round(ms / 60_000)} 分钟`, `${Math.round(ms / 60_000)} min`)
    : t(`${(ms / 3600_000).toFixed(1)} 小时`, `${(ms / 3600_000).toFixed(1)} h`));

/** The header chip for the Slack connection. */
function realtimeChip(v: RealtimeView): { text: string; tone: string; title: string } {
  switch (v.state) {
    case "off": return { text: t("轮询", "Polling"), tone: "muted", title: t("实时模式没开，按间隔轮询 Slack", "Realtime mode is off: polling Slack at the interval") };
    case "connecting": return {
      text: t("连接中", "Connecting"),
      tone: "warn",
      title: t(`正在连 Slack 实时${v.error ? `：${v.error}` : ""}；轮询照常`, `Connecting to Slack in realtime${v.error ? `: ${v.error}` : ""}; polling goes on as usual`),
    };
    case "connected": return { text: t("实时", "Live"), tone: "good", title: t("Slack 实时连接中，新消息几秒内处理", "Connected to Slack in realtime: new messages are handled within seconds") };
    case "fallback": return { text: t("已回退轮询", "Back to polling"), tone: "warn", title: t(`${v.reason}；${clock(v.retryAt)} 再试实时`, `${v.reason}; trying realtime again at ${clock(v.retryAt)}`) };
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
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button class={`${cls} ${armed ? "armed" : ""}`} onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? confirmLabel : label}
    </button>
  );
}

function Pill({ status }: { status: Status }) {
  const s = statuses()[status] ?? { label: status, tone: "muted" };
  return <span class={`pill ${s.tone}`}>{s.label}</span>;
}

// ---- token gate (plain browser only) --------------------------------------------------------------------

function TokenGate({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState("");
  return (
    <div class="gate">
      <p>
        {t("在浏览器里打开时，需要 daemon 的 token。它在 ", "Opened in a browser, the panel needs the daemon's token. It is in ")}
        <code>~/.config/sidekick/runtime.json</code>{t(" 的 ", ", in the ")}<code>token</code>{t(" 字段。", " field.")}
      </p>
      <p class="muted">{t("菜单栏 app 里不用这一步。", "The menu bar app skips this step.")}</p>
      <input type="password" placeholder={t("粘贴 token", "Paste the token")} value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} />
      <button class="primary" disabled={!v.trim()} onClick={() => { setToken(v); onDone(); }}>{t("继续", "Continue")}</button>
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
        placeholder={t("派活：一句话或一个链接（⌘↩ 发送）", "Give it a task: a sentence or a link (⌘↩ to send)")}
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
      />
      <button class="primary" disabled={!text.trim() || busy} onClick={send}>{busy ? "…" : t("派活", "Assign")}</button>
      {err && <div class="error">{err}</div>}
    </div>
  );
}

// ---- approval card -------------------------------------------------------------------------------------

/** How a decided card ended, in words (results are written by approvals.ts and queries.ts). */
function decisionLabel(a: Approval): string {
  if (a.result === "sent in Slack") return t("你在 Slack 里发出了", "you sent it in Slack");
  if (a.result === "draft deleted in Slack") return t("你在 Slack 里删了草稿，不回", "you deleted the draft in Slack: no reply");
  if (a.result === "discarded: task cancelled") return t("任务已取消", "task cancelled");
  if (a.result === "superseded") return t("又来了新消息，被新的回复替换", "replaced by a newer reply after new messages");
  if (a.status === "executed") return t("已发出", "sent");
  if (a.status === "approved") return t("已批准", "approved");
  if (a.status === "denied") return t("已拒绝", "denied");
  if (a.status === "failed") {
    const why = a.result ? a.result.replace(/^failed: /, "") : "";
    return t(`失败${why ? `：${why}` : ""}`, `failed${why ? `: ${why}` : ""}`);
  }
  return a.status;
}

/** A decision note is what the person wrote, except the one full mode stores (approvals.ts AUTO_NOTE, compared as is there). */
const decisionNote = (note: string) => (note === "全托管自动发送" ? t("全托管自动发送", "Sent by Full auto") : note);

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
        <strong>{a.kind === "outbound" ? t("回复审批", "Reply approval") : t("操作审批", "Action approval")}</strong>
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
              <div class="muted small">{t("你实际发出的：", "What you actually sent:")}</div>
              <div class="quote">{a.payload.sentText}</div>
            </>
          )}
          {a.payload.reason && <div class="muted small">{t("理由：", "Reason: ")}{a.payload.reason}</div>}
          {pending && a.payload.draftId && <div class="muted small">{t("Slack 输入框里也有这份草稿，在 Slack 里改了发出、或者删掉都行，这张卡会跟着自己结掉。", "This draft is also in the Slack message box. Edit and send it there, or delete it: this card closes on its own either way.")}</div>}
          {pending && a.payload.draftError && <div class="muted small">{t("草稿没建成，批准后会直接发送。", "The Slack draft could not be created, so approving sends the reply directly.")}</div>}
        </>
      ) : (
        <pre class="code">{`${a.payload.tool_name}\n${typeof a.payload.input?.command === "string" ? a.payload.input.command : JSON.stringify(a.payload.input, null, 2)}`}</pre>
      )}
      {a.decision_note && <div class="muted small">{t("意见：", "Feedback: ")}{decisionNote(a.decision_note)}</div>}
      {pending && (
        <div class="actions">
          {!denying ? (
            <>
              <button class="primary" disabled={busy || (a.kind === "outbound" && !text.trim())} onClick={() => act("approve", edited ? { text } : {})}>
                {a.kind === "outbound" ? (edited ? t("改后发送", "Send edited") : t("批准发送", "Approve and send")) : t("批准", "Approve")}
              </button>
              <button disabled={busy} onClick={() => setDenying(true)}>{t("拒绝…", "Deny…")}</button>
            </>
          ) : (
            <>
              <input placeholder={t("意见（可选，填了会让它按意见重做）", "Feedback (optional: with it, the agent redoes the work)")} value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
              <button class="danger" disabled={busy} onClick={() => act("deny", note.trim() ? { note } : {})}>{t("确认拒绝", "Deny")}</button>
              <button disabled={busy} onClick={() => setDenying(false)}>{t("算了", "Never mind")}</button>
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
      {items.length === 0 && <div class="muted small">{live ? t("等待输出…", "Waiting for output…") : t("没有日志", "No log")}</div>}
      {items.map((it, i) => {
        switch (it.kind) {
          case "init": return <div key={i} class="muted small">{t("开始", "Started")} · {it.model}</div>;
          case "text": return <div key={i} class="log-text">{it.text}</div>;
          case "tool": return <details key={i} class="log-tool"><summary>⚙︎ {it.name} <span class="muted">{it.input.split("\n")[0].slice(0, 80)}</span></summary><pre class="code">{it.input}</pre></details>;
          case "tool_result": return <details key={i} class={`log-result ${it.error ? "bad" : ""}`}><summary>{it.error ? t("✗ 出错", "✗ Error") : t("↳ 结果", "↳ Result")} <span class="muted">{it.text.split("\n")[0].slice(0, 80)}</span></summary><pre class="code">{it.text}</pre></details>;
          case "result": return (
            <div key={i} class={`log-end ${it.error ? "bad" : ""}`}>
              {t(`结束 · ${it.turns ?? "?"} 轮`, `Finished · ${it.turns ?? "?"} turns`)} · {money(it.cost)}{it.denials ? t(` · 被拒 ${it.denials} 次`, ` · denied ${it.denials} times`) : ""}
            </div>
          );
          case "stderr": return <pre key={i} class="code bad">{it.text}</pre>;
        }
      })}
      {live && <div class="muted small live-dot">{t("运行中", "Running")}</div>}
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

  if (!d) return <div class="detail"><button class="link" onClick={onBack}>{t("← 返回", "← Back")}</button>{err && <div class="error">{err}</div>}</div>;
  const task = d.task;
  const pending = d.approvals.filter((a) => a.status === "pending");
  const decided = d.approvals.filter((a) => a.status !== "pending");
  const open = ["queued", "running", "needs_approval", "needs_me", "paused", "failed"].includes(task.status);

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
        setInfo(t("已在 Claude 桌面 app 里打开这个会话。之后它归你：这个任务再跑时，sidekick 会另开一个会话。", "Opened this session in the Claude desktop app. It is yours from now on: when this task runs again, sidekick starts a new session."));
      } else if (path === "continue") {
        if (native({ type: "continue", cwd: r.cwd!, session: r.session!, name: r.name! })) setInfo(t("已在终端打开：从这个会话分叉出来的新会话，sidekick 这边不受影响。", "Opened in Terminal: a new session forked from this one. sidekick's side is not affected."));
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
        <button class="link" onClick={onBack}>{t("← 返回", "← Back")}</button>
        <Pill status={task.status} />
      </div>
      <h2>{task.title}</h2>
      <div class="muted small">
        {sourceLabel(task.kind)} · {t(`${ago(task.created_at)} 创建`, `created ${ago(task.created_at)}`)} · {task.id}
        {task.link && <> · <a href="#" onClick={(e) => { e.preventDefault(); openLink(task.link!); }}>{t("在 Slack 打开", "Open in Slack")}</a></>}
      </div>
      {task.summary && <div class="summary"><span class="muted small">{t(`结论${task.outcome ? `（${task.outcome}）` : ""}`, `Conclusion${task.outcome ? ` (${task.outcome})` : ""}`)}</span><div>{task.summary}</div></div>}
      {task.status === "queued" && task.not_before && task.not_before > Date.now() && (
        <div class="actions">
          <span class="muted small">{t(`下班时间进来的，${clock(task.not_before)} 开始处理。`, `Arrived outside working hours: starts at ${clock(task.not_before)}.`)}</span>
          <button onClick={() => act("process")}>{t("现在处理", "Process now")}</button>
        </div>
      )}
      {task.status === "closed" && task.outcome === "skipped" && (
        <div class="actions"><span class="muted small">{t("按设置里的规则跳过了。", "Skipped by a rule in Settings.")}</span><button onClick={() => act("process")}>{t("仍然处理", "Process anyway")}</button></div>
      )}
      {err && <div class="error">{err}</div>}

      {pending.map((a) => <ApprovalCard key={a.id} a={a} onDone={load} />)}

      <div class="actions">
        {task.session_id && task.status !== "running" && (
          <button
            onClick={() => act("continue")}
            title={t("带着 sidekick 这个会话的全部上下文，在你自己的 Claude Code 里接着做；sidekick 这边不暂停、不用交还", "Pick up in your own Claude Code with all the context of sidekick's session. sidekick does not pause, and there is nothing to hand back.")}
          >
            {t("在 Claude Code 里继续", "Continue in Claude Code")}
          </button>
        )}
        {task.session_id && task.status !== "running" && task.status !== "paused" && open && (
          <button
            onClick={() => act("takeover")}
            title={t("暂停任务，在终端里接着它的会话做（仍受 sidekick 的限制），做完点「交还」让 sidekick 收尾", "Pause the task and carry on its session in Terminal (sidekick's limits still apply). When you are done, click Hand back and sidekick wraps up.")}
          >
            {t("接管", "Take over")}
          </button>
        )}
        {task.status === "paused" && (
          <>
            <input placeholder={t("交还时带一句话（可选）", "A note to hand back with (optional)")} value={handbackMsg} onInput={(e) => setHandbackMsg((e.target as HTMLInputElement).value)} />
            <button class="primary" onClick={() => act("handback", handbackMsg.trim() ? { message: handbackMsg } : {})}>{t("交还", "Hand back")}</button>
          </>
        )}
        {task.session_id && task.status === "paused" && <button onClick={() => act("takeover")}>{t("再开一次终端", "Open Terminal again")}</button>}
        {task.status === "running" && <ConfirmButton cls="danger" label={t("终止", "Stop")} confirmLabel={t("确认终止", "Confirm stop")} onConfirm={() => act("cancel")} />}
        {open && task.status !== "running" && <button class="danger" onClick={() => act("cancel")}>{t("取消任务", "Cancel task")}</button>}
        <ConfirmButton cls="danger right" label={t("删除记录", "Delete record")} confirmLabel={t("确认删除", "Confirm delete")} onConfirm={remove} />
      </div>
      {info && <div class="muted small">{info}</div>}
      {cmd && <pre class="code selectable">{cmd}</pre>}

      {d.events.length > 0 && <h3>{t("消息", "Messages")}</h3>}
      {d.events.map((e) => (
        <div key={e.id} class="card">
          <div class="card-head"><strong>{e.user_name ?? "?"}</strong><span class="muted">{e.channel_name ?? ""} · {ago(e.received_at)}</span></div>
          <div class="quote">{e.text}</div>
        </div>
      ))}

      {d.runs.length > 0 && <h3>{t("运行", "Runs")}</h3>}
      {d.runs.map((r) => (
        <div key={r.id} class="card run">
          <button class="run-head" onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
            <span>{openRun === r.id ? "▾" : "▸"} {ago(r.started_at)}</span>
            <span class="muted">
              {r.ended_at
                ? t(`${Math.round((r.ended_at - r.started_at) / 1000)}s · ${r.turns ?? "?"} 轮 · ${money(r.cost_usd)}`, `${Math.round((r.ended_at - r.started_at) / 1000)}s · ${r.turns ?? "?"} turns · ${money(r.cost_usd)}`)
                : t("运行中", "Running")}
              {r.error ? ` · ${r.error}` : ""}
            </span>
          </button>
          {openRun === r.id && <LogView run={r} />}
        </div>
      ))}

      {decided.length > 0 && <h3>{t("审批记录", "Approvals")}</h3>}
      {decided.map((a) => <ApprovalCard key={a.id} a={a} onDone={load} />)}
    </div>
  );
}

// ---- list ----------------------------------------------------------------------------------------------

type Tab = "attention" | "active" | "closed" | "all";
const tabs = (): Array<{ id: Tab; label: string }> => [
  { id: "attention", label: t("要你处理", "For you") },
  { id: "active", label: t("进行中", "In progress") },
  { id: "closed", label: t("已结束", "Finished") },
  { id: "all", label: t("全部", "All") },
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
    {
      id: "slack-login",
      label: t("登录 Slack", "Sign in to Slack"),
      hint: t("sidekick 用你的身份读私信和 @ 你的消息。会单独开一个 Chrome 窗口（不是你平时的浏览器），在里面登录一次。", "sidekick reads your DMs and the messages that @-mention you, as you. It opens a separate Chrome window (not your usual browser): sign in there once."),
      action: <SlackLoginButton {...login} />,
    },
    {
      id: "persona",
      label: t("写分身", "Write your persona"),
      hint: t("你是谁、负责什么、怎么回话；可以复制 prompt 交给你自己的 agent 写。", "Who you are, what you own, how you reply. You can copy a prompt and let your own agent write it."),
      action: <button onClick={onPersona}>{t("去写", "Write")}</button>,
    },
    ...(isNative() ? [{
      id: "app-notify",
      label: t("允许通知", "Allow notifications"),
      hint: t("有回复等你批时弹通知。系统设置 → 通知 → Sidekick。", "Get a notification when a reply waits for your approval. System Settings → Notifications → Sidekick."),
      action: null,
    }] : []),
  ];
  if (steps.every((x) => ok(x.id))) return null;
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(STARTED_KEY, "1"); } catch { /* private mode: it shows again next time */ }
  };
  return (
    <section class="getting-started">
      <div class="gs-head"><strong>{t("开始用 sidekick", "Get started")}</strong><button class="link" onClick={dismiss}>{t("收起", "Hide")}</button></div>
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
  if (!tasks) return <div class="muted pad">{t("加载中…", "Loading…")}</div>;
  if (tasks.length === 0) return <div class="muted pad">{tab === "attention" ? t("没有要你处理的事。", "Nothing needs you.") : t("没有任务。", "No tasks.")}</div>;
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
      <div class="list-tools">
        <span class="muted small">{t(`${tasks.length} 个已结束`, `${tasks.length} finished`)}</span>
        <ConfirmButton cls="danger" label={t("清空已结束", "Clear finished")} confirmLabel={t("确认全部删除", "Confirm delete all")} onConfirm={clear} />
      </div>
    )}
    <ul class="tasks">
      {tasks.map((task) => (
        <li key={task.id} onClick={() => onOpen(task.id)}>
          <div class="row-top"><Pill status={task.status} />{(task.pending_approvals ?? 0) > 0 && <span class="badge">{task.pending_approvals}</span>}<span class="muted small right">{ago(task.updated_at)}</span></div>
          <div class="title">{task.title}</div>
          <div class="muted small">
            {sourceLabel(task.kind)}
            {task.status === "queued" && task.not_before && task.not_before > Date.now() ? t(` · ${clock(task.not_before)} 开始处理`, ` · starts at ${clock(task.not_before)}`) : ""}
            {(task.messages ?? 0) > 1 ? t(` · ${task.messages} 条消息`, ` · ${task.messages} messages`) : ""}
            {task.cost_usd ? ` · ${money(task.cost_usd)}` : ""}
            {task.summary ? ` · ${task.summary.split("\n")[0].slice(0, 60)}` : ""}
          </div>
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

const actions = (): Record<string, { label: string; tone: string }> => ({
  reply: { label: t("会回复", "Would reply"), tone: "good" },
  no_reply: { label: t("不用回", "No reply needed"), tone: "muted" },
  needs_me: { label: t("交给你看", "Would pass it to you"), tone: "warn" },
});

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
    const timer = setInterval(async () => {
      setNow(Date.now());
      try {
        setTrial(await api<Trial>(`/api/persona/trials/${trial.id}`));
      } catch (e) {
        setErr(String((e as Error).message));
      }
    }, 2000);
    return () => clearInterval(timer);
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
      <h3>{t("试跑", "Dry run")}</h3>
      <div class="muted small">
        {t("挑一条最近的 Slack 消息，按已保存的分身走一遍：只看它会怎么判断、怎么回，不建草稿、不发消息。花费和处理一条真消息差不多。", "Pick a recent Slack message and run it through the saved persona: see how it would judge it and what it would reply, with no draft made and nothing sent. It costs about as much as handling a real message.")}
      </div>
      {!samples ? (
        <div class="muted small pad-y">{t("加载最近的消息…", "Loading recent messages…")}</div>
      ) : samples.length === 0 ? (
        <div class="muted small pad-y">{t("账本里还没有 Slack 消息，收到第一条后就能试跑。", "No Slack messages recorded yet. Once the first one comes in, you can do a dry run.")}</div>
      ) : (
        <div class="field">
          <select value={pick ?? ""} disabled={running} onChange={(e) => setPick(Number((e.target as HTMLSelectElement).value))}>
            {samples.map((s) => (
              <option key={s.id} value={s.id}>
                {ago(s.received_at)} · {s.user_name ?? "?"}{s.channel_name ? ` @ ${s.channel_name}` : ""}{t("：", ": ")}{s.text.replace(/\s+/g, " ").slice(0, 60)}
              </option>
            ))}
          </select>
          <button class="primary" disabled={running || pick === null} onClick={start}>{running ? t("试跑中…", "Running…") : t("试跑", "Dry run")}</button>
        </div>
      )}
      {dirty && <div class="warn-line small">{t("有没保存的修改：试跑用的是已保存的版本。", "You have unsaved changes: the dry run uses the saved version.")}</div>}
      {trial && (
        <div class="card">
          {running && (
            <div class="live-dot small">
              {t(`正在处理，已 ${Math.round((Date.now() - trial.startedAt) / 1000)} 秒（一般 30–90 秒）`, `Working, ${Math.round((Date.now() - trial.startedAt) / 1000)} s so far (usually 30–90 s)`)}
            </div>
          )}
          {trial.status === "failed" && <div class="error">{t("试跑失败：", "Dry run failed: ")}{trial.error}</div>}
          {r && (
            <>
              <div class="card-head">
                <span class={`pill ${actions()[r.action].tone}`}>{actions()[r.action].label}</span>
                <span class="muted small">{money(trial.costUsd)}{trial.endedAt ? t(` · ${Math.round((trial.endedAt - trial.startedAt) / 1000)} 秒`, ` · ${Math.round((trial.endedAt - trial.startedAt) / 1000)} s`) : ""}</span>
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
      setNote(p.corrections
        ? t(`已复制，里面带了你最近改过、拒绝过的 ${p.corrections} 条回复。`, `Copied, with the ${p.corrections} replies you recently edited or denied.`)
        : t("已复制。", "Copied."));
    } else {
      setShow(true);
      setNote(t("复制失败，在下面全选手动复制。", "Could not copy. Select all below and copy it by hand."));
    }
  };
  return (
    <div class="card">
      <strong>{t("让你自己的 agent 来写", "Let your own agent write it")}</strong>
      <div class="muted small">
        {t("复制这段 prompt，贴给你本机的 Claude Code 或别的 agent。它会先读现有资料和你最近改过、拒绝过的回复；查得到的自己查，查不到的一次问你一个问题；改完给你看过再保存。", "Copy this prompt into Claude Code or another agent on this Mac. It first reads what is there and the replies you recently edited or denied, looks up what it can, asks you about the rest one question at a time, and shows you the result before saving.")}
      </div>
      <div class="actions">
        <button disabled={!p} onClick={copy}>{t("复制 prompt", "Copy prompt")}</button>
        {canReload && <button class="link" onClick={onReload}>{t("agent 改完了，重新加载", "The agent is done: reload")}</button>}
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

  if (!files) return <div class="detail"><button class="link" onClick={onBack}>{t("← 返回", "← Back")}</button>{err && <div class="error">{err}</div>}</div>;
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
          ? <ConfirmButton label={t("← 返回", "← Back")} confirmLabel={t("放弃没保存的修改并返回", "Discard unsaved changes and go back")} cls="link" onConfirm={onBack} />
          : <button class="link" onClick={onBack}>{t("← 返回", "← Back")}</button>}
      </div>
      <h2>{t("分身", "Persona")}</h2>
      <div class="muted small">
        {t("每次处理消息，agent 都会先读这份资料：你是谁、负责什么、怎么说话、哪些事不能替你答应。保存后下一个任务就用上。", "The agent reads this before it handles any message: who you are, what you own, how you talk, and what it must not agree to for you. Once saved, the next task uses it.")}
      </div>
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
          {dirty
            ? (f.exists ? t("有修改未保存", "Unsaved changes") : t("未保存，保存后新建这个文件", "Not saved: saving creates this file"))
            : !f.exists
              ? t("还没有这个文件", "This file does not exist yet")
              : saved[f.path]
                ? t(`已保存 ${clock(saved[f.path])}`, `Saved ${clock(saved[f.path])}`)
                : t("已是最新", "Up to date")}
        </span>
      </div>
      <textarea
        class="persona-editor"
        value={text}
        placeholder={t("还没写。点下面的「用模板开始」。", "Nothing here yet. Click Start from the template below.")}
        onInput={(e) => setDrafts({ ...drafts, [f.path]: (e.target as HTMLTextAreaElement).value })}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (dirty && !busy) save(); } }}
      />
      <div class="actions">
        <button class="primary" disabled={busy || !dirty || conflict} onClick={save}>{busy ? t("保存中…", "Saving…") : t("保存", "Save")}</button>
        <button disabled={busy || !dirty} onClick={() => setDrafts({ ...drafts, [f.path]: f.content })}>{t("撤销修改", "Revert changes")}</button>
        {!text.trim() && <button disabled={busy} onClick={() => setDrafts({ ...drafts, [f.path]: template })}>{t("用模板开始", "Start from the template")}</button>}
        <span class="muted small">{t("⌘S 保存", "⌘S to save")}</span>
      </div>
      {conflict && (
        <div class="warn-line small">
          {t("文件在别处改过了（编辑器或 git）。先复制你的修改，再 ", "The file was changed elsewhere (an editor or git). Copy your changes first, then ")}
          <button class="link" onClick={load}>{t("重新加载", "reload")}</button>{t("。", ".")}
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
  language: LangSetting;
  defaults:{ model: string; effort: string | null; pollMinutes: number }; models: string[]; efforts: string[]; restartNeeded?: boolean;
}

const POLL_CHOICES = [1, 2, 3, 5, 10, 15, 30, 60];

/** How long a conversation keeps its task (settings.ts threadMergeHours / dmMergeHours); null: no limit. */
const mergeChoices = (): Array<{ hours: number | null; label: string }> => [
  { hours: null, label: t("不限时间", "No time limit") },
  { hours: 24, label: t("1 天内", "Within 1 day") },
  { hours: 8, label: t("8 小时内", "Within 8 hours") },
  { hours: 2, label: t("2 小时内", "Within 2 hours") },
  { hours: 0.5, label: t("30 分钟内", "Within 30 minutes") },
  { hours: 0, label: t("不并，上一个处理完就开新的", "Never: a new task once the last one is done") },
];

function MergeSelect({ value, busy, onPick }: { value: number | null; busy: boolean; onPick: (hours: number | null) => void }) {
  const choices = mergeChoices();
  const known = choices.some((c) => c.hours === value);
  return (
    <select value={value === null ? "none" : String(value)} disabled={busy} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; onPick(v === "none" ? null : Number(v)); }}>
      {!known && <option value={String(value)}>{t(`${value} 小时内`, `Within ${value} hours`)}</option>}
      {choices.map((c) => <option key={String(c.hours)} value={c.hours === null ? "none" : String(c.hours)}>{c.label}</option>)}
    </select>
  );
}

function SlackLines({ slack }: { slack: SlackStatus }) {
  const v = slack.realtime;
  const now = Date.now();
  const c = slack.lastCollect;
  return (
    <div class="status-lines small">
      <span class="k">{t("实时", "Live")}</span>
      <span class={`v ${v.state === "connected" ? "tone-good" : v.state === "off" ? "" : "tone-warn"}`}>
        {v.state === "off" && t("未开启", "Off")}
        {v.state === "connecting" && t(`连接中（${span(now - v.since)}）${v.error ? `：${v.error}` : ""}`, `Connecting (${span(now - v.since)})${v.error ? `: ${v.error}` : ""}`)}
        {v.state === "connected" && t(`已连接 ${span(now - v.since)}`, `Connected for ${span(now - v.since)}`)}
        {v.state === "fallback" && t(`已回退轮询：${v.reason}；${clock(v.retryAt)} 再试`, `Back to polling: ${v.reason}; trying again at ${clock(v.retryAt)}`)}
      </span>
      <span class="k">{t("轮询", "Polling")}</span>
      <span class="v">
        {t(`每 ${slack.pollMinutes} 分钟`, `Every ${slack.pollMinutes} min`)}
        {slack.nextCollectAt ? t(`，下次 ${clock(slack.nextCollectAt)}`, `, next ${clock(slack.nextCollectAt)}`) : ""}
      </span>
      <span class="k">{t("上次采集", "Last collect")}</span>
      <span class={`v ${c?.error ? "tone-bad" : ""}`}>
        {!c
          ? t("还没采集", "None yet")
          : c.error
            ? t(`${clock(c.at)} 失败：${c.error}`, `${clock(c.at)} failed: ${c.error}`)
            : t(`${clock(c.at)}，新增 ${c.added} 条，用时 ${(c.ms / 1000).toFixed(1)} 秒`, `${clock(c.at)}, ${c.added} new, took ${(c.ms / 1000).toFixed(1)} s`)}
        {slack.collectingSince ? t(`（${clock(slack.collectingSince)} 起正在采集）`, ` (collecting since ${clock(slack.collectingSince)})`) : ""}
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
    const timer = setInterval(() => { api<LoginJob>("/api/slack/login").then(setJob).catch(() => {}); }, 2000);
    return () => clearInterval(timer);
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
  return <button disabled={job?.state === "running"} onClick={start}>{job?.state === "running" ? t("等你在 Chrome 窗口里登录…", "Waiting for you in the Chrome window…") : t("登录 Slack", "Sign in to Slack")}</button>;
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
    setCopied((await copyText(c.command ?? "")) ? t("已复制", "Copied") : t("复制失败，手动选中", "Could not copy: select it by hand"));
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
          {c.command && <div class="code"><span>{c.command}</span><button onClick={copy}>{copied || t("复制", "Copy")}</button></div>}
        </div>
      )}
    </li>
  );
}

// Settings are laid out like a system settings pane: titled groups of rows, what a setting is on the
// left, its control on the right (wrapping below it in the narrow popover), and the feedback of a
// change shown under the group it was made in.

type Note = { group: string; text: string; tone: "ok" | "bad" };

function Group({ title, note, children }: { title?: string; note?: Note | null; children: ComponentChildren }) {
  return (
    <section class="group">
      {title && <h3>{title}</h3>}
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
      <Group title={t("诊断", "Diagnostics")} note={err ? { group: "doctor", tone: "bad", text: err } : null}>
        <Row
          label={!report
            ? t("还没跑过", "Not run yet")
            : bad.length
              ? <span class="tone-warn">{t(`${bad.length} 项要处理`, `${bad.length} to fix`)}</span>
              : <span class="tone-good">{t("全部正常", "All good")}</span>}
          hint={t(
            `${report ? `${clock(report.at)} 的结果。` : ""}daemon 启动后、每 6 小时、采集出错后会自动跑，有问题会通知你。`,
            `${report ? `Results from ${clock(report.at)}. ` : ""}Runs on its own when the daemon starts, every 6 hours, and after a failed collect; you are notified of problems.`,
          )}
        >
          <button disabled={busy} onClick={run}>{busy ? t("诊断中…", "Running…") : t("运行诊断", "Run diagnostics")}</button>
        </Row>
        {bad.length > 0 && <ul class="checks">{bad.map((c) => <CheckRow key={c.id} c={c} />)}</ul>}
        {good.length > 0 && (
          <details class="row-details">
            <summary>{bad.length ? t(`其余 ${good.length} 项正常`, `${good.length} other checks passed`) : t(`查看 ${good.length} 项检查`, `Show ${good.length} checks`)}</summary>
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
        <button key={id} class="chip" disabled={busy} title={t("不再跳过", "Stop skipping")} onClick={() => onChange(ids.filter((x) => x !== id))}>{prefix}{name(id)} ✕</button>
      ))}
      {addable.length > 0 && (
        <select value="" disabled={busy} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) onChange([...ids, v]); }}>
          <option value="">{t("添加…", "Add…")}</option>
          {addable.map((k) => <option key={k.id} value={k.id}>{prefix}{k.name}{t(`（${k.messages} 条）`, ` (${k.messages} messages)`)}</option>)}
        </select>
      )}
      {ids.length === 0 && addable.length === 0 && <span class="muted small">{t("账本里还没有最近的消息。", "No recent messages recorded yet.")}</span>}
    </div>
  );
}

const HOURS = Array.from({ length: 25 }, (_, h) => h);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const minutes = (v: string) => { const [h, m] = v.split(":").map(Number); return (h || 0) * 60 + (m || 0); };

function Settings({ state, focus, onBack, onLangChanged }: { state: State | null; focus: "top" | "doctor" | "about"; onBack: () => void; onLangChanged: () => Promise<void> }) {
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
    const timer = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(timer);
  }, [note]);

  const save = async (group: string, patch: Record<string, unknown>, text: string): Promise<boolean> => {
    setBusy(true);
    try {
      const x = await api<SettingsView>("/api/settings", { method: "PUT", body: patch });
      setS(x);
      setNote({ group, tone: "ok", text: x.restartNeeded ? t("已保存，重启 daemon 后生效。", "Saved. It takes effect after you restart the daemon.") : text });
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
    save("mode", { autoFull: { ...s.autoFull, windows: s.autoFull.windows.map((x, k) => (k === i ? w : x)) } }, t("时段已保存。", "Time window saved."));
  };
  // The whole panel switches at once: /api/state carries the language the daemon resolved (auto
  // follows the Mac's), and the note is set again so it reads in the new language.
  const pickLanguage = async (language: LangSetting) => {
    if (!(await save("language", { language }, t("已保存。", "Saved.")))) return;
    await onLangChanged();
    setNote({ group: "language", tone: "ok", text: t("已保存。", "Saved.") });
  };
  const choose = async () => {
    const p = await pickFolder();
    if (p) setRoot(p);
  };

  if (!s) return <div class="detail"><button class="link" onClick={onBack}>{t("← 返回", "← Back")}</button>{loadErr && <div class="error">{loadErr}</div>}</div>;
  const slack = state?.slack;
  const pendingRoot = s.root !== s.runningRoot;
  return (
    <div class="detail settings">
      <div class="detail-head"><button class="link" onClick={onBack}>{t("← 返回", "← Back")}</button></div>
      <h2>{t("设置", "Settings")}</h2>

      <Group note={noteFor("language")}>
        {/* Both languages at once, so someone stuck in the wrong one can still find it. */}
        <Row label="语言 · Language">
          <div class="segmented">
            {/* The language names are always written in their own language. */}
            {([["auto", t("跟随系统", "Follow system")], ["zh", "中文"], ["en", "English"]] as Array<[LangSetting, string]>).map(([v, label]) => (
              <button key={v} class={s.language === v ? "on" : ""} disabled={busy} onClick={() => s.language !== v && pickLanguage(v)}>{label}</button>
            ))}
          </div>
        </Row>
      </Group>

      <Group title={t("回复方式", "Replies")} note={noteFor("mode")}>
        <Row
          label={t("托管模式", "Reply mode")}
          hint={s.mode === "semi"
            ? t("agent 起草的 Slack 回复，都要你批了才发。", "Every Slack reply the agent drafts waits for your approval before it is sent.")
            : t("agent 的回复直接以你的名义发出，适合请假值班。拿不准的仍交给你，每条发出后私信你一份；切换前已在等你的回复，仍然等你批。", "The agent's replies go out in your name right away, for when you are on leave. Anything it is unsure of still comes to you, and you get a DM copy of each reply it sends; replies already waiting when you switch still wait for you.")}
        >
          <div class={`segmented ${s.mode === "full" ? "is-full" : ""}`}>
            <button class={s.mode === "semi" ? "on" : ""} disabled={busy} onClick={() => s.mode !== "semi" && save("mode", { mode: "semi" }, t("已切到半托管：回复都要你批。", "Switched to Approve first: every reply waits for you."))}>{t("半托管", "Approve first")}</button>
            <button class={s.mode === "full" ? "on" : ""} disabled={busy} onClick={() => s.mode !== "full" && save("mode", { mode: "full" }, t("已切到全托管：之后的回复会直接发出，每条都私信你一份。", "Switched to Full auto: replies now go out directly, and you get a DM copy of each."))}>{t("全托管", "Full auto")}</button>
          </div>
        </Row>
        <Row
          label={t("回复带署名行", "Signature line")}
          hint={t("sidekick 发出的回复上面加一行灰色小字：你批准的是「🗣️ Drafted by sidekick · approved by me」，全托管自动发出的是「🗣️ Auto-reply by sidekick · not yet reviewed by me」。你在 Slack 里自己把草稿发出去的不带。", "Replies sidekick sends get a small grey line on top: “🗣️ Drafted by sidekick · approved by me” on ones you approved, “🗣️ Auto-reply by sidekick · not yet reviewed by me” on ones sent in Full auto. Drafts you send yourself in Slack get none.")}
        >
          <Switch on={s.signReplies} disabled={busy} onChange={(on) => save("mode", { signReplies: on }, on ? t("之后的回复会带署名行。", "Replies from now on carry the signature line.") : t("之后的回复不带署名行。", "Replies from now on have no signature line."))} />
        </Row>
        <Row
          label={t("定时全托管", "Scheduled full auto")}
          hint={s.mode === "full"
            ? t("上面选了全托管，就一直是全托管，时段不起作用。", "Full auto is chosen above, so it stays on all the time and the time windows do nothing.")
            : state?.mode === "full" && state.modeUntil
              ? <span class="tone-warn">{t(`现在就在全托管时段里，到 ${clock(state.modeUntil)}。`, `In a full auto time window now, until ${clock(state.modeUntil)}.`)}</span>
              : t("比如午休：时段内回复直接发出，其他时间要你批。切换时会提醒你。", "Say, over lunch: inside the window replies go out directly, outside it they wait for you. You get a reminder when it switches.")}
        >
          <Switch
            on={s.autoFull !== null}
            disabled={busy}
            onChange={(on) => save("mode", { autoFull: on ? { windows: [{ start: 12 * 60, end: 13 * 60 + 30 }], weekends: false } : null }, on ? t("已打开定时全托管。", "Scheduled full auto is on.") : t("已关闭定时全托管。", "Scheduled full auto is off."))}
          />
        </Row>
        {s.autoFull && (
          <>
            {s.autoFull.windows.map((w, i) => (
              <Row key={i} label={s.autoFull!.windows.length > 1 ? t(`时段 ${i + 1}`, `Time window ${i + 1}`) : t("时段", "Time window")}>
                <input type="time" class="time" value={hhmm(w.start)} disabled={busy} onChange={(e) => setWindow(i, { ...w, start: minutes((e.target as HTMLInputElement).value) })} />
                <span class="muted">{t("到", "to")}</span>
                <input type="time" class="time" value={hhmm(w.end % 1440)} disabled={busy} onChange={(e) => setWindow(i, { ...w, end: minutes((e.target as HTMLInputElement).value) || 1440 })} />
                {s.autoFull!.windows.length > 1 && (
                  <button class="link" disabled={busy} onClick={() => save("mode", { autoFull: { ...s.autoFull!, windows: s.autoFull!.windows.filter((_, k) => k !== i) } }, t("已删掉这个时段。", "Time window deleted."))}>
                    {t("删除", "Delete")}
                  </button>
                )}
              </Row>
            ))}
            {s.autoFull.windows.length < 6 && (
              <Row label="" hint={undefined}>
                <button disabled={busy} onClick={() => save("mode", { autoFull: { ...s.autoFull!, windows: [...s.autoFull!.windows, { start: 18 * 60, end: 19 * 60 }] } }, t("已加一个时段。", "Time window added."))}>
                  {t("加一个时段", "Add a time window")}
                </button>
              </Row>
            )}
            <Row label={t("周末也按时段", "Weekends too")} hint={t("关着时，周六、周日不自动切换。", "When off, it does not switch on Saturdays and Sundays.")}>
              <Switch on={s.autoFull.weekends} disabled={busy} onChange={(on) => save("mode", { autoFull: { ...s.autoFull!, weekends: on } }, on ? t("周末也按时段切换。", "Switches on weekends too.") : t("周末不自动切换。", "No switching on weekends."))} />
            </Row>
          </>
        )}
      </Group>

      <Group title="Slack" note={noteFor("slack")}>
        {slack?.enabled ? (
          <div class="row row-status">
            <SlackLines slack={slack} />
            {slack.realtime.state === "fallback" && <button onClick={() => post("slack", "/api/realtime/retry", t("正在重连实时。", "Reconnecting realtime."))}>{t("现在重试实时", "Retry realtime now")}</button>}
          </div>
        ) : (
          <Row label={t("连接", "Connection")} hint={slack ? t("profile 里关了 Slack。", "Slack is turned off in the profile.") : t("连不上 daemon，看不到状态。", "Cannot reach the daemon, so there is no status.")} />
        )}
        <Row
          label={t("Slack 登录", "Slack sign-in")}
          hint={login.job && login.job.state !== "idle"
            ? <span class={jobTone(login.job)}>{login.job.message}</span>
            : t("会单独开一个 Chrome 窗口（不是你平时的浏览器；没装 Chrome 时用 Edge 或 Brave），在里面登录一次。以后登录过期再点，会自己完成。", "Opens a separate Chrome window (not your usual browser; Edge or Brave if Chrome is not installed): sign in there once. When the sign-in expires later, click again and it finishes on its own.")}
        >
          <SlackLoginButton {...login} />
        </Row>
        <Row label={t("实时模式", "Realtime mode")} hint={t("新私信和 @ 你的消息几秒内就处理，不用等下一轮轮询。", "New DMs and messages that @-mention you are handled within seconds, without waiting for the next poll.")}>
          <Switch
            on={s.realtime}
            disabled={busy}
            onChange={(on) => {
              if (on) return setConfirmRealtime(true); // only after the confirmation below
              setConfirmRealtime(false);
              save("slack", { realtime: false }, t("实时模式已关，只按间隔轮询。", "Realtime mode is off: polling at the interval only."));
            }}
          />
        </Row>
        {confirmRealtime && (
          <div class="row row-confirm">
            <div>
              {t("实时模式连的是 ", "Realtime mode connects to ")}<strong>{t("Slack 网页版内部的 websocket", "the internal websocket of Slack's web app")}</strong>
              {t("，不是官方 API，Slack 一改版就可能失效。", ", not an official API, so it may break whenever Slack changes.")}
            </div>
            <div class="muted">
              {t("断线频繁、3 分钟连不上或登录失效时，自动回退到轮询，15 分钟后再试，并通知你一次。轮询一直在跑，不会漏消息。", "If it drops often, cannot connect for 3 minutes, or the sign-in expires, it falls back to polling, tries again 15 minutes later, and tells you once. Polling always runs, so no message is missed.")}
            </div>
            <div class="actions">
              <button class="primary" disabled={busy} onClick={() => { setConfirmRealtime(false); save("slack", { realtime: true }, t("实时模式已开，几秒内连上。", "Realtime mode is on: it connects in a few seconds.")); }}>
                {t("知道了，开启", "Got it, turn it on")}
              </button>
              <button onClick={() => setConfirmRealtime(false)}>{t("算了", "Never mind")}</button>
            </div>
          </div>
        )}
        <Row label={t("轮询间隔", "Polling interval")} hint={s.realtime ? t("实时开着时，轮询只是兜底，可以放长些。", "With realtime on, polling is only a backup, so it can be longer.") : t("没开实时时，靠它收消息。", "With realtime off, this is how messages come in.")}>
          <select value={s.pollMinutes ?? ""} disabled={busy} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; save("slack", { pollMinutes: v ? Number(v) : null }, t("轮询间隔已保存，马上生效。", "Polling interval saved: it takes effect now.")); }}>
            <option value="">{t(`默认（每 ${s.defaults.pollMinutes} 分钟）`, `Default (every ${s.defaults.pollMinutes} min)`)}</option>
            {POLL_CHOICES.map((m) => <option key={m} value={m}>{t(`每 ${m} 分钟`, `Every ${m} min`)}</option>)}
          </select>
        </Row>
      </Group>

      <Group title={t("同一对话的新消息", "Follow-ups in a conversation")} note={noteFor("merge")}>
        <Row label={t("同一个 thread", "Same thread")} hint={t("一个 thread 就是一个话题，默认不限时间。", "A thread is one topic, so by default there is no time limit.")}>
          <MergeSelect value={s.threadMergeHours} busy={busy} onPick={(h) => save("merge", { threadMergeHours: h }, t("已保存，下一条新消息生效。", "Saved: it takes effect from the next new message."))} />
        </Row>
        <Row label={t("同一个私信", "Same DM")} hint={t("私信不分话题，默认只并 2 小时内的。", "A DM has no topics, so by default only messages within 2 hours are merged.")}>
          <MergeSelect value={s.dmMergeHours} busy={busy} onPick={(h) => save("merge", { dmMergeHours: h }, t("已保存，下一条新消息生效。", "Saved: it takes effect from the next new message."))} />
        </Row>
        <div class="row row-foot">
          {t("上一个任务在这段时间里还有动静，新消息就并进去，接着原来的会话处理：agent 记得前面查过、起草过什么，一个对话只留一张审批卡。超过时间就开新任务。", "If the last task saw activity within this time, a new message joins it and carries on in the same session: the agent remembers what it looked up and drafted, and a conversation keeps a single approval card. After that, a new task starts.")}
        </div>
      </Group>

      <Group title={t("处理哪些消息", "Which messages")} note={noteFor("filter")}>
        <Row label={t("下班时间只收不处理", "Hold messages outside working hours")} hint={t("下班时间进来的 Slack 消息照样记下，到上班时间再处理。你自己在面板里的操作不受影响。", "Slack messages that come in outside working hours are still recorded, and handled once working hours start. What you do in the panel yourself is not affected.")}>
          <Switch
            on={s.workHours !== null}
            disabled={busy}
            onChange={(on) => save("filter", { workHours: on ? { start: 9, end: 20, weekends: false } : null }, on ? t("已打开：下班时间进来的消息，上班时间再处理。", "On: messages outside working hours wait until working hours.") : t("已关闭：随时处理。", "Off: messages are handled any time."))}
          />
        </Row>
        {s.workHours && (
          <>
            <Row label={t("上班时间", "Working hours")} hint={t("按这台电脑的时间。", "By this Mac's clock.")}>
              <select class="hour" value={s.workHours.start} disabled={busy} onChange={(e) => save("filter", { workHours: { ...s.workHours!, start: Number((e.target as HTMLSelectElement).value) } }, t("上班时间已保存。", "Start time saved."))}>
                {HOURS.slice(0, 24).map((h) => <option key={h} value={h}>{h}:00</option>)}
              </select>
              <span class="muted">{t("到", "to")}</span>
              <select class="hour" value={s.workHours.end} disabled={busy} onChange={(e) => save("filter", { workHours: { ...s.workHours!, end: Number((e.target as HTMLSelectElement).value) } }, t("下班时间已保存。", "End time saved."))}>
                {HOURS.slice(1).map((h) => <option key={h} value={h}>{h}:00</option>)}
              </select>
            </Row>
            <Row label={t("周末也处理", "Weekends too")} hint={t("关着时，周六、周日进来的消息等到周一上班再处理。", "When off, messages from Saturday and Sunday wait until working hours on Monday.")}>
              <Switch on={s.workHours.weekends} disabled={busy} onChange={(on) => save("filter", { workHours: { ...s.workHours!, weekends: on } }, on ? t("周末也处理。", "Weekends are handled too.") : t("周末只收不处理。", "Weekend messages are held."))} />
            </Row>
          </>
        )}
        <Row label={t("不处理这些人的消息", "Skip messages from")} hint={t("比如通知机器人、不用你回的人。", "Say, notification bots, or people you never need to reply to.")}>
          <SkipList ids={s.skipUsers} known={known.people} busy={busy} prefix="" onChange={(ids) => save("filter", { skipUsers: ids }, t("已保存，下一条新消息生效。", "Saved: it takes effect from the next new message."))} />
        </Row>
        <Row label={t("不处理这些频道里的 @", "Skip @-mentions in")} hint={t("比如 @ 全员的公告频道。", "Say, announcement channels that @-mention everyone.")}>
          <SkipList ids={s.skipChannels} known={known.channels} busy={busy} prefix="#" onChange={(ids) => save("filter", { skipChannels: ids }, t("已保存，下一条新消息生效。", "Saved: it takes effect from the next new message."))} />
        </Row>
        <div class="row row-foot">
          {t("跳过的消息照样记下，在「已结束」里能看到，点开后可以「仍然处理」。这些规则在启动 agent 之前就判断，不花钱。", "Skipped messages are still recorded: find them under Finished, open one and click Process anyway. These rules are checked before the agent starts, so they cost nothing.")}
        </div>
      </Group>

      <Group title={t("模型", "Model")} note={noteFor("model")}>
        <Row label={t("模型", "Model")} hint={t("派活和 Slack 任务共用，下一个任务生效。「默认」取工作区 profile.yaml 里的。", "Shared by assigned and Slack tasks; it takes effect from the next task. Default is the one in the workspace's profile.yaml.")}>
          <select value={s.model ?? ""} disabled={busy} onChange={(e) => save("model", { model: (e.target as HTMLSelectElement).value || null }, t("模型已保存，下一个任务生效。", "Model saved: it takes effect from the next task."))}>
            <option value="">{t(`默认（${s.defaults.model}）`, `Default (${s.defaults.model})`)}</option>
            {s.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Row>
        <Row label={t("思考强度", "Effort")} hint={t("effort：越高越仔细，也越慢、越贵。", "Higher is more careful, and also slower and more expensive.")}>
          <select value={s.effort ?? ""} disabled={busy} onChange={(e) => save("model", { effort: (e.target as HTMLSelectElement).value || null }, t("思考强度已保存，下一个任务生效。", "Effort saved: it takes effect from the next task."))}>
            <option value="">{t(`默认（${s.defaults.effort ?? "由模型决定"}）`, `Default (${s.defaults.effort ?? "set by the model"})`)}</option>
            {s.efforts.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Row>
      </Group>

      <Group title={t("通知", "Notifications")} note={noteFor("notify")}>
        <Row label={t("macOS 通知", "macOS notifications")} hint={t("有回复等你批、有事要你看、任务失败时弹系统通知。关掉后，诊断和实时连接出问题仍会提醒。", "A system notification when a reply waits for your approval, something needs you, or a task fails. When off, you are still told about diagnostics and realtime connection problems.")}>
          <Switch on={s.notifyMacos} disabled={busy} onChange={(on) => save("notify", { notifyMacos: on }, on ? t("macOS 通知已打开。", "macOS notifications are on.") : t("macOS 通知已关闭。", "macOS notifications are off."))} />
        </Row>
        <Row label={t("Slack 私信提醒", "Slack DM to yourself")} hint={t("同样的事给你自己发一条 Slack 私信，手机上也能看到；回复的草稿就在对话输入框里，点链接过去直接发出。", "The same events as a Slack DM to yourself, so you see them on your phone too. A reply's draft sits in the conversation's message box: follow the link and send it.")}>
          <Switch on={s.notifySlackDm} disabled={busy} onChange={(on) => save("notify", { notifySlackDm: on }, on ? t("Slack 私信提醒已打开。", "Slack DM to yourself is on.") : t("Slack 私信提醒已关闭。", "Slack DM to yourself is off."))} />
        </Row>
      </Group>

      <Group title={t("在 Claude Code 里继续", "Continue in Claude Code")} note={noteFor("continue")}>
        <Row
          label={t("打开方式", "Open in")}
          hint={s.continueIn === "terminal"
            ? t("在终端里从 sidekick 的会话分叉出一个新会话：上下文都在，sidekick 这边不受影响。", "Forks a new session from sidekick's in Terminal: all the context comes along, and sidekick's side is not affected.")
            : t("在 Claude 桌面 app 里打开 sidekick 的原会话（桌面 app 不能分叉）。之后它归你，这个任务再跑时 sidekick 另开一个会话。", "Opens sidekick's own session in the Claude desktop app (the desktop app cannot fork). It is yours from then on: when this task runs again, sidekick starts a new session.")}
        >
          <select value={s.continueIn} disabled={busy} onChange={(e) => save("continue", { continueIn: (e.target as HTMLSelectElement).value }, t("已保存。", "Saved."))}>
            <option value="terminal">{t("终端（分叉新会话）", "Terminal (fork)")}</option>
            <option value="desktop">{t("Claude 桌面 app", "Claude desktop app")}</option>
          </select>
        </Row>
      </Group>

      <Group title={t("工作区", "Workspace")} note={noteFor("root")}>
        <Row label={t("工作区目录", "Workspace folder")} hint={<code class="path">{s.root}</code>}>
          {!editingRoot && <button onClick={() => { setRoot(s.root); setEditingRoot(true); }}>{t("更改…", "Change…")}</button>}
        </Row>
        {editingRoot && (
          <div class="row row-edit">
            <input value={root} onInput={(e) => setRoot((e.target as HTMLInputElement).value)} />
            {isNative() && <button disabled={busy} onClick={choose}>{t("选择…", "Choose…")}</button>}
            <button class="primary" disabled={busy || !root.trim() || root === s.root} onClick={async () => { if (await save("root", { root }, t("已保存。", "Saved."))) setEditingRoot(false); }}>{t("保存", "Save")}</button>
            <button onClick={() => setEditingRoot(false)}>{t("取消", "Cancel")}</button>
          </div>
        )}
        {pendingRoot && <div class="row row-foot tone-warn">{t(`当前仍在用 ${s.runningRoot}，重启 daemon 后换成新目录。`, `Still using ${s.runningRoot}: the new folder takes over after you restart the daemon.`)}</div>}
        <div class="row row-foot">
          {t("agent 在这个目录里干活，读它的 CLAUDE.md、skill 和 ", "The agent works in this folder and reads its CLAUDE.md, skills and ")}<code>sidekick/profile.yaml</code>
          {t("。改了要重启 daemon。", ". A change needs a daemon restart.")}
        </div>
      </Group>

      <Doctor at={state?.doctor?.at} focus={focus === "doctor"} />

      <Group title={t("关于", "About")} note={noteFor("daemon")}>
        {state?.update && (
          <div ref={aboutRef}>
            <Row
              label={<span class="tone-good">{t(`有新版本 ${state.update.version}`, `New version ${state.update.version}`)}</span>}
              hint={<>
                {t("升级会退出菜单栏 app、换成新版再打开；正在跑的任务会重新排队。", "Upgrading quits the menu bar app, swaps in the new version and opens it again; running tasks are re-queued.")}
                {state.update.url && <> <a href="#" onClick={(e) => { e.preventDefault(); openLink(state.update!.url); }}>{t("看更新了什么", "See what's new")}</a></>}
              </>}
            >
              <button class="primary" onClick={() => { if (!native({ type: "upgrade" })) setUpgradeCmd(state.installCommand ?? ""); }}>{t("升级", "Upgrade")}</button>
            </Row>
            {upgradeCmd && <div class="row row-foot">{t("在终端里运行：", "Run this in Terminal:")}<pre class="code selectable">{upgradeCmd}</pre></div>}
          </div>
        )}
        <Row label="sidekick" hint={state?.version ? t(`版本 ${state.version}`, `Version ${state.version}`) : undefined}>
          <ConfirmButton
            label={t("重启 daemon", "Restart daemon")}
            confirmLabel={t("确认重启（正在跑的任务会重新排队）", "Confirm restart (running tasks are re-queued)")}
            onConfirm={() => post("daemon", "/api/daemon/restart", t("daemon 正在重启，几秒后自动重连。", "The daemon is restarting: the panel reconnects in a few seconds."))}
          />
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
      <h2>{firstRun ? t("开始用 sidekick", "Get started") : t("工作区要重新设置", "Set up the workspace again")}</h2>
      {firstRun ? (
        <div class="small">
          {t("sidekick 在你的 Mac 上常驻，处理私信你和 @ 你的 Slack 消息：查资料、起草回复，你批了才发。", "sidekick runs on your Mac and handles the Slack messages that DM or @-mention you: it looks things up and drafts replies, and nothing is sent until you approve.")}
        </div>
      ) : (
        <div class="error">{t("现在的工作区用不了：", "The current workspace cannot be used: ")}{setup.reason}</div>
      )}

      <h3>{t("选一个工作区", "Choose a workspace")}</h3>
      <div class="muted small">
        {t("agent 在这个文件夹里运行，能读里面的代码。建议选放代码仓库的上一级目录，也可以新建一个。sidekick 会在里面建 ", "The agent runs in this folder and can read the code in it. The folder that holds your code repositories works well, or make a new one. sidekick creates a ")}
        <code>sidekick/</code>
        {t(" 子目录，放配置、处理 Slack 的流程和你的分身；已经有的不会覆盖。", " folder in it for its settings, the Slack workflow and your persona; nothing already there is overwritten.")}
      </div>
      <div class="field">
        <input value={root} disabled={busy || Boolean(done)} onInput={(e) => setRoot((e.target as HTMLInputElement).value)} />
        {isNative() && <button disabled={busy || Boolean(done)} onClick={choose}>{t("选择…", "Choose…")}</button>}
      </div>
      <div class="actions">
        <button class="primary" disabled={busy || Boolean(done) || !root.trim()} onClick={submit}>{busy ? t("设置中…", "Setting up…") : t("用这个文件夹", "Use this folder")}</button>
      </div>
      {err && <div class="error">{err}</div>}
      {done && (
        <div class="ok small">
          {t(
            `工作区：${done.root}${done.created.length ? `，新建了 ${done.created.join("、")}` : "，用它已有的配置"}。daemon 正在重启，几秒后进入主界面。之后先去「✎ 分身」写几条。`,
            `Workspace: ${done.root}${done.created.length ? `, created ${done.created.join(", ")}` : ", using its existing settings"}. The daemon is restarting; the main view opens in a few seconds. Then go to ✎ Persona and write a few lines first.`,
          )}
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

  // The interface language comes with the state: the daemon resolves it (auto follows the Mac's).
  const loadState = () => api<State>("/api/state").then((s) => { if (s.lang) setLang(s.lang); setState(s); setOnline(true); setErr(""); }).catch((e) => {
    if (e instanceof ApiError && e.status === 401) { setAuthed(false); return; }
    setErr(String(e.message));
  });

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
    loadState();
    connect();
    return () => { stopRef.current?.(); clearTimeout(retry); };
  }, [authed]);

  if (!authed) return <TokenGate onDone={() => setAuthed(true)} />;

  const c = state?.counts ?? {};
  return (
    <div class="app">
      <header>
        <div class="brand">
          <span class={`dot ${online ? "on" : "off"}`} title={online ? t("已连接 daemon", "Connected to the daemon") : t("连不上 daemon", "Cannot reach the daemon")} />sidekick<span class="muted small">{state?.profile}</span>
          <span class="right head-tools">
            {isNative() && <button class="link" title={t("在独立窗口中打开", "Open in a separate window")} onClick={() => native({ type: "openWindow" })}>{t("⧉ 窗口", "⧉ Window")}</button>}
            {!state?.setup && <button class="link" onClick={() => { setPersonaOpen(true); setSettingsOpen(false); setSelected(null); }}>{t("✎ 分身", "✎ Persona")}</button>}
            {!state?.setup && <button class="link" onClick={() => { setSettingsOpen("top"); setPersonaOpen(false); setSelected(null); }}>{t("⚙︎ 设置", "⚙︎ Settings")}</button>}
          </span>
        </div>
        {!state?.setup && <div class="chips">
          {state?.mode === "full" && (
            <span class="chip bad" title={t("agent 的回复会直接发出，不经你确认", "The agent's replies go out directly, without your approval")}>
              {t(`全托管中${state.modeUntil ? `（到 ${clock(state.modeUntil)}）` : ""}`, `Full auto${state.modeUntil ? ` until ${clock(state.modeUntil)}` : ""}`)}
            </span>
          )}
          {state?.slack?.enabled && (() => {
            const chip = realtimeChip(state.slack.realtime);
            return <span class={`chip ${chip.tone}`} title={chip.title}>{chip.text}</span>;
          })()}
          {state?.doctor && state.doctor.fail + state.doctor.warn > 0 && (
            <button class={`chip ${state.doctor.fail ? "bad" : "warn"}`} title={t("打开诊断看怎么修", "Open diagnostics to see how to fix it")} onClick={() => { setSettingsOpen("doctor"); setPersonaOpen(false); setSelected(null); }}>
              {state.doctor.fail
                ? t(`诊断：${state.doctor.fail} 项异常`, `Diagnostics: ${state.doctor.fail} failing`)
                : t(`诊断：${state.doctor.warn} 项需注意`, `Diagnostics: ${state.doctor.warn} to check`)}
            </button>
          )}
          {state?.update && (
            <button class="chip good" title={t("打开设置里的「关于」升级", "Open About in Settings to upgrade")} onClick={() => { setSettingsOpen("about"); setPersonaOpen(false); setSelected(null); }}>
              {t(`新版本 ${state.update.version}`, `New version ${state.update.version}`)}
            </button>
          )}
          <span class={`chip ${state?.pendingApprovals ? "warn" : ""}`}>{t("待审批", "To approve")} {state?.pendingApprovals ?? 0}</span>
          <span class="chip">{t("运行中", "Running")} {c.running ?? 0}</span>
          <span class="chip muted" title={t("今天所有运行的花费（按 API 价折算）", "What all of today's runs cost (at API prices)")}>{t("今日", "Today")} {money(state?.costToday) || "$0"}</span>
        </div>}
      </header>
      {err && <div class="error pad">{err}</div>}
      {state?.setup ? (
        <Setup setup={state.setup} doctorAt={state.doctor?.at} />
      ) : personaOpen ? (
        <Persona onBack={() => setPersonaOpen(false)} />
      ) : settingsOpen ? (
        <Settings key={settingsOpen} state={state} focus={settingsOpen} onBack={() => { setSettingsOpen(false); setTick((n) => n + 1); }} onLangChanged={loadState} />
      ) : selected ? (
        <TaskDetail id={selected} tick={tick} onBack={() => setSelected(null)} />
      ) : (
        <>
          <GettingStarted doctorAt={state?.doctor?.at} onPersona={() => setPersonaOpen(true)} />
          <Dispatch onSent={(id) => { setSelected(id); setTick((n) => n + 1); }} />
          <nav class="tabs">
            {tabs().map((x) => (
              <button key={x.id} class={tab === x.id ? "active" : ""} onClick={() => setTab(x.id)}>
                {x.label}{x.id === "attention" && state?.attention ? <span class="badge">{state.attention}</span> : null}
              </button>
            ))}
          </nav>
          <TaskList tab={tab} tick={tick} onOpen={setSelected} />
        </>
      )}
      {!isNative() && <footer class="muted small">{t("在浏览器里打开。接管会话需要菜单栏 app，这里只显示命令。", "Opened in a browser. Taking over a session needs the menu bar app; here you only get the command.")}</footer>}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
