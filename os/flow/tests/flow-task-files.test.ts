/*
<MODULE_CONTRACT>
<purpose>RFC-1509 unit tests for preserveTaskFiles — the copy of
.forge/task/ into &lt;common&gt;/forge/tasks/&lt;owner id&gt;/ before a task
worktree is removed.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1509: step 4 — preserveTaskFiles unit tests</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { preserveTaskFiles } from "../task-files.ts";
import { resolveIo } from "../../../src/utils/io.ts";

describe("preserveTaskFiles", () => {
  it("copies every file under .forge/task/ into the common git dir", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "preserve-"));
    const worktree = path.join(root, "wt");
    const common = path.join(root, "common");
    await mkdir(path.join(worktree, ".forge", "task"), { recursive: true });
    await writeFile(path.join(worktree, ".forge", "task", "brief.md"), "the brief");
    await writeFile(path.join(worktree, ".forge", "task", "report.yaml"), "the report");
    const io = resolveIo(undefined);

    const copied = await preserveTaskFiles(common, worktree, "T-0042", io);
    expect(copied).toEqual(["brief.md", "report.yaml"]);
    expect(await readFile(path.join(common, "forge", "tasks", "T-0042", "brief.md"), "utf8")).toBe("the brief");
    expect(await readFile(path.join(common, "forge", "tasks", "T-0042", "report.yaml"), "utf8")).toBe("the report");
  });

  it("is a no-op when .forge/task/ is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "preserve-"));
    const io = resolveIo(undefined);
    const copied = await preserveTaskFiles(path.join(root, "common"), path.join(root, "wt"), "T-0001", io);
    expect(copied).toEqual([]);
  });

  it("re-copying over an existing preserved dir succeeds (idempotent)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "preserve-"));
    const worktree = path.join(root, "wt");
    const common = path.join(root, "common");
    await mkdir(path.join(worktree, ".forge", "task"), { recursive: true });
    await writeFile(path.join(worktree, ".forge", "task", "report.yaml"), "v1");
    const io = resolveIo(undefined);
    await preserveTaskFiles(common, worktree, "T-0001", io);
    await writeFile(path.join(worktree, ".forge", "task", "report.yaml"), "v2");
    await preserveTaskFiles(common, worktree, "T-0001", io);
    expect(await readFile(path.join(common, "forge", "tasks", "T-0001", "report.yaml"), "utf8")).toBe("v2");
  });
});
