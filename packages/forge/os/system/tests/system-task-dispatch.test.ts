/*
<MODULE_CONTRACT>
<purpose>RFC-1509 acceptance tests for system.task.dispatch — product
resolution, edge gates, brief leak checks, branch/worktree creation,
git-exclusion of .forge/task/ and the launcher argv.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1509: step 5 — dispatch acceptance tests</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { describe, expect, it } from "vitest";

import { gitExec } from "../../flow/tests/helpers.ts";
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

interface DispatchFixture {
  systemRoot: string;
  productRoot: string;
}

/** System repo + governed alpha product + ready T-0001 wired in local map. */
async function dispatchFixture(overrides: Record<string, string> = {}): Promise<DispatchFixture> {
  const productRoot = await makeProduct();
  const systemRoot = await makeSystemRepo({
    "system/system.yaml": VALID_SYSTEM_YAML,
    "system/products.yaml": VALID_PRODUCTS_YAML,
    "system/edges.yaml": VALID_EDGES_YAML,
    "system/products.local.yaml": localMapFor({ alpha: productRoot, beta: "./beta" }),
    "beta/.gitkeep": "",
    "queue/tasks/T-0001.yaml": taskYaml({ state: "ready" }),
    "queue/briefs/T-0001.md": readyBrief(),
    ...overrides,
  });
  return { systemRoot, productRoot };
}

describe("system.task.dispatch", () => {
  it("AC-4/5/6: dispatch opens auto/task-… with task owner, records branch, worktree stays clean", async () => {
    const { systemRoot, productRoot } = await dispatchFixture();
    const result = await runSystemTaskDispatch(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data?.dispatched).toBe(true);
    const branch = result.data!.branch!;
    expect(branch).toMatch(/^auto\/task-\d{6}-\d{2}-fixture-task$/);

    // AC-5: the task file records the actual branch + worktree.
    const io = (await import("../../../src/utils/io.ts")).resolveIo(undefined);
    const { task } = await readTask(systemRoot, io, "T-0001");
    expect(task!.state).toBe("dispatched");
    expect(task!.dispatch!.branch).toBe(branch);
    expect(task!.dispatch!.worktree).toBe(result.data!.worktree);
    expect(task!.briefSha256).toMatch(/^[0-9a-f]{64}$/);

    // Registry owner is the task.
    const registry = await io.readFile(`${productRoot}/.git/forge/registry.yaml`);
    expect(registry).toContain(`kind: task`);
    expect(registry).toContain(`id: T-0001`);

    // AC-6: the brief file exists and the worktree is porcelain-clean
    // (.forge/task/ is git-excluded through the common dir's info/exclude).
    const briefInTree = await io.readFile(`${result.data!.worktree}/.forge/task/brief.md`);
    expect(briefInTree).toContain("forge/dispatch-brief@1");
    const exclude = await io.readFile(`${productRoot}/.git/info/exclude`);
    expect(exclude).toContain("/.forge/task/");
    const status = await gitExec(result.data!.worktree!, ["status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
  });

  it("AC-9: --dry-run validates but opens no branch and writes nothing", async () => {
    const { systemRoot, productRoot } = await dispatchFixture();
    const result = await runSystemTaskDispatch(
      input({ task: "T-0001", "dry-run": true }),
      makeContext(systemRoot),
    );
    expect(result.exitCode).toBe(0);
    const branches = await gitExec(productRoot, ["branch", "--list", "auto/*"]);
    expect(branches.stdout.trim()).toBe("");
    const io = (await import("../../../src/utils/io.ts")).resolveIo(undefined);
    const { task } = await readTask(systemRoot, io, "T-0001");
    expect(task!.state).toBe("ready");
  });

  it("AC-7: a forbidden contract edge refuses dispatch (SYSTEM-TASK-03)", async () => {
    const { systemRoot, productRoot } = await dispatchFixture({
      "system/edges.yaml": `schema: forge/system-edges@1
allowed: []
forbidden:
  - consumer: alpha
    contract: secret-contract
    reason: never
`,
      "queue/tasks/T-0001.yaml": taskYaml({ state: "ready", contracts: ["secret-contract"] }),
    });
    const result = await runSystemTaskDispatch(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-03")).toBe(true);
    const branches = await gitExec(productRoot, ["branch", "--list", "auto/*"]);
    expect(branches.stdout.trim()).toBe("");
  });

  it("undeclared contract edge warns (SYSTEM-TASK-04) but dispatches", async () => {
    const { systemRoot } = await dispatchFixture({
      "queue/tasks/T-0001.yaml": taskYaml({ state: "ready", contracts: ["undeclared-x"] }),
    });
    const result = await runSystemTaskDispatch(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-04")).toBe(true);
    expect(result.data?.dispatched).toBe(true);
  });

  it("AC-8: a brief leaking the system id refuses (SYSTEM-TASK-06)", async () => {
    const { systemRoot, productRoot } = await dispatchFixture();
    // Embed the system id (demo-system) in the brief body.
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    await writeFile(
      path.join(systemRoot, "queue/briefs/T-0001.md"),
      readyBrief() + "\nContext: the demo-system repository wants this.\n",
    );
    const result = await runSystemTaskDispatch(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-06")).toBe(true);
    const branches = await gitExec(productRoot, ["branch", "--list", "auto/*"]);
    expect(branches.stdout.trim()).toBe("");
  });

  it("a brief leaking another product's folder refuses (SYSTEM-TASK-06)", async () => {
    const beta = await makeProduct("forge-beta-");
    const { systemRoot } = await dispatchFixture({
      "system/products.local.yaml": localMapFor({ alpha: (await makeProduct()), beta }),
      "queue/briefs/T-0001.md": readyBrief() + `\nSibling checkout: ${beta}\n`,
    });
    const result = await runSystemTaskDispatch(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-06")).toBe(true);
  });

  it("dispatch refuses a non-ready task (SYSTEM-TASK-02)", async () => {
    const { systemRoot } = await dispatchFixture({
      "queue/tasks/T-0001.yaml": taskYaml({ state: "proposed" }),
    });
    const result = await runSystemTaskDispatch(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-02")).toBe(true);
  });

  it("dispatch refuses a product without a local folder (SYSTEM-TASK-05)", async () => {
    const { systemRoot } = await dispatchFixture({
      "system/products.local.yaml": localMapFor({ beta: "./beta" }),
    });
    const result = await runSystemTaskDispatch(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-05")).toBe(true);
  });

  it("AC-10: launcher argv substitutes {worktree} and {task}", async () => {
    const productRoot = await makeProduct();
    const log = `${productRoot}/launcher.log`;
    const systemRoot = await makeSystemRepo({
      "system/system.yaml": VALID_SYSTEM_YAML,
      "system/products.yaml": VALID_PRODUCTS_YAML,
      "system/edges.yaml": VALID_EDGES_YAML,
      "system/products.local.yaml": localMapFor(
        { alpha: productRoot },
        ["sh", "-c", `echo "$1|$2" > ${log}`, "sh", "{worktree}", "{task}"],
      ),
      "beta/.gitkeep": "",
      "queue/tasks/T-0001.yaml": taskYaml({ state: "ready" }),
      "queue/briefs/T-0001.md": readyBrief(),
    });
    const result = await runSystemTaskDispatch(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data?.launcherRan).toBe(true);
    expect(result.data?.launcherExit).toBe(0);
    const { readFile } = await import("node:fs/promises");
    const logged = await readFile(log, "utf8");
    expect(logged.trim()).toBe(`${result.data!.worktree}|T-0001`);
  });

  it("launcher non-zero exit warns SYSTEM-TASK-09 but the task stays dispatched", async () => {
    const productRoot = await makeProduct();
    const systemRoot = await makeSystemRepo({
      "system/system.yaml": VALID_SYSTEM_YAML,
      "system/products.yaml": VALID_PRODUCTS_YAML,
      "system/edges.yaml": VALID_EDGES_YAML,
      "system/products.local.yaml": localMapFor({ alpha: productRoot }, ["sh", "-c", "exit 3"]),
      "beta/.gitkeep": "",
      "queue/tasks/T-0001.yaml": taskYaml({ state: "ready" }),
      "queue/briefs/T-0001.md": readyBrief(),
    });
    const result = await runSystemTaskDispatch(input({ task: "T-0001" }), makeContext(systemRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data?.dispatched).toBe(true);
    expect(result.data?.launcherExit).toBe(3);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-09" && d.severity === "warning")).toBe(true);
  });
});
