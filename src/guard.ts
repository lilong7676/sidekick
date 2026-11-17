// `sidekick guard`: a PreToolUse hook for Bash that applies the profile's ask / deny rules to the
// command as it will really run. Claude Code matches rules by prefix and already splits `&&` / `;`
// chains, but `git -C <dir> push` slips past `Bash(git push:*)`, and mid-pattern wildcards do not
// match (Phase 1 policy probe). Hooks are evaluated before rules, so normalizing here closes that.

/** Rules in Claude Code syntax → the command prefixes they name. Non-Bash rules are ignored. */
export function bashPrefixes(rules: string[]): string[] {
  return rules
    .map((r) => /^Bash\((.+?)(?::\*)?\)$/.exec(r.trim())?.[1])
    .filter((p): p is string => Boolean(p))
    .map((p) => p.replace(/\s+\*$/, "").trim());
}

/** Split a shell line into simple-command segments on && || ; | and newlines, outside quotes. */
export function splitSegments(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"') { cur += ch + (line[i + 1] ?? ""); i += 1; continue; }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "\\") { cur += ch + (line[i + 1] ?? ""); i += 1; continue; }
    const two = line.slice(i, i + 2);
    if (two === "&&" || two === "||") { out.push(cur); cur = ""; i += 1; continue; }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Words of one segment, quotes removed (good enough for matching, not for executing). */
export function words(segment: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"((?:\\.|[^"])*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) out.push(m[1] ?? m[2]?.replace(/\\(.)/g, "$1") ?? m[3]);
  return out;
}

const WRAPPERS = new Set(["sudo", "command", "exec", "time", "nohup", "nice", "env", "xargs"]);
const GIT_OPTS_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

export type Normalized = { command: string } | { opaque: string };

/** Strip env assignments and wrappers, collapse git global options; flag shells that hide a command. */
export function normalize(segment: string): Normalized {
  let w = words(segment);
  for (;;) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    if (w.length && WRAPPERS.has(w[0])) { w = w.slice(1); continue; }
    break;
  }
  if (w.length === 0) return { command: "" };
  const bin = w[0].split("/").pop()!;
  if (["bash", "sh", "zsh", "fish"].includes(bin) && w.includes("-c")) return { opaque: w[w.indexOf("-c") + 1] ?? "" };
  if (bin === "eval") return { opaque: w.slice(1).join(" ") };
  if (bin === "git") {
    const rest: string[] = [];
    for (let i = 1; i < w.length; i += 1) {
      if (rest.length === 0 && GIT_OPTS_WITH_ARG.has(w[i])) { i += 1; continue; }
      if (rest.length === 0 && /^--?[\w-]+(=.*)?$/.test(w[i])) continue;
      rest.push(w[i]);
    }
    return { command: ["git", ...rest].join(" ") };
  }
  return { command: [bin, ...w.slice(1)].join(" ") };
}

const matches = (cmd: string, prefix: string) => cmd === prefix || cmd.startsWith(`${prefix} `);

export type GuardDecision = { decision: "deny" | "ask"; reason: string } | null;

export function guardCommand(line: string, ask: string[], deny: string[], depth = 0): GuardDecision {
  const askP = bashPrefixes(ask);
  const denyP = bashPrefixes(deny);
  let verdict: GuardDecision = null;
  for (const seg of splitSegments(line)) {
    const n = normalize(seg);
    if ("opaque" in n) {
      // A command hidden inside bash -c / eval: judge what is inside; variables or deeper nesting
      // cannot be read statically, so those go to a human.
      const unreadable = depth >= 2 || /\$|`/.test(n.opaque);
      const inner = unreadable
        ? { decision: "ask" as const, reason: `看不清里面要执行什么，要审批：${seg.slice(0, 120)}` }
        : guardCommand(n.opaque, ask, deny, depth + 1);
      if (inner?.decision === "deny") return inner;
      verdict ??= inner;
      continue;
    }
    const d = denyP.find((p) => matches(n.command, p));
    if (d) return { decision: "deny", reason: `命中禁止规则 ${d}` };
    const a = askP.find((p) => matches(n.command, p));
    if (a && !verdict) verdict = { decision: "ask", reason: `命中审批规则 ${a}` };
  }
  return verdict;
}

/** Hook entry: read the PreToolUse payload from stdin, print a decision or nothing. */
export async function runGuard(policyPath: string): Promise<void> {
  const policy = JSON.parse(await Bun.file(policyPath).text()) as { ask: string[]; deny: string[] };
  const input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as { tool_name?: string; tool_input?: { command?: string } };
  if (input.tool_name !== "Bash" || typeof input.tool_input?.command !== "string") return;
  const d = guardCommand(input.tool_input.command, policy.ask, policy.deny);
  if (!d) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d.decision, permissionDecisionReason: d.reason },
  }));
}
