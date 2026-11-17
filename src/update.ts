// Is there a newer Sidekick? The daemon asks GitHub Releases now and then (betas included, like the
// install script), and the panel offers the upgrade: the same one-line install, run again.

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

type Fetch = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** The newest release if it is newer than this one; null when up to date or GitHub cannot say. */
export async function checkForUpdate(current = VERSION, get: Fetch = (url) => fetch(url, { headers: { "User-Agent": "sidekick" }, signal: AbortSignal.timeout(15_000) })): Promise<UpdateInfo | null> {
  try {
    const res = await get(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=1`);
    if (!res.ok) return null; // e.g. the repository is not public (yet)
    const [latest] = (await res.json()) as Array<{ tag_name?: string; html_url?: string }>;
    if (!latest?.tag_name) return null;
    return compareVersions(latest.tag_name, current) > 0 ? { version: latest.tag_name.replace(/^v/, ""), url: latest.html_url ?? "" } : null;
  } catch (e) {
    log(`update: check failed: ${String(e).slice(0, 200)}`);
    return null;
  }
}
