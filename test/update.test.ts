import { describe, expect, test } from "bun:test";
import { checkForUpdate, compareVersions } from "../src/update.ts";

describe("is there a newer Sidekick", () => {
  test("versions order like semver, betas included", () => {
    const sorted = ["0.1.0-beta.9", "0.1.0", "v0.1.0-beta.10", "0.0.9", "0.2.0-beta.1", "0.1.0-alpha.3"].sort(compareVersions);
    expect(sorted).toEqual(["0.0.9", "0.1.0-alpha.3", "0.1.0-beta.9", "v0.1.0-beta.10", "0.1.0", "0.2.0-beta.1"]);
    expect(compareVersions("v0.1.0-beta.4", "0.1.0-beta.4")).toBe(0);
  });

  const github = (body: unknown, ok = true) => async () => ({ ok, json: async () => body });

  test("a newer release is offered; the same or an older one is not", async () => {
    const latest = [{ tag_name: "v0.1.0-beta.5", html_url: "https://github.com/x/releases/tag/v0.1.0-beta.5" }];
    expect(await checkForUpdate("0.1.0-beta.4", github(latest))).toEqual({ version: "0.1.0-beta.5", url: "https://github.com/x/releases/tag/v0.1.0-beta.5" });
    expect(await checkForUpdate("0.1.0-beta.5", github(latest))).toBeNull();
    expect(await checkForUpdate("0.1.0", github(latest))).toBeNull();
  });

  test("nothing to say when GitHub cannot say: a private repo, no releases, no network", async () => {
    expect(await checkForUpdate("0.1.0-beta.4", github({ message: "Not Found" }, false))).toBeNull();
    expect(await checkForUpdate("0.1.0-beta.4", github([]))).toBeNull();
    expect(await checkForUpdate("0.1.0-beta.4", async () => { throw new Error("offline"); })).toBeNull();
  });
});
