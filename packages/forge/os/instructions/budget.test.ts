/*
<MODULE_CONTRACT>
<purpose>RFC-1466 instructions tests — AC-3 (over-budget → INSTR-01), AC-4 (scar.migrate → fragment entry + bullet removed + catalogRefs), AC-5 (invariant-shaped bullet → blocking refusal).</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as yamlParse } from "yaml";
import { runInstructionsBudgetValidate } from "./handlers/budget-validate.ts";
import { runScarMigrate } from "./handlers/scar-migrate.ts";
import type { ForgeRuntimeContext } from "../../src/types.ts";

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

async function seed(budgetYaml = true, agentsBody = "## Section A\n- a scar bullet Discovered during RFC-1400 fo-fix\n") {
  await writeFile(
    join(root, "forge.yaml"),
    `schema: forge/config@1\n${budgetYaml ? "instructions:\n  budget:\n    maxLinesPerFile: 3\n    maxTokensPerFile: 40\n    exemptSections:\n      - Verbund\n" : ""}`,
  );
  await writeFile(join(root, "AGENTS.md"), agentsBody);
  await mkdir(join(root, "docs"), { recursive: true });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "instr-budget-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("instructions.budget.validate (RFC-1466)", () => {
  test("AC-3: file over declared budget → INSTR-01", async () => {
    await seed(true, Array.from({ length: 10 }, (_, i) => `- line ${i}`).join("\n") + "\n");
    const res = await runInstructionsBudgetValidate(flags({}), ctx());
    expect(res.data?.diagnostics.some((d) => d.ruleId === "INSTR-01")).toBe(true);
  });

  test("INSTR-02: scar in exempt section is informational-only", async () => {
    await seed(true, `## Verbund\n- scar bullet Discovered during RFC-1400\n`);
    const res = await runInstructionsBudgetValidate(flags({}), ctx());
    expect(res.data?.diagnostics.some((d) => d.ruleId === "INSTR-02")).toBe(true);
  });

  test("INSTR-03: migrated scar still present → flagged", async () => {
    await seed(true, `- scar bullet Discovered during RFC-1400\n`);
    await writeFile(
      join(root, "docs", "remediation-catalog.custom.yaml"),
      `entries:\n  - id: SCAR-0001\n    ruleText: "scar bullet Discovered during RFC-1400"\n    migratedFrom: AGENTS.md:1\n    migratedAt: t\n    originLine: 1\n`,
    );
    const res = await runInstructionsBudgetValidate(flags({}), ctx());
    expect(res.data?.diagnostics.some((d) => d.ruleId === "INSTR-03")).toBe(true);
  });
});

describe("scar.migrate (RFC-1466)", () => {
  test("AC-4: bound scar bullet → fragment entry + bullet removed + catalogRefs on friction", async () => {
    await seed();
    await writeFile(
      join(root, "docs", "frictions.yaml"),
      `# authored header comment\n- id: F-0007\n  created: "2026-01-01"\n  session: s\n  category: tooling\n  friction: x\n  signature: y\n  measure: z\n  artifacts: []\n  status: open\n  recurrences: 1\n  lastSeen: "2026-01-01"\n`,
    );
    const res = await runScarMigrate(
      flags({ file: "AGENTS.md", line: 2, friction: "F-0007", "diagnostic-codes": "FOO-01" }),
      ctx(),
    );
    expect(res.data?.status).toBe("migrated");
    expect(res.data?.entryId).toMatch(/^SCAR-/);
    const fragment = yamlParse(
      await readFile(join(root, "docs", "remediation-catalog.custom.yaml"), "utf8"),
    );
    expect(fragment.entries[0].ruleText).toContain("Discovered during");
    expect(fragment.entries[0].diagnosticCodes).toContain("FOO-01");
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).not.toContain("scar bullet");
    const frictions = await readFile(join(root, "docs", "frictions.yaml"), "utf8");
    expect(frictions).toContain("# authored header comment");
    expect(frictions).toContain(`catalogRefs: [${res.data!.entryId}]`);
  });

  test("unbound remedy keeps the bullet with a pending marker (F-2 ordering)", async () => {
    await seed();
    const res = await runScarMigrate(flags({ file: "AGENTS.md", line: 2 }), ctx());
    expect(res.data?.status).toBe("migrated");
    expect(res.data?.pending).toBe(true);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain(`<!-- migrates-to: ${res.data!.entryId} pending -->`);
    expect(agents).toContain("scar bullet");
    // --force removes the prose even when unbound
    const forced = await runScarMigrate(flags({ file: "AGENTS.md", line: 2, force: true }), ctx());
    expect(forced.data?.status).toBe("migrated");
    const after = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(after).not.toContain("scar bullet");
  });

  test("AC-5: invariant-shaped bullet refuses without --force (journaled)", async () => {
    await seed(true, `## Verbund\n- MUST never stash Discovered during incident\n`);
    const res = await runScarMigrate(flags({ file: "AGENTS.md", line: 2 }), ctx());
    expect(res.data?.status).toBe("refused");
    expect(res.exitCode).toBe(1);
    const fragment = yamlParse(
      await readFile(join(root, "docs", "remediation-catalog.custom.yaml"), "utf8"),
    );
    expect(fragment.entries).toHaveLength(0);
    expect(fragment.refusals).toHaveLength(1);
    // --force overrides
    const forced = await runScarMigrate(flags({ file: "AGENTS.md", line: 2, force: true }), ctx());
    expect(forced.data?.status).toBe("migrated");
  });
});
