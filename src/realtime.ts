// Whether to run the real-time Slack socket, and when to give up on it.
//
// The socket is Slack web's own websocket, not an official API: it can stop working whenever Slack
// ships a new web build. So it is opt-in (settings.realtime), polling never stops, and when the
// socket misbehaves the daemon drops back to polling only and tries the socket again later.

import { t } from "./i18n.ts";
import { startListener, type Listener, type ListenerOptions, type ListenerStatus } from "./listener.ts";
import { clip, log } from "./util.ts";

export const POLICY = {
  /** This many drops of an established connection within dropWindowMs → fall back. */
  drops: 3,
  dropWindowMs: 10 * 60_000,
  /** Not connected for this long (since start, or since the last drop) → fall back. */
  connectMs: 3 * 60_000,
  /** How long to stay on polling only before trying the socket again. */
  retryMs: 15 * 60_000,
  /** Connected this long → the next fallback is a new episode and is announced again. */
  stableMs: 10 * 60_000,
};
export type Policy = typeof POLICY;

export type RealtimeView =
  | { state: "off" }
  | { state: "connecting"; since: number; error?: string }
  | { state: "connected"; since: number }
  /** reason is display text in the language of the moment; fatal says which problem it was, for code. */
  | { state: "fallback"; since: number; reason: string; retryAt: number; fatal?: Fatal };

/** Everything the panel shows about Slack: the socket, and the polling that always runs. */
export interface SlackStatus {
  enabled: boolean;
  realtime: RealtimeView;
  pollMinutes: number;
  /** A collect is running since then (one takes ~18 s of Slack time). */
  collectingSince: number | null;
  /** The last finished collect. */
  lastCollect: { at: number; ms: number; added: number; error?: string } | null;
  nextCollectAt: number | null;
}

export interface Health {
  connectedSince: number | null;
  /** Since when the socket has not been connected (start, or the last drop); null while connected. */
  downSince: number | null;
  /** When established connections dropped. */
  drops: number[];
  lastError: string;
  /** A problem reconnecting will not fix. */
  fatal: Fatal | null;
}

export const freshHealth = (now: number): Health => ({ connectedSince: null, downSince: now, drops: [], lastError: "", fatal: null });

/** Problems reconnecting will not fix. */
export type Fatal = "login_expired" | "force_reload";

/** How a fatal problem is put in the interface. */
export function fatalText(f: Fatal): string {
  return f === "login_expired"
    ? t("Slack 登录失效", "Slack sign-in expired")
    : t("Slack 不再接受 slackcli 用的网页版版本（force_reload）", "Slack no longer accepts the web app version slackcli uses (force_reload)");
}

/** Errors that reconnecting will not fix. */
export function fatalReason(s: ListenerStatus): Fatal | null {
  if (s.type === "hello") return null;
  if (s.type === "exit" && s.code === 2) return "login_expired";
  if (/force_reload/.test(s.error)) return "force_reload";
  return null;
}

/** Fold one status line into the health record. */
export function observe(h: Health, s: ListenerStatus, now: number): Health {
  if (s.type === "hello") return { ...h, connectedSince: now, downSince: null, lastError: "" };
  return {
    connectedSince: null,
    downSince: h.downSince ?? now,
    // Only a connection that was up counts as a drop; failed attempts count toward connectMs instead,
    // so a short network blip (listen retries after 1 s, 2 s, 4 s…) does not trip the fallback.
    drops: h.connectedSince !== null ? [...h.drops, now] : h.drops,
    lastError: s.error ? clip(s.error, 160) : h.lastError,
    fatal: h.fatal ?? fatalReason(s),
  };
}

/** Why the socket should be given up on right now, or null while it is healthy enough. */
export function fallbackReason(h: Health, now: number, p: Policy = POLICY): string | null {
  if (h.fatal) return fatalText(h.fatal);
  const recent = h.drops.filter((d) => now - d < p.dropWindowMs).length;
  const window = p.dropWindowMs / 60_000;
  if (recent >= p.drops) return t(`${window} 分钟内断了 ${recent} 次`, `Dropped ${recent} times in ${window} min`);
  if (h.downSince !== null && now - h.downSince >= p.connectMs) {
    const mins = p.connectMs / 60_000;
    return t(`${mins} 分钟没连上${h.lastError ? `（${h.lastError}）` : ""}`, `Not connected for ${mins} min${h.lastError ? ` (${h.lastError})` : ""}`);
  }
  return null;
}

export interface RealtimeOptions {
  me: () => string;
  onCollect: (reason: string) => void;
  /** I posted a message (in this channel). */
  onMine?: (channel: string) => void;
  /** The socket was given up on. Once per episode, not on every failed retry. */
  onFallback: (reason: string) => void;
  /** For tests. */
  start?: (opts: ListenerOptions) => Listener;
  now?: () => number;
  policy?: Policy;
}

export class Realtime {
  private listener: Listener | null = null;
  private health: Health = freshHealth(0);
  private current: RealtimeView = { state: "off" };
  private announced = false;
  private readonly policy: Policy;
  private readonly now: () => number;

  constructor(private readonly o: RealtimeOptions) {
    this.policy = o.policy ?? POLICY;
    this.now = o.now ?? Date.now;
  }

  view(): RealtimeView {
    return this.current;
  }

  /** Call on every daemon tick and right after the settings change. */
  update(enabled: boolean): void {
    const now = this.now();
    if (!enabled) {
      if (this.current.state !== "off") log("realtime: off, polling only");
      this.stopListener();
      this.current = { state: "off" };
      this.announced = false;
      return;
    }
    if (this.current.state === "fallback") {
      if (now < this.current.retryAt) return;
      log("realtime: trying the socket again");
    }
    if (!this.listener) this.begin(now);
    this.evaluate(now);
  }

  /** The panel's "retry now". */
  retryNow(): void {
    if (this.current.state === "fallback") this.current = { ...this.current, retryAt: this.now() };
    this.update(true);
  }

  stop(): void {
    this.stopListener();
  }

  private begin(now: number): void {
    this.health = freshHealth(now);
    this.current = { state: "connecting", since: now };
    const listener = (this.o.start ?? startListener)({
      me: this.o.me,
      onCollect: this.o.onCollect,
      onMine: this.o.onMine,
      onStatus: (s) => {
        if (this.listener === listener) this.onStatus(s); // ignore a stopped listener's last words
      },
    });
    this.listener = listener;
  }

  private onStatus(s: ListenerStatus): void {
    const now = this.now();
    this.health = observe(this.health, s, now);
    this.current = s.type === "hello"
      ? { state: "connected", since: now }
      : { state: "connecting", since: this.health.downSince ?? now, ...(this.health.lastError ? { error: this.health.lastError } : {}) };
    this.evaluate(now);
  }

  private evaluate(now: number): void {
    if (this.current.state === "connected" && now - this.current.since >= this.policy.stableMs) this.announced = false;
    const reason = fallbackReason(this.health, now, this.policy);
    if (!reason) return;
    this.stopListener();
    this.current = { state: "fallback", since: now, reason, retryAt: now + this.policy.retryMs, ...(this.health.fatal ? { fatal: this.health.fatal } : {}) };
    log(`realtime: falling back to polling: ${reason}`);
    if (!this.announced) {
      this.announced = true;
      this.o.onFallback(reason);
    }
  }

  private stopListener(): void {
    const l = this.listener;
    this.listener = null;
    l?.stop();
  }
}
