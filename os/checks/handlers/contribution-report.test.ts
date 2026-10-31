/*
<MODULE_CONTRACT>
<purpose>RFC-1473 checks.contribution.report tests — per-rule contribution records (emitted/uniqueEmitted/zeroStreak/escapeCount/verdict), silent/redundant/guard classification, metrics artifact written.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runContributionReport } from "./contribution-report.ts";
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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "contribution-"));
  await mkdir(join(root, "docs", "sessions", "audit"), { recursive: true });
  await mkdir(join(root, "docs", "metrics"), { recursive: true });
  await writeFile(
    join(root, "docs", "validator-inventory.generated.yaml"),
    `contracts:
  - contract: knowledge
    validators:
      - rules:
          - id: SKILL-19
            severity: error
          - id: KAUTHZ-01
            severity: error
          - id: NEVER-FIRE-99
            severity: error
`,
  );
  await writeFile(join(root, "docs", "frictions.yaml"), `- id: F-0099
  category: tooling
  recurrences: 2
`);
  await writeFile(join(root, "forge.yaml"), `schema: forge/config@1
checksContribution:
  contractMappings:
    tooling: knowledge
  guardRules: [PROBE-01]
`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checks.contribution.report (RFC-1473)", () => {
  test("per-rule records: fired rules earn, never-fired are silent, escapes counted", async () => {
    // Seed a firing history: SKILL-19 fires once, KAUTHZ-01 never, NEVER-FIRE-99 never.
    await writeFile(
      join(root, "docs", "sessions", "audit", "s1.audit.yaml"),
      `sessionId: s1
findings:
  - ruleId: SKILL-19
    signature: "sig-abc"
`,
    );
    const res = await runContributionReport(flags({}), ctx());
    const skill = res.data?.rules.find((r) => r.ruleId === "SKILL-19");
    const never = res.data?.rules.find((r) => r.ruleId === "NEVER-FIRE-99");
    expect(skill?.emitted).toBe(1);
    expect(skill?.verdict).toBe("earning");
    expect(never?.emitted).toBe(0);
    expect(never?.verdict).toBe("silent");
    expect(never?.escapeCount).toBe(1);
    expect(res.data?.variantCandidates.some((v) => v.rule === "SKILL-19")).toBe(true);
  });

  test("metrics artifact written; --check diffs vs committed for staleness", async () => {
    await runContributionReport(flags({}), ctx());
    const metrics = await readFile(join(root, "docs", "metrics", "check-contribution.generated.yaml"), "utf8").catch(() => "");
    expect(metrics).toContain("check-contribution@1");
    const fresh = await runContributionReport(flags({ check: true }), ctx());
    expect(fresh.exitCode).toBe(0);
    // A sidecar addition changes the computed output → --check flags stale.
    await writeFile(
      join(root, "docs", "sessions", "audit", "s2.audit.yaml"),
      `sessionId: s2\nfindings:\n  - ruleId: SKILL-19\n    signature: "sig-new"\nauditedAt: "2026-11-01"\n`,
    );
    const stale = await runContributionReport(flags({ check: true }), ctx());
    expect(stale.exitCode).toBe(1);
    expect(stale.summary).toContain("CONTRIB-02");
  });

  test("CONTRIB-01: missing inventory blocks, not a silent empty report", async () => {
    await rm(join(root, "docs", "validator-inventory.generated.yaml"));
    const res = await runContributionReport(flags({}), ctx());
    expect(res.exitCode).toBe(1);
    expect(res.summary).toContain("CONTRIB-01");
  });
});
