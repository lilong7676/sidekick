// Is there a newer Sidekick? The daemon asks GitHub Releases now and then (betas included, like the
// install script), and the panel offers the upgrade: the same one-line install, run again.
//
// It reads the releases feed on github.com, not the API. Unauthenticated, the API allows 60 calls an
// hour per IP; an office behind one proxy shares them, and both this check and the install got 403.

import { log, VERSION } from "./util.ts";

export const RELEASES_REPO = "lilong7676/sidekick";
export const INSTALL_COMMAND = `curl -fsSL https://raw.githubusercontent.com/${RELEASES_REPO}/main/scripts/install.sh | bash`;

export interface UpdateInfo { version: string; url: string }

/** Semver order, prereleases included: 0.1.0-beta.10 > 0.1.0-beta.9, 0.1.0 > 0.1.0-beta.9. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // a release outranks its prereleases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

type Fetch = (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>;

/**
 * Release tags in GitHub's releases feed. Each entry links its release with a real `href="…"`; links
 * inside release notes are escaped (`&quot;`), so they never match.
 */
export function tagsFromFeed(atom: string): string[] {
  const link = /href="https:\/\/github\.com\/[^/"]+\/[^/"]+\/releases\/tag\/(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)"/g;
  return [...atom.matchAll(link)].map((m) => m[1]);
}

/** The newest release if it is newer than this one; null when up to date or GitHub cannot say. */
export async function checkForUpdate(current = VERSION, get: Fetch = (url) => fetch(url, { headers: { "User-Agent": "sidekick" }, signal: AbortSignal.timeout(15_000) })): Promise<UpdateInfo | null> {
  try {
    const res = await get(`https://github.com/${RELEASES_REPO}/releases.atom`);
    if (!res.ok) return null; // e.g. the repository is not public (yet)
    const tags = tagsFromFeed(await res.text());
    if (!tags.length) return null;
    // The feed lists the newest first; taking the highest does not depend on that.
    const latest = tags.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a));
    return compareVersions(latest, current) > 0
      ? { version: latest.slice(1), url: `https://github.com/${RELEASES_REPO}/releases/tag/${latest}` }
      : null;
  } catch (e) {
    log(`update: check failed: ${String(e).slice(0, 200)}`);
    return null;
  }
}
