import { describe, expect, test } from "bun:test";
import { checkForUpdate, compareVersions, tagsFromFeed } from "../src/update.ts";

/** A releases feed shaped like github.com's: one entry per release, notes HTML-escaped. */
const feed = (...tags: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <link type="text/html" rel="alternate" href="https://github.com/lilong7676/sidekick/releases"/>
  ${tags.map((t) => `<entry>
    <id>tag:github.com,2008:Repository/1/${t}</id>
    <link rel="alternate" type="text/html" href="https://github.com/lilong7676/sidekick/releases/tag/${t}"/>
    <title>Sidekick ${t}</title>
    <content type="html">&lt;a href=&quot;https://github.com/lilong7676/sidekick/releases/tag/v9.9.9&quot;&gt;notes&lt;/a&gt;</content>
  </entry>`).join("\n  ")}
</feed>`;

describe("is there a newer Sidekick", () => {
  test("versions order like semver, betas included", () => {
    const sorted = ["0.1.0-beta.9", "0.1.0", "v0.1.0-beta.10", "0.0.9", "0.2.0-beta.1", "0.1.0-alpha.3"].sort(compareVersions);
    expect(sorted).toEqual(["0.0.9", "0.1.0-alpha.3", "0.1.0-beta.9", "v0.1.0-beta.10", "0.1.0", "0.2.0-beta.1"]);
    expect(compareVersions("v0.1.0-beta.4", "0.1.0-beta.4")).toBe(0);
  });

  test("the feed's release links give the tags; links in release notes do not", () => {
    expect(tagsFromFeed(feed("v0.1.0-beta.8", "v0.1.0-beta.7"))).toEqual(["v0.1.0-beta.8", "v0.1.0-beta.7"]);
    expect(tagsFromFeed(feed())).toEqual([]);
  });

  const github = (body: string, ok = true) => async () => ({ ok, text: async () => body });

  test("a newer release is offered; the same or an older one is not", async () => {
    const latest = feed("v0.1.0-beta.5", "v0.1.0-beta.4");
    expect(await checkForUpdate("0.1.0-beta.4", github(latest))).toEqual({
      version: "0.1.0-beta.5",
      url: "https://github.com/lilong7676/sidekick/releases/tag/v0.1.0-beta.5",
    });
    expect(await checkForUpdate("0.1.0-beta.5", github(latest))).toBeNull();
    expect(await checkForUpdate("0.1.0", github(latest))).toBeNull();
  });

  test("the highest release wins, whatever order the feed lists them in", async () => {
    expect(await checkForUpdate("0.1.0-beta.4", github(feed("v0.1.0-beta.9", "v0.1.0-beta.10")))).toMatchObject({ version: "0.1.0-beta.10" });
  });

  test("nothing to say when GitHub cannot say: a private repo, no releases, no network", async () => {
    expect(await checkForUpdate("0.1.0-beta.4", github("Not Found", false))).toBeNull();
    expect(await checkForUpdate("0.1.0-beta.4", github(feed()))).toBeNull();
    expect(await checkForUpdate("0.1.0-beta.4", async () => { throw new Error("offline"); })).toBeNull();
  });
});
