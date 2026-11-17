import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../src/config.ts";
import { isUnwritten } from "../src/persona.ts";
import { startSetupServer } from "../src/server.ts";
import { scaffoldWorkspace, useWorkspace } from "../src/setup.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "sidekick-setup-"));

describe("workspace setup", () => {
  test("an empty folder gets a profile, a Slack skill and a persona that load as they are", () => {
    const root = tmp();
    expect(scaffoldWorkspace(root)).toEqual(["sidekick/profile.yaml", "sidekick/slack.md", "sidekick/me.md"]);
    const p = loadProfile("work", root);
    expect(p.agent.skill).toBe("sidekick/slack.md");
    expect(p.persona).toEqual(["sidekick/me.md"]);
    expect(isUnwritten(readFileSync(join(root, "sidekick/me.md"), "utf8"))).toBe(true);
  });

  test("never overwrites, and leaves a folder that already has a profile alone", () => {
    const root = tmp();
    mkdirSync(join(root, "sidekick"));
    writeFileSync(join(root, "sidekick/me.md"), "我自己写的");
    expect(scaffoldWorkspace(root)).toEqual(["sidekick/profile.yaml", "sidekick/slack.md"]);
    expect(readFileSync(join(root, "sidekick/me.md"), "utf8")).toBe("我自己写的");
    expect(scaffoldWorkspace(root)).toEqual([]);
  });

  test("useWorkspace: absolute folders only, creates a new one, writes the engine config", () => {
    const dir = tmp();
    const cfg = join(dir, "cfg/config.yaml");
    expect(() => useWorkspace("relative/x", cfg)).toThrow(/绝对路径/);
    writeFileSync(join(dir, "file"), "x");
    expect(() => useWorkspace(join(dir, "file"), cfg)).toThrow(/不是文件夹/);
    const r = useWorkspace(join(dir, "new-ws/"), cfg);
    expect(r.root).toBe(join(dir, "new-ws"));
    expect(r.created.length).toBe(3);
    expect(readFileSync(cfg, "utf8")).toContain(join(dir, "new-ws"));
  });
});

describe("setup server", () => {
  const dir = tmp();
  let restarted = 0;
  const srv = startSetupServer({
    reason: "missing ~/.config/sidekick/config.yaml",
    port: 0,
    runtimeFile: join(dir, "runtime.json"),
    engineConfig: join(dir, "config.yaml"),
    restart: () => { restarted += 1; },
  });
  afterAll(() => srv.stop());
  const send = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${srv.port}${path}`, { method, headers: { Authorization: `Bearer ${srv.token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  test("says it needs setup; picking a folder configures it and restarts", async () => {
    expect((await fetch(`http://127.0.0.1:${srv.port}/api/state`)).status).toBe(401);
    const state = (await (await send("GET", "/api/state")).json()) as { setup: { reason: string; suggestedRoot: string } };
    expect(state.setup.reason).toContain("config.yaml");
    expect((await send("POST", "/api/setup", { root: "nope" })).status).toBe(400);
    expect(restarted).toBe(0);
    const ws = join(dir, "ws");
    const res = await send("POST", "/api/setup", { root: ws });
    expect(res.status).toBe(200);
    expect(existsSync(join(ws, "sidekick/profile.yaml"))).toBe(true);
    expect(restarted).toBe(1);
    expect((await send("GET", "/api/tasks")).status).toBe(404); // nothing else exists before setup
  });
});
