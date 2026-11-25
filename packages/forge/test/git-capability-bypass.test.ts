/* Regression: git capability enforcement must survive global-flag indirection.
   Pre-fix the mutation check inspected args[0] only — `git -c x=y commit` bypassed it. */
import { describe, expect, it } from "vitest";

import { createPluginContext, gitSubcommand } from "../src/sdk/context.ts";
import { CapabilityViolation, type PluginManifest } from "../src/sdk/types.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

const manifest: PluginManifest = {
  id: "git-test",
  version: "1.0.0",
  forgeRange: "^10.0.0",
  capabilities: { filesystem: "read", processSpawn: false, network: false, gitMutation: false },
  registers: {},
};

function ctx(): ReturnType<typeof createPluginContext> {
  return createPluginContext(manifest, { workspaceRoot: mkTmp("forge-gitsec-") });
}

describe("gitSubcommand parsing", () => {
  it("finds the subcommand past value-taking global flags", () => {
    expect(gitSubcommand(["commit", "-m", "x"])).toBe("commit");
    expect(gitSubcommand(["-c", "user=x", "commit", "-m", "x"])).toBe("commit");
    expect(gitSubcommand(["--git-dir=/tmp/x", "push"])).toBe("push");
    expect(gitSubcommand(["-P", "status"])).toBe("status");
    expect(gitSubcommand(["status"])).toBe("status");
    expect(gitSubcommand([])).toBeUndefined();
  });
});

describe("git mutation enforcement — bypass vectors closed", () => {
  it("refuses commit hidden behind -c config flags", async () => {
    await expect(ctx().git.exec(["-c", "user=x", "commit", "-m", "x"])).rejects.toThrow(CapabilityViolation);
  });
  it("refuses push hidden behind boolean global flags", async () => {
    await expect(ctx().git.exec(["--no-pager", "push"])).rejects.toThrow(CapabilityViolation);
  });
  it("refuses dual-use mutators conservatively (tag/branch/config)", async () => {
    await expect(ctx().git.exec(["tag"])).rejects.toThrow(CapabilityViolation);
    await expect(ctx().git.exec(["branch"])).rejects.toThrow(CapabilityViolation);
    await expect(ctx().git.exec(["config", "--get", "user.name"])).rejects.toThrow(CapabilityViolation);
  });
  it("refuses unambiguous mutators added beyond the original list", async () => {
    for (const op of ["add", "stash", "worktree", "reflog", "gc", "fetch", "pull", "update-index"]) {
      await expect(ctx().git.exec([op])).rejects.toThrow(CapabilityViolation);
    }
  });
  it("refuses scope redirection flags outright — even for reads", async () => {
    await expect(ctx().git.exec(["-C", "/other/repo", "log"])).rejects.toThrow(CapabilityViolation);
    await expect(ctx().git.exec(["--git-dir=/other/.git", "log"])).rejects.toThrow(CapabilityViolation);
    await expect(ctx().git.exec(["--work-tree", "/other", "status"])).rejects.toThrow(CapabilityViolation);
  });
  it("still permits read-only plumbing", async () => {
    const c = ctx();
    // errors on non-repo are fine — the assertion is no CapabilityViolation
    await expect(c.git.exec(["rev-parse", "--git-common-dir"])).rejects.toThrow(/not a git repository|fatal/);
    await expect(c.git.exec(["for-each-ref"])).rejects.toThrow(/not a git repository|fatal/);
  });
});
