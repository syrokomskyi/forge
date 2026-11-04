/*
<MODULE_CONTRACT>
<purpose>RFC-1509 acceptance tests for system.task.collect and the
.forge/task/ preservation path — report lookup (worktree vs preserved copy),
schema/task-id validation, outcome transitions, journal-driven
reported→integrated, and --mark-failed.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1509: step 5 — collect + preservation acceptance tests</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
  <item>RFC-1509: close RFC-1509 review r1 findings — mark-failed escape, open-error refusal, dry-run coverage</item>
  <item>RFC-1509: address RFC-1509 review r2 — mark-failed without product, journal-read warning, status map diagnostics, V-49 deviations</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { gitExec } from "../../flow/tests/helpers.ts";
import { runFlowIntegrate } from "../../flow/handlers/flow-integrate.ts";
import { runSystemTaskCollect } from "../handlers/system-task-collect.ts";
import { runSystemTaskDispatch } from "../handlers/system-task-dispatch.ts";
import { readTask } from "../task-store.ts";
import {
  localMapFor,
  makeContext,
  makeProduct,
  makeSystemRepo,
  readyBrief,
  taskYaml,
  VALID_EDGES_YAML,
  VALID_PRODUCTS_YAML,
  VALID_SYSTEM_YAML,
} from "./helpers.ts";

function input(flags: Record<string, string | string[] | boolean>) {
  return { argv: [], flags };
}

const DONE_REPORT = `schema: forge/task-report@1
task: T-0001
outcome: done
summary: "brief implemented"
commits: ["abc123"]
gate: pass
acceptance: []
outbox: []
`;

interface Fixture {
  systemRoot: string;
  productRoot: string;
  worktree: string;
}

/** Dispatch T-0001 into a real alpha product; returns the worktree path. */
async function dispatched(overrides: Record<string, string> = {}): Promise<Fixture> {
  const productRoot = await makeProduct();
  const systemRoot = await makeSystemRepo({
    "system/system.yaml": VALID_SYSTEM_YAML,
    "system/products.yaml": VALID_PRODUCTS_YAML,
    "system/edges.yaml": VALID_EDGES_YAML,
    "system/products.local.yaml": localMapFor({ alpha: productRoot }),
    "queue/tasks/T-0001.yaml": taskYaml({ state: "ready" }),
    "queue/briefs/T-0001.md": readyBrief(),
    ...overrides,
  });
  const dispatched = await runSystemTaskDispatch(input({ task: "T-0001" }), makeContext(systemRoot));
  if (!dispatched.data?.dispatched) {
    throw new Error(`fixture dispatch failed: ${JSON.stringify(dispatched.data?.diagnostics)}`);
  }
  return { systemRoot, productRoot, worktree: dispatched.data.worktree! };
}

async function writeReport(worktree: string, content = DONE_REPORT): Promise<void> {
  await writeFile(path.join(worktree, ".forge", "task", "report.yaml"), content);
}

describe("system.task.collect", () => {
  it("AC-11: a valid done report moves the task to reported and copies it", async () => {
    const { systemRoot, worktree } = await dispatched();
    await writeReport(worktree);
    const result = await runSystemTaskCollect(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data?.state).toBe("reported");
    const io = (await import("../../../src/utils/io.ts")).resolveIo(undefined);
    const { task } = await readTask(systemRoot, io, "T-0001");
    expect(task!.state).toBe("reported");
    expect(task!.report).toBe("queue/reports/T-0001.yaml");
    const copied = await readFile(path.join(systemRoot, "queue/reports/T-0001.yaml"), "utf8");
    expect(copied).toContain("outcome: done");
  });

  it("AC-13: a missing report refuses SYSTEM-TASK-07 unless --mark-failed", async () => {
    const { systemRoot } = await dispatched();
    const refused = await runSystemTaskCollect(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(refused.exitCode).toBe(1);
    expect(refused.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-07")).toBe(true);

    const marked = await runSystemTaskCollect(
      input({ task: "T-0001", "mark-failed": true, reason: "session abandoned" }),
      makeContext(systemRoot),
    );
    expect(marked.exitCode).toBe(0);
    expect(marked.data?.state).toBe("failed");
  });

  it("--mark-failed without --reason still refuses SYSTEM-TASK-07", async () => {
    const { systemRoot } = await dispatched();
    const result = await runSystemTaskCollect(
      input({ task: "T-0001", "mark-failed": true }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-07")).toBe(true);
  });

  it("--mark-failed stays reachable after the product folder is unmapped", async () => {
    const { systemRoot } = await dispatched();
    // The product mapping disappears post-dispatch — the failure escape must
    // not depend on a resolvable product checkout.
    await writeFile(
      path.join(systemRoot, "system/products.local.yaml"),
      "schema: forge/system-products-local@1\nfolders: {}\n",
    );
    const result = await runSystemTaskCollect(
      input({ task: "T-0001", "mark-failed": true, reason: "product decommissioned" }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data?.state).toBe("failed");
  });

  it("AC-14: a report naming a different task refuses SYSTEM-TASK-08", async () => {
    const { systemRoot, worktree } = await dispatched();
    await writeReport(worktree, DONE_REPORT.replace("task: T-0001", "task: T-0099"));
    const result = await runSystemTaskCollect(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-08")).toBe(true);
  });

  it("a schema-invalid report refuses SYSTEM-TASK-08", async () => {
    const { systemRoot, worktree } = await dispatched();
    await writeReport(worktree, "schema: forge/task-report@1\ntask: T-0001\noutcome: nonsense\n");
    const result = await runSystemTaskCollect(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-08")).toBe(true);
  });

  it("a blocked outcome moves the task to failed", async () => {
    const { systemRoot, worktree } = await dispatched();
    await writeReport(worktree, DONE_REPORT.replace("outcome: done", "outcome: blocked"));
    const result = await SystemCollect(systemRoot);
    expect(result.data?.state).toBe("failed");
  });

  it("AC-12/15: integrate removes the worktree yet collect still reaches integrated via the preserved report + journal", async () => {
    const { systemRoot, productRoot, worktree } = await dispatched();
    await writeReport(worktree);
    // Commit a payload in the task worktree so integrate has something to merge.
    await writeFile(path.join(worktree, "feature.txt"), "payload\n");
    await gitExec(worktree, ["add", "feature.txt"]);
    await gitExec(worktree, ["commit", "-m", "task payload"]);

    // The product's own flow command integrates the task branch.
    const integrated = await runFlowIntegrate(
      input({}),
      { ...makeContext(worktree), workspaceRoot: worktree },
    );
    if (integrated.exitCode !== 0) {
      console.log("INTEGRATE DIAGNOSTICS", JSON.stringify(integrated.data?.diagnostics, null, 2));
    }
    expect(integrated.exitCode).toBe(0);
    // Worktree is gone; the report survived under the common git dir (AC-15).
    const io = (await import("../../../src/utils/io.ts")).resolveIo(undefined);
    expect(await io.exists(worktree)).toBe(false);
    const common = path.join(productRoot, ".git");
    const preserved = path.join(common, "forge", "tasks", "T-0001", "report.yaml");
    expect(await io.exists(preserved)).toBe(true);

    const collected = await runSystemTaskCollect(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(collected.exitCode).toBe(0);
    expect(collected.data?.state).toBe("integrated");
    const { task } = await readTask(systemRoot, io, "T-0001");
    expect(task!.state).toBe("integrated");
    expect(task!.integratedCommit).toMatch(/^[0-9a-f]{40}$/);
    // Both history rows recorded in a single collect call.
    expect(task!.history.map((h) => h.to)).toEqual(
      expect.arrayContaining(["reported", "integrated"]),
    );
  });

  it("a needs-decision report without question refuses SYSTEM-TASK-08", async () => {
    const { systemRoot, worktree } = await dispatched();
    await writeReport(
      worktree,
      DONE_REPORT.replace("outcome: done", "outcome: needs-decision"),
    );
    const result = await runSystemTaskCollect(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-08")).toBe(true);
  });

  it("--mark-failed escapes a present-but-invalid report (fixHint is reachable)", async () => {
    const { systemRoot, worktree } = await dispatched();
    await writeReport(worktree, "schema: forge/task-report@1\ntask: T-0001\noutcome: nonsense\n");
    const result = await runSystemTaskCollect(
      input({ task: "T-0001", "mark-failed": true, reason: "report is wedged" }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data?.state).toBe("failed");
  });

  it("a reported task with an unresolvable product checkout warns instead of stalling", async () => {
    const systemRoot = await makeSystemRepo({
      "system/system.yaml": VALID_SYSTEM_YAML,
      "system/products.yaml": VALID_PRODUCTS_YAML,
      "system/edges.yaml": VALID_EDGES_YAML,
      "system/products.local.yaml": localMapFor({ alpha: "/definitely/not/here" }),
      "queue/tasks/T-0001.yaml": taskYaml({
        state: "reported",
        report: "queue/reports/T-0001.yaml",
        dispatch: {
          branch: "auto/task-260101-01-x",
          worktree: "/gone",
          baseCommit: "deadbeef",
          dispatchedAt: "2026-01-01T00:00:00Z",
        },
      }),
      "queue/reports/T-0001.yaml": DONE_REPORT,
    });
    const result = await runSystemTaskCollect(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-05" && d.severity === "warning")).toBe(true);
    expect(result.data?.state).toBe("reported");
  });

  it("collect --dry-run writes nothing", async () => {
    const { systemRoot, worktree } = await dispatched();
    await writeReport(worktree);
    const result = await runSystemTaskCollect(
      input({ task: "T-0001", "dry-run": true }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(0);
    const io = (await import("../../../src/utils/io.ts")).resolveIo(undefined);
    const { task } = await readTask(systemRoot, io, "T-0001");
    expect(task!.state).toBe("dispatched");
  });

  it("collect refuses a task that was never dispatched (SYSTEM-TASK-02)", async () => {
    const productRoot = await makeProduct();
    const systemRoot = await makeSystemRepo({
      "system/system.yaml": VALID_SYSTEM_YAML,
      "system/products.yaml": VALID_PRODUCTS_YAML,
      "system/edges.yaml": VALID_EDGES_YAML,
      "system/products.local.yaml": localMapFor({ alpha: productRoot }),
      "queue/tasks/T-0001.yaml": taskYaml({ state: "ready" }),
    });
    const result = await runSystemTaskCollect(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-02")).toBe(true);
  });
});

async function SystemCollect(systemRoot: string) {
  return runSystemTaskCollect(input({ task: "T-0001" }), makeContext(systemRoot));
}

// ---------------------------------------------------------------------------
// AC-15 isolation — discard also preserves .forge/task/
// ---------------------------------------------------------------------------

describe("task-file preservation on discard", () => {
  it("flow.discard preserves .forge/task/ under the common git dir", async () => {
    const { runFlowDiscard } = await import("../../flow/handlers/flow-discard.ts");
    const { productRoot, worktree } = await dispatched();
    await writeReport(worktree);
    const result = await runFlowDiscard(
      input({ reason: "session dropped" }),
      { ...makeContext(worktree), workspaceRoot: worktree },
    );
    expect(result.exitCode).toBe(0);
    const io = (await import("../../../src/utils/io.ts")).resolveIo(undefined);
    const preserved = path.join(productRoot, ".git", "forge", "tasks", "T-0001", "report.yaml");
    expect(await io.exists(preserved)).toBe(true);
    expect(await io.exists(worktree)).toBe(false);
  });
});
