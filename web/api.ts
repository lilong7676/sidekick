// Talking to the daemon. The token comes from the menu bar app (injected before the page loads);
// in a plain browser it can be pasted once and is kept for this tab only.

import type { Lang } from "../src/i18n.ts";

declare global {
  interface Window {
    SIDEKICK_TOKEN?: string;
    webkit?: {
      messageHandlers?: {
        sidekick?: { postMessage: (msg: unknown) => void };
        /** Same bridge, for questions with an answer (WKScriptMessageHandlerWithReply). */
        sidekickAsk?: { postMessage: (msg: unknown) => Promise<unknown> };
      };
    };
  }
}

const TOKEN_KEY = "sidekick-token";

export function token(): string | null {
  if (window.SIDEKICK_TOKEN) return window.SIDEKICK_TOKEN;
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, t.trim());
  } catch {
    // private mode: the page simply asks again
  }
}

export const isNative = () => Boolean(window.webkit?.messageHandlers?.sidekick);

/** Ask the menu bar app to do what a web page cannot (open Terminal, open a link in Slack). */
export function native(msg:
  | { type: "takeover"; cwd: string; args: string[] }
  | { type: "continue"; cwd: string; session: string; name: string }
  | { type: "open"; url: string }
  | { type: "refreshBadge" }
  | { type: "openWindow" }
  | { type: "upgrade" }): boolean {
  const h = window.webkit?.messageHandlers?.sidekick;
  if (!h) return false;
  h.postMessage(msg);
  return true;
}

/** The menu bar app's own checks (notification permission, where it is installed, login item). */
export async function appChecks(): Promise<Check[]> {
  const h = window.webkit?.messageHandlers?.sidekickAsk;
  if (!h) return [];
  try {
    const r = await h.postMessage({ type: "appChecks" });
    return Array.isArray(r) ? (r as Check[]) : [];
  } catch {
    return [];
  }
}

/** Native folder picker (the page cannot learn a folder's path itself). null: cancelled or not in the app. */
export async function pickFolder(): Promise<string | null> {
  const h = window.webkit?.messageHandlers?.sidekickAsk;
  if (!h) return null;
  try {
    const r = await h.postMessage({ type: "pickFolder" });
    return typeof r === "string" ? r : null;
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token() ?? ""}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/** Server-sent events over fetch (EventSource cannot send the auth header). Returns a stop function. */
export function subscribe(path: string, onEvent: (event: string, data: any) => void, onEnd?: () => void): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(path, { headers: { Authorization: `Bearer ${token() ?? ""}` }, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) onEvent(event, JSON.parse(data));
        }
      }
    } catch {
      // aborted or the daemon went away; the caller resubscribes
    }
    if (!ctrl.signal.aborted) onEnd?.();
  })();
  return () => ctrl.abort();
}

// ---- types mirrored from the daemon (src/queries.ts) ---------------------------------------------------

export type Status = "queued" | "running" | "needs_approval" | "needs_me" | "paused" | "done" | "closed" | "failed" | "cancelled";

export interface Task {
  id: string; source: string; kind: string; title: string; status: Status;
  session_id: string | null; next_prompt: string | null; outcome: string | null; summary: string | null;
  created_at: number; updated_at: number; cost_usd?: number; pending_approvals?: number; messages?: number; link: string | null;
  /** Held until working hours (src/intake.ts). */
  not_before?: number | null;
}

export interface Approval {
  id: string; task_id: string; run_id: string | null; kind: "tool" | "outbound"; status: string;
  payload: Record<string, any>; decision_note: string | null; created_at: number; decided_at: number | null;
  result: string | null; task_title: string | null;
}

export interface Run {
  id: string; task_id: string; session_id: string | null; started_at: number; ended_at: number | null;
  exit_code: number | null; cost_usd: number | null; turns: number | null; error: string | null;
}

export interface EventRow {
  id: number; kind: string; channel_name: string | null; user_name: string | null; text: string | null;
  received_at: number;
}

export interface Detail { task: Task; events: EventRow[]; runs: Run[]; approvals: Approval[] }

export type RealtimeView =
  | { state: "off" }
  | { state: "connecting"; since: number; error?: string }
  | { state: "connected"; since: number }
  | { state: "fallback"; since: number; reason: string; retryAt: number };

export interface SlackStatus {
  enabled: boolean; realtime: RealtimeView; pollMinutes: number;
  collectingSince: number | null;
  lastCollect: { at: number; ms: number; added: number; error?: string } | null;
  nextCollectAt: number | null;
}

export interface Check { id: string; name: string; status: "ok" | "warn" | "fail"; detail: string; fix?: string; command?: string }
export interface DoctorReport { at: number; checks: Check[] }

export interface State {
  profile: string; counts: Partial<Record<Status, number>>; pendingApprovals: number; costToday: number; attention: number;
  version?: string;
  /** The interface language the daemon resolved (src/i18n.ts). */
  lang?: Lang;
  /** A newer Sidekick on GitHub Releases (src/update.ts). */
  update?: { version: string; url: string } | null;
  /** The one-line install, which is also how to upgrade. */
  installCommand?: string;
  mode?: "semi" | "full";
  /** In full mode by timetable: when that window ends. */
  modeUntil?: number | null;
  slack?: SlackStatus | null;
  doctor?: { at: number; fail: number; warn: number } | null;
  /** Present while the daemon has no workspace yet. */
  setup?: { reason: string; suggestedRoot: string };
}

export type LogItem =
  | { kind: "init"; model?: string; session?: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: string; id?: string }
  | { kind: "tool_result"; text: string; error: boolean; id?: string }
  | { kind: "result"; text: string; cost?: number; turns?: number; error: boolean; denials: number }
  | { kind: "stderr"; text: string };

/**
 * Copy text from inside a click. execCommand first: it runs synchronously, so it keeps the click's
 * permission where the async clipboard is denied (seen in an embedded browser pane, and WebKit only
 * honours it inside the gesture). The async API is the fallback. False: show the text to copy by hand.
 */
export async function copyText(text: string): Promise<boolean> {
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  prev?.focus();
  if (ok) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Signing in to Slack from the panel (src/slacklogin.ts). */
export interface LoginJob { state: "idle" | "running" | "ok" | "failed"; startedAt: number | null; message: string }
