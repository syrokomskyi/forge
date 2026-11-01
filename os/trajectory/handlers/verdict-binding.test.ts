/*
<MODULE_CONTRACT>
<purpose>RFC-1475 verdict-binding tests — verdictRef resolves to a concrete artifact/field (AC-1), TRAJ-04 drops units whose binding no longer resolves green (AC-2).</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTrajectoryIndex } from "./trajectory-index.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";

let root: string;

function ctx(): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    outputFormat: "json",
    logger: { info() {}, warn() {}, error() {}, success() {}, section() {} },
  } as unknown as ForgeRuntimeContext;
}

function flags(f: Record<string, unknown> = {}) {
  return { argv: [], flags: f } as never;
}

async function writeSession(name: string, frontmatter: string): Promise<void> {
  await writeFile(join(root, "docs", "sessions", name), `---\n${frontmatter}\n---\nbody\n`);
}

async function writeShard(units: unknown[]): Promise<string> {
  const rel = "docs/.index/trajectory/incoming-shard.yaml";
  await mkdir(join(root, "docs", ".index", "trajectory"), { recursive: true });
  const { stringify } = await import("yaml");
  await writeFile(join(root, rel), stringify({ schema: "forge/trajectory-shard@1", units }) + "\n");
  return rel;
}

function vendoredUnit(overrides: Record<string, unknown> = {}) {
  return {
    id: "trajectory:vendored-1",
    kind: "trajectory",
    situation: { taskKind: "deploy", touchedPathClasses: ["packages/x"], recentActions: ["deploy"] },
    continuation: { commandSequence: ["leitstand.ship"], decisions: [], outcomeHash: "abc123" },
    producer: {
      workshopId: "other-shop",
      sessionId: "vendored-1",
      completedAt: "2026-10-01",
      verdictRef: "verdict:green",
      sessionClass: "adhoc",
      origin: "vendored",
      ...((overrides.producer as object) ?? {}),
    },
    source: "shard",
    tokens: 10,
    text: "vendored",
    usedBy: { recalled: 0, helped: 0, hurt: 0 },
    utilityScore: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trajectory-verdict-"));
  await mkdir(join(root, "docs", "sessions"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("verdictRef binding (RFC-1475 AC-1)", () => {
  test("mission session with green evidence binds the artifact path", async () => {
    await mkdir(join(root, "missions", "dp7", "evidence"), { recursive: true });
    await writeFile(join(root, "missions", "dp7", "evidence", "validation-report.json"), JSON.stringify({ verdict: "green" }));
    await writeSession("2026-10-30-12-00-00-aaaaaa.md", `id: s-mission
types: [mission]
commits: [abc123]
files: [missions/dp7/wip.md]
date: 2026-10-30`);
    await runTrajectoryIndex(flags({}), ctx());
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    expect(index).toContain("verdictRef: missions/dp7/evidence/validation-report.json");
    expect(index).not.toContain("commits:");
  });

  test("explicit frontmatter verdict binds verdict:<value>", async () => {
    await writeSession("2026-10-30-12-00-00-aaaaaa.md", `id: s-green
verdict: green
taskKind: reconcile
commands: [mission.reconcile]
date: 2026-10-30`);
    await runTrajectoryIndex(flags({}), ctx());
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    expect(index).toContain("verdictRef: verdict:green");
    expect(index).not.toContain("commits:0");
  });

  test("commits-signal session binds signal:commits — never a literal count", async () => {
    await writeSession("2026-10-30-12-00-00-aaaaaa.md", `id: s-commits
commits: [abc123, def456]
commands: [mission.close]
date: 2026-10-30`);
    await runTrajectoryIndex(flags({}), ctx());
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    expect(index).toContain("verdictRef: signal:commits");
    expect(index).not.toContain("commits:2");
  });

  test("non-green mission evidence demotes to commits-signal admission", async () => {
    await mkdir(join(root, "missions", "dp7", "evidence"), { recursive: true });
    await writeFile(join(root, "missions", "dp7", "evidence", "validation-report.json"), JSON.stringify({ verdict: "red" }));
    await writeSession("2026-10-30-12-00-00-aaaaaa.md", `id: s-demoted
verdict: green
types: [mission]
commits: [abc123]
files: [missions/dp7/wip.md]
date: 2026-10-30`);
    const res = await runTrajectoryIndex(flags({}), ctx());
    expect(res.data?.admitted).toBe(1);
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    expect(index).toContain("verdictRef: signal:commits");
    expect(index).not.toContain("verdict:green");
  });

  test("non-green mission evidence without a commits signal rejects the session", async () => {
    await mkdir(join(root, "missions", "dp7", "evidence"), { recursive: true });
    await writeFile(join(root, "missions", "dp7", "evidence", "validation-report.json"), JSON.stringify({ verdict: "red" }));
    await writeSession("2026-10-30-12-00-00-aaaaaa.md", `id: s-red-mission
verdict: green
types: [mission]
files: [missions/dp7/wip.md]
date: 2026-10-30`);
    const res = await runTrajectoryIndex(flags({}), ctx());
    expect(res.data?.admitted).toBe(0);
    expect(res.data?.rejected).toBe(1);
  });
});

describe("TRAJ-04 rebuild drop (RFC-1475 AC-2)", () => {
  test("vendored unit with an unresolvable artifact verdictRef is dropped", async () => {
    await writeSession("2026-10-30-12-00-00-aaaaaa.md", `id: s-green
verdict: green
taskKind: reconcile
commands: [mission.reconcile]
date: 2026-10-30`);
    const shard = await writeShard([
      vendoredUnit({ producer: { workshopId: "other-shop", sessionId: "v1", completedAt: "2026-10-01", verdictRef: "missions/gone/evidence/validation-report.json", sessionClass: "adhoc", origin: "vendored" } }),
    ]);
    const res = await runTrajectoryIndex(flags({ import: shard }), ctx());
    expect(res.data?.dropped).toBe(1);
    expect(res.data?.diagnostics?.[0]?.ruleId).toBe("TRAJ-04");
    expect(res.summary).toContain("TRAJ-04");
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    expect(index).not.toContain("trajectory:vendored-1");
  });

  test("verdictRef escaping the workspace root is unresolvable — unit dropped (confinement)", async () => {
    await writeSession("2026-10-30-12-00-00-aaaaaa.md", `id: s-green
verdict: green
taskKind: reconcile
commands: [mission.reconcile]
date: 2026-10-30`);
    const shard = await writeShard([
      vendoredUnit({ id: "trajectory:escape", producer: { workshopId: "other-shop", sessionId: "v1", completedAt: "2026-10-01", verdictRef: "../../outside.json", sessionClass: "adhoc", origin: "vendored" } }),
      vendoredUnit({ id: "trajectory:absolute", producer: { workshopId: "other-shop", sessionId: "v2", completedAt: "2026-10-01", verdictRef: "/etc/passwd", sessionClass: "adhoc", origin: "vendored" } }),
    ]);
    const res = await runTrajectoryIndex(flags({ import: shard }), ctx());
    expect(res.data?.dropped).toBe(2);
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    expect(index).not.toContain("trajectory:escape");
    expect(index).not.toContain("trajectory:absolute");
  });

  test("vendored units with resolvable bindings survive — verdict:<green> and signal:commits exempt", async () => {
    await writeSession("2026-10-30-12-00-00-aaaaaa.md", `id: s-green
verdict: green
taskKind: reconcile
commands: [mission.reconcile]
date: 2026-10-30`);
    const shard = await writeShard([
      vendoredUnit({ id: "trajectory:vendored-1" }),
      vendoredUnit({ id: "trajectory:vendored-2", producer: { workshopId: "other-shop", sessionId: "v2", completedAt: "2026-10-01", verdictRef: "signal:commits", sessionClass: "adhoc", origin: "vendored" } }),
    ]);
    const res = await runTrajectoryIndex(flags({ import: shard }), ctx());
    expect(res.data?.dropped).toBe(0);
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    expect(index).toContain("trajectory:vendored-1");
    expect(index).toContain("trajectory:vendored-2");
  });

  test("evidence file flipped red post-admission rejects the session on the next rebuild", async () => {
    await mkdir(join(root, "missions", "dp7", "evidence"), { recursive: true });
    const evidence = join(root, "missions", "dp7", "evidence", "validation-report.json");
    await writeFile(evidence, JSON.stringify({ verdict: "green" }));
    await writeSession("2026-10-30-12-00-00-aaaaaa.md", `id: s-mission
types: [mission]
commits: []
files: [missions/dp7/wip.md]
date: 2026-10-30`);
    const first = await runTrajectoryIndex(flags({}), ctx());
    expect(first.data?.units).toBe(1);
    await writeFile(evidence, JSON.stringify({ verdict: "red" }));
    const second = await runTrajectoryIndex(flags({}), ctx());
    expect(second.data?.units).toBe(0);
    expect(second.data?.rejected).toBe(1);
  });
});
