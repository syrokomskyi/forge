/*
<MODULE_CONTRACT>
<purpose>Hook-script runner tests (RFC-1487 step 2): absent script → skipped,
non-zero exit → failed with a stderr tail, and the primary worktree's copy
runs even when the branch worktree carries a different one
(AUDIT-RFC-1487-G1).</purpose>
<non-goals>
  <item>No lifecycle coverage — handler tests own refusal mapping.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 2 — script runner tests</item>
  <item>RFC-1487: step 2 — primary-side hook-script runner</item>
  <item>RFC-1490: step 4 — ordinary flow.cut (release branch, verified versions, gate, main swap, tags, resume)</item>
</CHANGE_SUMMARY>
*/

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { runFlowScript } from "../scripts.ts";

const tempDirs: string[] = [];
async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "flow-scripts-test-"));
  tempDirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function writeScript(root: string, name: string, body: string): Promise<void> {
  await mkdir(join(root, "hooks"), { recursive: true });
  await writeFile(join(root, "hooks", `${name}.sh`), `#!/bin/sh\n${body}\n`);
}

describe("runFlowScript", () => {
  it("skips when the primary has no script", async () => {
    const primary = await dir();
    const branch = await dir();
    const result = await runFlowScript(ambientIo, "worktree-setup", {
      primary,
      cwd: branch,
      env: {},
    });
    expect(result).toEqual({ status: "skipped", exitCode: null, stderrTail: "", stdout: "" });
  });

  it("runs the primary copy with cwd and env; exit 0 → done", async () => {
    const primary = await dir();
    const branch = await dir();
    await writeScript(primary, "worktree-setup", 'pwd > "$FLOW_PRIMARY/out.txt"; echo "$FLOW_BRANCH" > branch.txt');
    const result = await runFlowScript(ambientIo, "worktree-setup", {
      primary,
      cwd: branch,
      env: { FLOW_PRIMARY: branch, FLOW_BRANCH: "auto/x" },
    });
    expect(result.status).toBe("done");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(branch, "out.txt"), "utf8")).toContain(branch);
    expect(await readFile(join(branch, "branch.txt"), "utf8")).toContain("auto/x");
  });

  it("exit 3 → failed with the stderr tail", async () => {
    const primary = await dir();
    const branch = await dir();
    const lines = Array.from({ length: 45 }, (_, i) => `echo "line-${i}" >&2`).join("\n");
    await writeScript(primary, "integration-gate", `${lines}\nexit 3`);
    const result = await runFlowScript(ambientIo, "integration-gate", {
      primary,
      cwd: branch,
      env: {},
    });
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
    expect(result.stderrTail).toContain("line-44");
    expect(result.stderrTail).not.toContain("line-4\n");
  });

  it("uses the primary copy even when the branch worktree carries a different one (G1)", async () => {
    const primary = await dir();
    const branch = await dir();
    await writeScript(primary, "integration-gate", "exit 0");
    await writeScript(branch, "integration-gate", "exit 1");
    const result = await runFlowScript(ambientIo, "integration-gate", {
      primary,
      cwd: branch,
      env: {},
    });
    expect(result.status).toBe("done");
  });
});
