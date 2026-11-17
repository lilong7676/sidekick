// Real-time Slack: keep `slackcli listen` running and turn its events into "collect now".
//
// The socket only says something happened; what to pick up is still decided by collectSlack
// (unread DMs and @me), so there is one code path for what becomes a task. Polling stays as the
// fallback for when the socket is down. Whether to run the socket at all is realtime.ts's call.

import { cleanEnv, log, SLACKCLI } from "./util.ts";

export interface ListenLine {
  type: string;
  channel_id?: string;
  user?: string;
  bot_id?: string;
  is_dm?: boolean;
  mentions_me?: boolean;
  changed?: boolean;
  error?: string;
  user_id?: string;
}

/**
 * Whether a socket line should trigger a collect: someone else's new message that is a DM to
 * me or @-mentions me, or a fresh connection after a drop (catch up on what was missed).
 */
export function shouldCollect(line: ListenLine, me: string, state: { droppedSinceHello: boolean }): boolean {
  if (line.type === "disconnected") {
    state.droppedSinceHello = true;
    return false;
  }
  if (line.type === "hello") {
    const catchUp = state.droppedSinceHello;
    state.droppedSinceHello = false;
    return catchUp;
  }
  if (line.type !== "message" || line.changed || line.bot_id) return false;
  if (!line.user || line.user === me) return false;
  return Boolean(line.is_dm || line.mentions_me);
}

/** My own new message: maybe a reply sidekick drafted, sent from Slack (approvals.ts reconcileDrafts). */
export function isMyMessage(line: ListenLine, me: string): boolean {
  return line.type === "message" && !line.changed && !line.bot_id && Boolean(me) && line.user === me && Boolean(line.channel_id);
}

/** What the connection did, for realtime.ts to judge its health. */
export type ListenerStatus =
  | { type: "hello" }
  | { type: "disconnected"; error: string }
  /** `slackcli listen` itself ended; code 2 means Slack refused the login. */
  | { type: "exit"; code: number | null; error: string };

export interface Listener { stop: () => void }

export interface ListenerOptions {
  me: () => string;
  /** Fires (debounced) when a line calls for a collect. */
  onCollect: (reason: string) => void;
  /** Fires on each message I post, with its channel. */
  onMine?: (channel: string) => void;
  onStatus: (status: ListenerStatus) => void;
  debounceMs?: number;
}

/** Spawn `slackcli listen` and keep it running until stopped (listen reconnects by itself). */
export function startListener(opts: ListenerOptions): Listener {
  let stopped = false;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const state = { droppedSinceHello: false };

  const trigger = (reason: string) => {
    if (timer) return; // one collect per burst
    timer = setTimeout(() => {
      timer = null;
      opts.onCollect(reason);
    }, opts.debounceMs ?? 2_000);
  };

  const run = async () => {
    while (!stopped) {
      const started = Date.now();
      proc = Bun.spawn([SLACKCLI, "listen"], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: cleanEnv({ SLACKCLI_NO_UPDATE_NOTIFIER: "1", SLACKCLI_LOG_LEVEL: "warning" }),
      });
      log(`listener: slackcli listen started (pid ${proc.pid})`);
      let buf = "";
      const dec = new TextDecoder();
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let line: ListenLine;
          try {
            line = JSON.parse(raw);
          } catch {
            continue;
          }
          if (line.type === "hello") {
            log("listener: connected");
            opts.onStatus({ type: "hello" });
          }
          if (line.type === "disconnected") {
            log(`listener: disconnected: ${String(line.error ?? "").slice(0, 200)}`);
            opts.onStatus({ type: "disconnected", error: String(line.error ?? "") });
          }
          if (shouldCollect(line, opts.me(), state)) trigger(line.type === "hello" ? "reconnected" : "new message");
          if (isMyMessage(line, opts.me())) opts.onMine?.(line.channel_id!);
        }
      }
      const code = await proc.exited;
      if (stopped) break;
      const err = (await new Response(proc.stderr as ReadableStream).text()).trim().slice(-300);
      log(`listener: slackcli listen exited ${code}${err ? `: ${err}` : ""}`);
      opts.onStatus({ type: "exit", code, error: err });
      if (stopped) break; // realtime.ts gave up on the socket
      await Bun.sleep(Date.now() - started < 60_000 ? 30_000 : 5_000);
    }
  };
  run().catch((e) => log(`listener: crashed: ${String(e).slice(0, 300)}`));

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      proc?.kill("SIGTERM");
    },
  };
}
