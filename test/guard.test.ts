import { describe, expect, test } from "bun:test";
import { bashPrefixes, guardCommand, normalize, splitSegments } from "../src/guard.ts";

const ask = ["Bash(git push:*)", "Bash(gh pr create:*)", "Bash(acli jira workitem comment create:*)"];
const deny = ["Bash(slackcli messages:*)", "Bash(npm publish:*)", "Read(./.state/**)"];

describe("parsing", () => {
  test("rule prefixes, Bash only", () => {
    expect(bashPrefixes([...ask, ...deny])).toEqual(["git push", "gh pr create", "acli jira workitem comment create", "slackcli messages", "npm publish"]);
  });

  test("segments split on operators outside quotes only", () => {
    expect(splitSegments(`cd /x && git push; echo "a && b" | wc -l`)).toEqual(["cd /x", "git push", 'echo "a && b"', "wc -l"]);
  });

  test("git global options collapse", () => {
    expect(normalize("git -C /repo push origin main")).toEqual({ command: "git push origin main" });
    expect(normalize("git -c user.name=x --no-pager push")).toEqual({ command: "git push" });
    expect(normalize("FOO=1 env BAR=2 /usr/bin/git -C . log -1")).toEqual({ command: "git log -1" });
  });
});

describe("decisions", () => {
  test("the bypasses the policy probe found are caught", () => {
    expect(guardCommand("git -C /tmp/repo push origin main", ask, deny)?.decision).toBe("ask");
    expect(guardCommand("cd /tmp && git -C . push", ask, deny)?.decision).toBe("ask");
  });

  test("deny beats ask anywhere in the line", () => {
    expect(guardCommand("git push && slackcli messages send --message hi", ask, deny)?.decision).toBe("deny");
  });

  test("commands hidden in a shell are looked into, else asked about", () => {
    expect(guardCommand(`bash -c "slackcli messages send --message x"`, ask, deny)?.decision).toBe("deny");
    expect(guardCommand(`sh -c 'git -C . push'`, ask, deny)?.decision).toBe("ask");
    expect(guardCommand(`bash -c "ls -la"`, ask, deny)).toBeNull();
    expect(guardCommand(`eval "$CMD"`, ask, deny)?.decision).toBe("ask");
  });

  test("reads stay unblocked", () => {
    expect(guardCommand("git -C /repo log --oneline -5 | head", ask, deny)).toBeNull();
    expect(guardCommand("gh pr view 12 -R o/r --json state", ask, deny)).toBeNull();
    expect(guardCommand("slackcli conversations read C1 --json", ask, deny)).toBeNull();
  });

  test("prefix match is on word boundaries", () => {
    expect(guardCommand("git pushx", ask, deny)).toBeNull();
    expect(guardCommand("npm publisher", ask, deny)).toBeNull();
  });
});
