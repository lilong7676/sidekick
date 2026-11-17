import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemPrompt } from "../src/handle.ts";
import { openDb } from "../src/db.ts";
import { isSafeRelative, isUnwritten, PERSONA_TEMPLATE, PersonaConflict, personaPrompt, readPersona, recentCorrections, refinePrompt, writePersona } from "../src/persona.ts";
import { parseTrialResult } from "../src/trial.ts";

const workspace = () => ({ root: mkdtempSync(join(tmpdir(), "sidekick-persona-")), persona: ["sidekick/me.md", "twin/model.md"] });

describe("persona files", () => {
  test("only relative .md paths inside the workspace", () => {
    expect(isSafeRelative("sidekick/me.md")).toBe(true);
    for (const bad of ["../me.md", "a/../../me.md", "/etc/me.md", "~/me.md", "sidekick/me.txt", ""]) expect(isSafeRelative(bad)).toBe(false);
  });

  test("create, read back, and refuse anything the profile does not list", () => {
    const p = workspace();
    expect(readPersona(p).map((f) => f.exists)).toEqual([false, false]);
    const saved = writePersona(p, "sidekick/me.md", "# 我\n- 角色：前端", null);
    expect(saved.mtime).toBeNumber();
    expect(readPersona(p)[0]).toMatchObject({ exists: true, content: "# 我\n- 角色：前端" });
    expect(() => writePersona(p, "CLAUDE.md", "x", null)).toThrow(/不是这个 profile/);
    expect(() => writePersona({ ...p, persona: ["../x.md"] }, "../x.md", "x", null)).toThrow();
  });

  test("an edit made elsewhere since loading is not overwritten", () => {
    const p = workspace();
    const first = writePersona(p, "sidekick/me.md", "v1", null);
    utimesSync(join(p.root, "sidekick/me.md"), new Date(), new Date(Date.now() + 5000)); // changed on disk
    expect(() => writePersona(p, "sidekick/me.md", "v2", first.mtime)).toThrow(PersonaConflict);
    expect(() => writePersona(p, "twin/model.md", "new", 123)).toThrow(PersonaConflict); // claims a file that is not there
    const fresh = readPersona(p)[0];
    expect(writePersona(p, "sidekick/me.md", "v2", fresh.mtime).content).toBe("v2");
  });

  test("the bare template counts as unwritten; one real line does not", () => {
    expect(isUnwritten(PERSONA_TEMPLATE)).toBe(true);
    expect(isUnwritten("")).toBe(true);
    expect(isUnwritten(PERSONA_TEMPLATE.replace("- 角色和团队：", "- 角色和团队：支付组前端，负责结账页"))).toBe(false);
  });

  test("system prompt: engine rules, full-mode rules, then the written persona without comments", () => {
    const p = workspace();
    expect(systemPrompt(p, "semi")).not.toContain("分身资料");
    writePersona(p, "sidekick/me.md", PERSONA_TEMPLATE, null); // template only: still nothing to say
    expect(systemPrompt(p, "semi")).not.toContain("分身资料");
    mkdirSync(join(p.root, "twin"));
    writeFileSync(join(p.root, "twin/model.md"), "<!-- 只给自己看的备注 -->\n先给结论，不承诺排期。");
    const semi = systemPrompt(p, "semi");
    expect(semi).toContain("=== twin/model.md ===");
    expect(semi).toContain("先给结论，不承诺排期。");
    expect(semi).not.toContain("只给自己看的备注");
    expect(semi).not.toContain("全托管");
    expect(systemPrompt(p, "full")).toContain("全托管");
    expect(personaPrompt(p).indexOf("twin/model.md")).toBeGreaterThan(0);
  });
});

describe("a prompt to refine the persona with my own agent", () => {
  /** A ledger with one card of each ending; only the ones where I corrected sidekick count. */
  const ledger = () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "sidekick-refine-")));
    db.prepare("INSERT INTO tasks (id, source, kind, title, status, created_at, updated_at) VALUES ('t1', 'slack', 'dm', 'Ann (QA)：问题都改完了不', 'done', 0, 0)").run();
    const card = (id: string, at: number, status: string, result: string | null, note: string | null, extra: Record<string, string> = {}) =>
      db.prepare("INSERT INTO approvals (id, task_id, kind, key, payload, status, decision_note, created_at, result) VALUES (?, 't1', 'outbound', ?, ?, ?, ?, ?, ?)")
        .run(id, id, JSON.stringify({ kind: "slack.reply", channel: "D1", text: `草稿${id}`, ...extra }), status, note, at, result);
    card("a1", 1, "executed", "sent in Slack", null, { sentText: "改过的" });
    card("a2", 2, "executed", "sent in Slack", null, { sentText: "草稿a2" }); // sent as drafted: nothing to learn
    card("a3", 3, "executed", "executed: sent", null, { editedText: "在 sidekick 里改的" });
    card("a4", 4, "denied", "discarded", "语气太硬");
    card("a5", 5, "denied", "draft deleted in Slack", null);
    card("a6", 6, "denied", "superseded", null);
    card("a7", 7, "denied", "discarded: task cancelled", null);
    card("a8", 8, "executed", "executed: sent", null);
    return db;
  };

  test("corrections are what I changed or turned down, newest first", () => {
    const c = recentCorrections(ledger());
    expect(c.map((x) => x.draft)).toEqual(["草稿a5", "草稿a4", "草稿a3", "草稿a1"]);
    expect(c.map((x) => x.what)).toEqual(["我在 Slack 里删了草稿，没有回", "我拒绝了，意见：语气太硬", "我改成：在 sidekick 里改的", "我在 Slack 里改成：改过的"]);
  });

  test("the prompt names the files by absolute path with their state, and carries the corrections", () => {
    const p = workspace();
    writePersona(p, "sidekick/me.md", PERSONA_TEMPLATE, null);
    const { prompt, corrections } = refinePrompt(p, ledger());
    expect(corrections).toBe(4);
    expect(prompt).toContain(`${join(p.root, "sidekick/me.md")}（还是模板，没写）`);
    expect(prompt).toContain(`${join(p.root, "twin/model.md")}（还没有这个文件，新建）`);
    expect(prompt).toContain("我拒绝了，意见：语气太硬");
    expect(prompt).toContain("一次只问一个问题");
    expect(refinePrompt(p, openDb(mkdtempSync(join(tmpdir(), "sidekick-refine-")))).prompt).toContain("暂时没有");
  });
});

describe("trial result", () => {
  test("parsed and checked", () => {
    expect(parseTrialResult('想了想。\n{"action":"reply","judgement":"问的是我的模块","draft":"在查，今天回你"}')).toEqual({
      action: "reply", judgement: "问的是我的模块", draft: "在查，今天回你",
    });
    expect(parseTrialResult('```json\n{"action":"no_reply","judgement":"已自己回复","draft":"多余"}\n```').draft).toBeNull();
    expect(() => parseTrialResult('{"action":"send","judgement":""}')).toThrow(/action/);
    expect(() => parseTrialResult("没有 JSON")).toThrow();
  });
});
