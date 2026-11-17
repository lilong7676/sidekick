#!/usr/bin/env bun
// sidekick command line. The daemon does the work; these commands look at the ledger and decide.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decide } from "./approvals.ts";
import { loadProfiles, pickProfile, type Profile } from "./config.ts";
import { getTask, OPEN_STATUSES, openDb, type ApprovalRow, type EventRow, type RunRow, type TaskRow } from "./db.ts";
import { runDaemon, runSetup } from "./daemon.ts";
import { DAEMON_LOG_DIR, runDoctor } from "./doctor.ts";
import { runGuard } from "./guard.ts";
import { serveMcp } from "./mcp.ts";
import { addManualTask, cancel, deleteTask, handback, takeover } from "./queries.ts";
import { shellQuote } from "./runner.ts";
import { collectSlack } from "./slack.ts";
import { intakeSlack } from "./intake.ts";
import { startTaskRun } from "./handle.ts";
import { clip, log, setLogDir, VERSION } from "./util.ts";
import { setLang, t } from "./i18n.ts";
import { uiLang } from "./settings.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
setLang(uiLang());

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const has = (name: string) => argv.includes(`--${name}`);
const positional = (i: number) => argv.filter((a, k) => k > 0 && !a.startsWith("--") && !argv[k - 1]?.startsWith("--"))[i];

function ctx(): { profile: Profile; db: ReturnType<typeof openDb> } {
  const profile = pickProfile(loadProfiles(), flag("profile"));
  setLogDir(join(profile.stateDir, "logs"));
  process.env.SIDEKICK_LOG_STDERR = "1";
  return { profile, db: openDb(profile.stateDir) };
}

const time = (ms: number | null) => (ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "—");

function printTasks(rows: TaskRow[]): void {
  if (rows.length === 0) return console.log(t("（没有）", "(none)"));
  for (const r of rows) console.log(`${r.id}  ${r.status.padEnd(14)} ${time(r.updated_at)}  ${r.title}`);
}

const help = () => t(`sidekick — 本机的 agent 调度器

  sidekick daemon [--no-slack]         常驻：采集 → 建任务 → 处理 → 审批执行 → 通知，并提供本机 API 和网页（--no-slack 完全不碰 Slack，测试用）
  sidekick tick                        只跑一次采集，把新消息建成任务
  sidekick add "<要做的事>"             手动派活
  sidekick run <task>                  前台跑一次这个任务（调试用）
  sidekick tasks [--all]               未结束的任务（--all 含最近结束的）
  sidekick task <task>                 任务详情：事件、每轮运行、审批
  sidekick approvals                   待审批
  sidekick approve <id> [--note 文字] [--text-file 文件]   批准（可改写回复正文）
  sidekick deny <id> [--note 意见]     拒绝；带意见会让 agent 按意见重做
  sidekick takeover <task>             暂停任务，打印在终端接管会话的命令
  sidekick handback <task> [--message 文字]   交还给 daemon 继续
  sidekick cancel <task>               取消；正在跑的会立刻停掉
  sidekick delete <task>               删除任务记录（运行、日志、审批卡、Slack 里的草稿）
  sidekick doctor                      体检：每一项不通过都给出修法（菜单栏面板 → 设置 → 诊断 是同一套）
  sidekick --version                   版本号
  全局：--profile <名字>`, `sidekick — a local agent dispatcher

  sidekick daemon [--no-slack]         Run in the background: collect → create tasks → process → carry out approvals → notify, and serve the local API and panel (--no-slack never touches Slack, for testing)
  sidekick tick                        Collect once and turn new messages into tasks
  sidekick add "<what to do>"          Assign a task by hand
  sidekick run <task>                  Run this task once in the foreground (for debugging)
  sidekick tasks [--all]               Unfinished tasks (--all adds recently finished ones)
  sidekick task <task>                 Task details: events, each run, approvals
  sidekick approvals                   Waiting for approval
  sidekick approve <id> [--note text] [--text-file file]   Approve (optionally rewriting the reply)
  sidekick deny <id> [--note feedback]   Deny; with feedback the agent redoes it accordingly
  sidekick takeover <task>             Pause the task and print the command to take over its session in a terminal
  sidekick handback <task> [--message text]   Hand back to the daemon to continue
  sidekick cancel <task>               Cancel; a running run is stopped at once
  sidekick delete <task>               Delete the task record (runs, logs, approval cards, the draft in Slack)
  sidekick doctor                      Diagnostics: every failing check says how to fix it (same as menu bar panel → Settings → Diagnostics)
  sidekick --version                   Version
  Global: --profile <name>`);

async function main(): Promise<void> {
  switch (cmd) {
    case "--version":
    case "-v":
      return console.log(VERSION);

    case "mcp":
      return serveMcp();

    case "guard":
      return runGuard(flag("policy") ?? "");

    case "daemon":
      // Until a profile is loaded (and if it never is), log where `sidekick doctor` points.
      setLogDir(DAEMON_LOG_DIR);
      let profiles: Profile[];
      try {
        profiles = loadProfiles();
      } catch (e) {
        // First run (no workspace yet) or a broken profile: wait in the panel instead of crash-looping.
        return void (await runSetup(String((e as Error).message ?? e)));
      }
      return void (await runDaemon(profiles, { noSlack: has("no-slack") }));

    case "tick": {
      const { profile, db } = ctx();
      const added = await collectSlack(profile, db);
      const created = intakeSlack(db);
      console.log(t(`采集：新增 ${added} 条`, `Collect: ${added} new`));
      console.log(t(`建任务：${created} 个，daemon 下一轮开始处理`, `Tasks created: ${created}; the daemon starts on them next round`));
      return;
    }

    case "add": {
      const { db } = ctx();
      const text = positional(0);
      if (!text) throw new Error(t('用法：sidekick add "<要做的事>"', 'Usage: sidekick add "<what to do>"'));
      const id = addManualTask(db, text);
      console.log(t(`已派活 ${id}，daemon 会在下一轮开始处理。`, `Assigned ${id}; the daemon starts on it next round.`));
      return;
    }

    case "run": {
      const { profile, db } = ctx();
      const task = getTask(db, positional(0) ?? "");
      if (!task) throw new Error(t("没有这个任务", "No such task"));
      if (task.status === "running") throw new Error(t("任务正在跑", "The task is running"));
      await new Promise<void>((resolve) => {
        startTaskRun(profile, db, task, () => resolve()).then((h) => { if (!h) resolve(); });
      });
      const after = getTask(db, task.id)!;
      console.log(`${after.id} → ${after.status}${after.summary ? `\n${after.summary}` : ""}`);
      return;
    }

    case "tasks": {
      const { db } = ctx();
      const rows = has("all")
        ? (db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 50").all() as TaskRow[])
        : (db.prepare(`SELECT * FROM tasks WHERE status IN (${OPEN_STATUSES.map(() => "?").join(",")}) ORDER BY updated_at DESC`).all(...OPEN_STATUSES) as TaskRow[]);
      return printTasks(rows);
    }

    case "task": {
      const { db } = ctx();
      const k = getTask(db, positional(0) ?? "");
      if (!k) throw new Error(t("没有这个任务", "No such task"));
      console.log(`${k.id}  ${k.status}  ${k.title}\n${t(
        `来源 ${k.source}/${k.kind}  会话 ${k.session_id ?? "—"}  创建 ${time(k.created_at)}`,
        `Source ${k.source}/${k.kind}  Session ${k.session_id ?? "—"}  Created ${time(k.created_at)}`,
      )}`);
      if (k.summary) console.log(`\n${t(`结论（${k.outcome ?? "—"}）：`, `Conclusion (${k.outcome ?? "—"}): `)}${k.summary}`);
      if (k.next_prompt) console.log(`\n${t("下一轮会带上：", "Next run brings: ")}${k.next_prompt}`);
      const evs = db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id").all(k.id) as EventRow[];
      for (const e of evs) console.log(`\n${t("事件", "Event")} ${e.id} [${e.kind}] ${e.user_name ?? "?"} @ ${e.channel_name ?? e.channel}${t("：", ": ")}${clip(e.text, 300)}`);
      const runs = db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at").all(k.id) as RunRow[];
      for (const r of runs) {
        const err = r.error ? ` ${t("错误", "error")}=${r.error}` : "";
        console.log(`\n${t("运行", "Run")} ${r.id} ${time(r.started_at)} → ${time(r.ended_at)} exit=${r.exit_code ?? "—"} $${r.cost_usd?.toFixed(3) ?? "—"} ${t("轮数", "turns")}=${r.turns ?? "—"}${err}\n  ${t("日志", "Log")} ${r.log_path}`);
      }
      const aps = db.prepare("SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at").all(k.id) as ApprovalRow[];
      for (const a of aps) console.log(`\n${t("审批", "Approval")} ${a.id} [${a.kind}] ${a.status}${a.result ? ` (${a.result})` : ""}\n  ${clip(a.payload, 400)}`);
      return;
    }

    case "approvals": {
      const { db } = ctx();
      const rows = db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").all() as ApprovalRow[];
      if (rows.length === 0) return console.log(t("没有待审批的。", "Nothing to approve."));
      for (const a of rows) {
        const task = getTask(db, a.task_id);
        const p = JSON.parse(a.payload);
        console.log(`\n${a.id}  [${a.kind}]  ${time(a.created_at)}  ${t(`任务 ${a.task_id}：`, `Task ${a.task_id}: `)}${task?.title ?? ""}`);
        if (a.kind === "outbound") {
          const head = p.threadTs ? t("回复（thread 里）：", "Reply (in thread):") : t("回复（直接）：", "Reply (direct):");
          const body = String(p.text).split("\n").map((l: string) => `    ${l}`).join("\n");
          const reason = p.reason ? `\n  ${t("理由：", "Reason: ")}${p.reason}` : "";
          const draft = p.draftId ? `\n  ${t("Slack 输入框里已有草稿，也可以在 Slack 里自己改了发。", "The draft is already in the Slack message box; you can also edit and send it in Slack yourself.")}` : "";
          console.log(`  ${head}\n${body}${reason}${draft}`);
        } else console.log(`  ${t("要执行：", "To run: ")}${p.tool_name} ${clip(JSON.stringify(p.input), 300)}`);
      }
      return;
    }

    case "approve":
    case "deny": {
      const { db } = ctx();
      const id = positional(0);
      if (!id) throw new Error(t(`用法：sidekick ${cmd} <审批 id>`, `Usage: sidekick ${cmd} <approval id>`));
      const file = flag("text-file");
      const a = decide(db, id, cmd === "approve" ? "approved" : "denied", flag("note"), file ? readFileSync(file, "utf8") : undefined);
      console.log(t(`${a.id} → ${a.status}。daemon 下一轮执行。`, `${a.id} → ${a.status}. The daemon carries it out next round.`));
      return;
    }

    case "takeover": {
      const { profile, db } = ctx();
      const id = positional(0) ?? "";
      const { cwd, command } = takeover(profile, db, id);
      const line = `cd ${shellQuote(cwd)} && ${command}`;
      console.log(t(
        `任务 ${id} 已暂停。在终端里运行：\n\n${line}\n\n聊完退出后，运行 sidekick handback ${id} 交还。`,
        `Task ${id} is paused. Run this in a terminal:\n\n${line}\n\nWhen you are done and have quit, run sidekick handback ${id} to hand it back.`,
      ));
      return;
    }

    case "handback": {
      const { db } = ctx();
      const id = positional(0) ?? "";
      handback(db, id, flag("message"));
      console.log(t(`${id} 已交还，daemon 下一轮继续。`, `${id} handed back; the daemon continues next round.`));
      return;
    }

    case "cancel": {
      const { db } = ctx();
      const id = positional(0) ?? "";
      const { stopped, closed } = await cancel(db, id);
      console.log(t(
        `${id} 已取消${stopped ? `，停掉了 ${stopped} 个正在跑的进程` : ""}${closed ? `，关掉了 ${closed} 张待审批的卡` : ""}。`,
        `${id} cancelled${stopped ? `; stopped ${stopped} running process${stopped === 1 ? "" : "es"}` : ""}${closed ? `; closed ${closed} pending approval card${closed === 1 ? "" : "s"}` : ""}.`,
      ));
      return;
    }

    case "delete": {
      const { db } = ctx();
      const id = positional(0) ?? "";
      await deleteTask(db, id);
      console.log(t(`${id} 的记录已删除。`, `Record of ${id} deleted.`));
      return;
    }

    case "doctor": {
      let profile: Profile | null = null;
      let profileError: string | undefined;
      let db: ReturnType<typeof openDb> | null = null;
      try {
        profile = pickProfile(loadProfiles(), flag("profile"));
        db = openDb(profile.stateDir);
      } catch (e) {
        profileError = String((e as Error).message ?? e);
      }
      const report = await runDoctor({ profile, profileError, db });
      const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
      for (const c of report.checks) {
        console.log(`${icon[c.status]} ${c.name}${t("：", ": ")}${c.detail}`);
        if (c.status !== "ok" && c.fix) console.log(`    → ${c.fix}`);
        if (c.status !== "ok" && c.command) console.log(`    $ ${c.command}`);
      }
      if (report.checks.some((c) => c.status === "fail")) process.exitCode = 1;
      return;
    }

    default:
      console.log(help());
  }
}

main().catch((e) => {
  if (cmd === "daemon") log(`daemon: failed to start: ${String((e as Error).stack ?? e).slice(0, 1000)}`);
  console.error(String((e as Error).message ?? e));
  process.exit(1);
});
