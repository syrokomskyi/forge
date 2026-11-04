/*
<MODULE_CONTRACT>
<purpose>RFC-1509 acceptance tests for system.task.create and
system.task.move — id allocation, schema refusals, the transition table,
ready-checks (brief, dependencies, edges) and the version-set gate.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1509: step 5 — create/move acceptance tests</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
  <item>RFC-1511: accept recorded products map in verified gate, guard folders lookup and exec edges (RFC-1511 review r1)</item>
  <item>RFC-1511: use schema-shaped version-set fixture, record r2 deviations (RFC-1511 review r2)</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { describe, expect, it } from "vitest";

import { runSystemTaskCreate } from "../handlers/system-task-create.ts";
import { runSystemTaskMove } from "../handlers/system-task-move.ts";
import { readTask } from "../task-store.ts";
import {
  localMapFor,
  makeContext,
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

const CREATE_FLAGS = {
  product: "alpha",
  slug: "wire-alpha",
  title: "Wire alpha",
  kind: "change",
};

async function repoWithMap(extra: Record<string, string> = {}) {
  return makeSystemRepo({
    "system/system.yaml": VALID_SYSTEM_YAML,
    "system/products.yaml": VALID_PRODUCTS_YAML,
    "system/edges.yaml": VALID_EDGES_YAML,
    "system/products.local.yaml": localMapFor({ alpha: "./alpha", beta: "./beta" }),
    "alpha/.gitkeep": "",
    "beta/.gitkeep": "",
    ...extra,
  });
}

describe("system.task.create", () => {
  it("AC-1: two creates allocate sequential T-NNNN ids", async () => {
    const root = await repoWithMap();
    const ctx = makeContext(root);
    const first = await runSystemTaskCreate(input({ ...CREATE_FLAGS }), ctx);
    const second = await runSystemTaskCreate(
      input({ ...CREATE_FLAGS, slug: "wire-alpha-two", title: "Wire alpha two" }),
      ctx,
    );
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.data?.task).toBe("T-0001");
    expect(second.data?.task).toBe("T-0002");
  });

  it("AC-1: create writes task file + brief scaffold under queue/", async () => {
    const root = await repoWithMap();
    const result = await runSystemTaskCreate(input({ ...CREATE_FLAGS }), makeContext(root));
    expect(result.exitCode).toBe(0);
    const { task } = await readTask(root, (await import("../../../src/utils/io.ts")).resolveIo(undefined), "T-0001");
    expect(task).not.toBeNull();
    expect(task!.state).toBe("proposed");
    expect(task!.brief).toBe("queue/briefs/T-0001.md");
    expect(result.data?.files.some((f) => f.endsWith("queue/briefs/T-0001.md"))).toBe(true);
  });

  it("create --dry-run writes nothing", async () => {
    const root = await repoWithMap();
    const result = await runSystemTaskCreate(
      input({ ...CREATE_FLAGS, "dry-run": true }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(0);
    const io = (await import("../../../src/utils/io.ts")).resolveIo(undefined);
    const { task } = await readTask(root, io, "T-0001");
    expect(task).toBeNull();
  });

  it("create refuses a product missing from products.yaml (SYSTEM-TASK-05)", async () => {
    const root = await repoWithMap();
    const result = await runSystemTaskCreate(
      input({ ...CREATE_FLAGS, product: "gamma" }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-05")).toBe(true);
  });

  it("create refuses outside the system profile (SYSTEM-01)", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-nonsys-"));
    await writeFile(path.join(root, "forge.yaml"), "profile: typescript\n");
    const result = await runSystemTaskCreate(input({ ...CREATE_FLAGS }), makeContext(root));
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-01")).toBe(true);
  });
});

describe("system.task.move", () => {
  it("AC-2: an illegal transition returns SYSTEM-TASK-02", async () => {
    const root = await repoWithMap({
      "queue/tasks/T-0001.yaml": taskYaml({ state: "proposed" }),
    });
    const result = await runSystemTaskMove(
      input({ task: "T-0001", to: "verified" }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-02")).toBe(true);
  });

  it("AC-2: a transition owned by dispatch refuses through move", async () => {
    const root = await repoWithMap({
      "queue/tasks/T-0001.yaml": taskYaml({ state: "ready" }),
    });
    const result = await runSystemTaskMove(
      input({ task: "T-0001", to: "dispatched" }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(1);
    expect(
      result.data?.diagnostics.some(
        (d) => d.ruleId === "SYSTEM-TASK-02" && d.message.includes("dispatch"),
      ),
    ).toBe(true);
  });

  it("AC-3: an incomplete dependency blocks proposed → ready", async () => {
    const root = await repoWithMap({
      "queue/tasks/T-0001.yaml": taskYaml({ dependsOn: ["T-0002"] }),
      "queue/tasks/T-0002.yaml": taskYaml({ id: "T-0002", state: "dispatched" }),
      "queue/briefs/T-0001.md": readyBrief(),
    });
    const result = await runSystemTaskMove(
      input({ task: "T-0001", to: "ready" }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(1);
    const diag = result.data?.diagnostics.find((d) => d.ruleId === "SYSTEM-TASK-02");
    expect(diag?.message).toContain("T-0002");
  });

  it("proposed → ready succeeds with valid brief, done deps and no forbidden edge", async () => {
    const root = await repoWithMap({
      "queue/tasks/T-0001.yaml": taskYaml({ dependsOn: ["T-0002"], contracts: ["alpha-contract"] }),
      "queue/tasks/T-0002.yaml": taskYaml({ id: "T-0002", state: "done" }),
      "queue/briefs/T-0001.md": readyBrief(),
    });
    const result = await runSystemTaskMove(
      input({ task: "T-0001", to: "ready" }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data?.moved).toBe(true);
    const { task } = await readTask(
      root,
      (await import("../../../src/utils/io.ts")).resolveIo(undefined),
      "T-0001",
    );
    expect(task!.state).toBe("ready");
    expect(task!.history.at(-1)?.to).toBe("ready");
  });

  it("proposed → ready refuses on a forbidden contract edge (SYSTEM-TASK-03)", async () => {
    const root = await repoWithMap({
      "system/edges.yaml": `schema: forge/system-edges@1
allowed: []
forbidden:
  - consumer: alpha
    contract: secret-contract
    reason: alpha must not touch it
`,
      "queue/tasks/T-0001.yaml": taskYaml({ contracts: ["secret-contract"] }),
      "queue/briefs/T-0001.md": readyBrief(),
    });
    const result = await runSystemTaskMove(
      input({ task: "T-0001", to: "ready" }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-03")).toBe(true);
  });

  it("proposed → ready warns on an undeclared contract edge (SYSTEM-TASK-04) but moves", async () => {
    const root = await repoWithMap({
      "queue/tasks/T-0001.yaml": taskYaml({ contracts: ["undeclared-contract"] }),
      "queue/briefs/T-0001.md": readyBrief(),
    });
    const result = await runSystemTaskMove(
      input({ task: "T-0001", to: "ready" }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-04" && d.severity === "warning")).toBe(true);
    expect(result.data?.moved).toBe(true);
  });

  it("proposed → ready refuses while the brief goal is the create placeholder", async () => {
    const root = await repoWithMap();
    // create writes T-0001 task + brief scaffold with the placeholder goal.
    await runSystemTaskCreate(input({ ...CREATE_FLAGS }), makeContext(root));
    const result = await runSystemTaskMove(
      input({ task: "T-0001", to: "ready" }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(1);
    expect(
      result.data?.diagnostics.some(
        (d) => d.ruleId === "SYSTEM-TASK-02" && d.message.includes("placeholder"),
      ),
    ).toBe(true);
  });

  it("ready → parked requires --reason", async () => {
    const root = await repoWithMap({
      "queue/tasks/T-0001.yaml": taskYaml({ state: "ready" }),
    });
    const without = await runSystemTaskMove(
      input({ task: "T-0001", to: "parked" }),
      makeContext(root),
    );
    expect(without.exitCode).toBe(1);
    const withReason = await runSystemTaskMove(
      input({ task: "T-0001", to: "parked", reason: "operator stepped away" }),
      makeContext(root),
    );
    expect(withReason.exitCode).toBe(0);
    const io = (await import("../../../src/utils/io.ts")).resolveIo(undefined);
    const { task } = await readTask(root, io, "T-0001");
    expect(task!.state).toBe("parked");
    expect(task!.history.at(-1)?.reason).toBe("operator stepped away");
  });

  it("verified → done needs no extra check", async () => {
    const root = await repoWithMap({
      "queue/tasks/T-0001.yaml": taskYaml({ state: "verified" }),
    });
    const result = await runSystemTaskMove(
      input({ task: "T-0001", to: "done" }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data?.moved).toBe(true);
  });

  it("integrated → verified requires --version-set listing the product", async () => {
    const root = await repoWithMap({
      "queue/tasks/T-0001.yaml": taskYaml({ state: "integrated" }),
      "system/version-sets/VS-0001.yaml": "schema: forge/version-set@1\nid: VS-0001\nproducts: [beta]\n",
    });
    const missing = await runSystemTaskMove(
      input({ task: "T-0001", to: "verified" }),
      makeContext(root),
    );
    expect(missing.exitCode).toBe(1);
    const wrongSet = await runSystemTaskMove(
      input({ task: "T-0001", to: "verified", "version-set": "VS-0001" }),
      makeContext(root),
    );
    expect(wrongSet.exitCode).toBe(1);
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    await writeFile(
      path.join(root, "system/version-sets/VS-0001.yaml"),
      "schema: forge/version-set@1\nid: VS-0001\nproducts: [alpha, beta]\n",
    );
    const ok = await runSystemTaskMove(
      input({ task: "T-0001", to: "verified", "version-set": "VS-0001" }),
      makeContext(root),
    );
    expect(ok.exitCode).toBe(0);
    expect(ok.data?.moved).toBe(true);
  });

  it("integrated → verified accepts the recorded { id: tag } products map (RFC-1511)", async () => {
    const root = await repoWithMap({
      "queue/tasks/T-0001.yaml": taskYaml({ state: "integrated" }),
      "system/version-sets/VS-0007.yaml":
        "schema: forge/version-set@1\nid: VS-0007\nverifiedAt: 2026-11-04T00:00:00.000Z\nproducts:\n  alpha: v1.0.0\nscenarios: [scenario-a]\nevidence:\n  scenario-a: sha256:0000000000000000000000000000000000000000000000000000000000000000\n",
    });
    const ok = await runSystemTaskMove(
      input({ task: "T-0001", to: "verified", "version-set": "VS-0007" }),
      makeContext(root),
    );
    expect(ok.exitCode).toBe(0);
    expect(ok.data?.moved).toBe(true);
  });

  it("move --dry-run validates but writes nothing", async () => {
    const root = await repoWithMap({
      "queue/tasks/T-0001.yaml": taskYaml({ state: "verified" }),
    });
    const result = await runSystemTaskMove(
      input({ task: "T-0001", to: "done", "dry-run": true }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(0);
    const io = (await import("../../../src/utils/io.ts")).resolveIo(undefined);
    const { task } = await readTask(root, io, "T-0001");
    expect(task!.state).toBe("verified");
  });

  it("unknown task id refuses with SYSTEM-TASK-01", async () => {
    const root = await repoWithMap();
    const result = await runSystemTaskMove(
      input({ task: "T-9999", to: "ready" }),
      makeContext(root),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data?.diagnostics.some((d) => d.ruleId === "SYSTEM-TASK-01")).toBe(true);
  });
});
