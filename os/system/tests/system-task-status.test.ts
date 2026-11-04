/*
<MODULE_CONTRACT>
<purpose>RFC-1509 acceptance tests for system.task.status — the read-only
projection of task state plus product-side registry/journal evidence
(registered / integrated / discarded / orphaned / unknown).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1509: step 5 — status acceptance tests</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
  <item>RFC-1509: close RFC-1509 review r1 findings — mark-failed escape, open-error refusal, dry-run coverage</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { describe, expect, it } from "vitest";

import { runSystemTaskDispatch } from "../handlers/system-task-dispatch.ts";
import { runSystemTaskStatus } from "../handlers/system-task-status.ts";
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

describe("system.task.status", () => {
  it("lists every task and is read-only", async () => {
    const systemRoot = await makeSystemRepo({
      "system/system.yaml": VALID_SYSTEM_YAML,
      "system/products.yaml": VALID_PRODUCTS_YAML,
      "system/edges.yaml": VALID_EDGES_YAML,
      "system/products.local.yaml": localMapFor({ alpha: "./alpha" }),
      "alpha/.gitkeep": "",
      "queue/tasks/T-0001.yaml": taskYaml({ id: "T-0001" }),
      "queue/tasks/T-0002.yaml": taskYaml({ id: "T-0002", state: "done" }),
    });
    const result = await runSystemTaskStatus(input({}), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data?.tasks.map((t) => t.id)).toEqual(["T-0001", "T-0002"]);
    expect(result.data?.tasks[0].productStatus).toBe("not-dispatched");
  });

  it("--task limits the projection to one id", async () => {
    const systemRoot = await makeSystemRepo({
      "system/system.yaml": VALID_SYSTEM_YAML,
      "system/products.yaml": VALID_PRODUCTS_YAML,
      "system/edges.yaml": VALID_EDGES_YAML,
      "queue/tasks/T-0001.yaml": taskYaml({ id: "T-0001" }),
      "queue/tasks/T-0002.yaml": taskYaml({ id: "T-0002" }),
    });
    const result = await runSystemTaskStatus(input({ task: "T-0002" }), makeContext(systemRoot));
    expect(result.data?.tasks).toHaveLength(1);
    expect(result.data?.tasks[0].id).toBe("T-0002");
  });

  it("a dispatched task with a live worktree reports registered", async () => {
    const productRoot = await makeProduct();
    const systemRoot = await makeSystemRepo({
      "system/system.yaml": VALID_SYSTEM_YAML,
      "system/products.yaml": VALID_PRODUCTS_YAML,
      "system/edges.yaml": VALID_EDGES_YAML,
      "system/products.local.yaml": localMapFor({ alpha: productRoot }),
      "queue/tasks/T-0001.yaml": taskYaml({ state: "ready" }),
      "queue/briefs/T-0001.md": readyBrief(),
    });
    await runSystemTaskDispatch(input({ task: "T-0001" }), makeContext(systemRoot));
    const result = await runSystemTaskStatus(input({}), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data?.tasks[0].productStatus).toBe("registered");
    expect(result.data?.tasks[0].branch).toMatch(/^auto\/task-/);
  });

  it("AC-16: a dispatched task with no registry entry and no journal event reports orphaned", async () => {
    const productRoot = await makeProduct();
    const systemRoot = await makeSystemRepo({
      "system/system.yaml": VALID_SYSTEM_YAML,
      "system/products.yaml": VALID_PRODUCTS_YAML,
      "system/edges.yaml": VALID_EDGES_YAML,
      "system/products.local.yaml": localMapFor({ alpha: productRoot }),
      "queue/tasks/T-0001.yaml": taskYaml({
        state: "dispatched",
        dispatch: {
          branch: "auto/task-260101-01-ghost",
          worktree: "/nonexistent/worktree",
          baseCommit: "deadbeef",
          dispatchedAt: "2026-01-01T00:00:00Z",
        },
      }),
    });
    const result = await runSystemTaskStatus(input({}), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data?.tasks[0].productStatus).toBe("orphaned");
    expect(result.data?.tasks[0].productMessage).toContain("auto/task-260101-01-ghost");
  });

  it("a corrupt product registry reports unknown — never orphaned on broken evidence", async () => {
    const productRoot = await makeProduct();
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    await mkdir(path.join(productRoot, ".git", "forge"), { recursive: true });
    await writeFile(path.join(productRoot, ".git", "forge", "registry.yaml"), "not: [valid, registry");
    const systemRoot = await makeSystemRepo({
      "system/system.yaml": VALID_SYSTEM_YAML,
      "system/products.yaml": VALID_PRODUCTS_YAML,
      "system/edges.yaml": VALID_EDGES_YAML,
      "system/products.local.yaml": localMapFor({ alpha: productRoot }),
      "queue/tasks/T-0001.yaml": taskYaml({
        state: "dispatched",
        dispatch: {
          branch: "auto/task-260101-01-ghost",
          worktree: "/nonexistent",
          baseCommit: "deadbeef",
          dispatchedAt: "2026-01-01T00:00:00Z",
        },
      }),
    });
    const result = await runSystemTaskStatus(input({}), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data?.tasks[0].productStatus).toBe("unknown");
  });

  it("an unreadable product repo reports unknown, not an error", async () => {
    const systemRoot = await makeSystemRepo({
      "system/system.yaml": VALID_SYSTEM_YAML,
      "system/products.yaml": VALID_PRODUCTS_YAML,
      "system/edges.yaml": VALID_EDGES_YAML,
      "system/products.local.yaml": localMapFor({ alpha: "/definitely/not/a/repo" }),
      "queue/tasks/T-0001.yaml": taskYaml({
        state: "dispatched",
        dispatch: {
          branch: "auto/task-260101-01-x",
          worktree: "/gone",
          baseCommit: "deadbeef",
          dispatchedAt: "2026-01-01T00:00:00Z",
        },
      }),
    });
    const result = await runSystemTaskStatus(input({}), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data?.tasks[0].productStatus).toBe("unknown");
    expect(result.data?.tasks[0].productMessage).toBeTruthy();
  });
});
