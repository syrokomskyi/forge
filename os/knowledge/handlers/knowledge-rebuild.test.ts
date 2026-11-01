/*
<MODULE_CONTRACT>
<purpose>RFC-1468 knowledge.rebuild tests — marker-region rewrite from source rows, --check drift detection (orphan/missing), human-owned content outside markers untouched.</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-os-tail</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runKnowledgeRebuild } from "./knowledge-rebuild.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";

let root: string;

function ctx(): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    outputFormat: "json",
    logger: { info() {}, warn() {}, error() {}, success() {}, section() {} },
  } as unknown as ForgeRuntimeContext;
}

function flags(f: Record<string, unknown>) {
  return { argv: [], flags: f } as never;
}

const TARGET = `Human-owned intro — never touched.

<!-- knowledge-rebuild:begin source=remediation-catalog -->
- **STALE-01** — old rule
<!-- knowledge-rebuild:end -->

Human-owned outro.`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "knowledge-rebuild-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, ".agents", "memory"), { recursive: true });
  await writeFile(
    join(root, "docs", "remediation-catalog.generated.yaml"),
    `entries:
  - ruleId: SKILL-19
    action: "run skills.validate"
  - ruleId: GATE-01
    action: "run gate check"
`,
  );
  await writeFile(join(root, ".agents", "memory", "MEMORY.md"), TARGET);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("knowledge.rebuild (RFC-1468)", () => {
  test("AC-4: rebuild rewrites only inside the marker region from source rows", async () => {
    const res = await runKnowledgeRebuild(flags({ target: ".agents/memory/MEMORY.md" }), ctx());
    expect(res.data?.status).toBe("rebuilt");
    const out = await readFile(join(root, ".agents", "memory", "MEMORY.md"), "utf8");
    expect(out).toContain("**SKILL-19**");
    expect(out).toContain("**GATE-01**");
    expect(out).not.toContain("**STALE-01**");
    expect(out).toContain("Human-owned intro");
    expect(out).toContain("Human-owned outro");
  });

  test("AC-4: --check exits non-zero on drift and writes nothing", async () => {
    const res = await runKnowledgeRebuild(flags({ target: ".agents/memory/MEMORY.md", check: true }), ctx());
    expect(res.data?.status).toBe("drift");
    expect(res.data?.diagnostics.some((d) => d.ruleId === "REBUILD-ORPHAN")).toBe(true);
    expect(res.exitCode).toBe(1);
    const out = await readFile(join(root, ".agents", "memory", "MEMORY.md"), "utf8");
    expect(out).toContain("**STALE-01**"); // untouched
  });
});
