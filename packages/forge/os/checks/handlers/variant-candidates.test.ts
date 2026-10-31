/*
<MODULE_CONTRACT>
<purpose>RFC-1473 variantCandidates tests — rules with ≥1 unique emitted finding join the variant-candidate list for sibling sweeps; silent/redundant rules are excluded.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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
  root = await mkdtemp(join(tmpdir(), "variant-"));
  await mkdir(join(root, "docs", "sessions", "audit"), { recursive: true });
  await mkdir(join(root, "docs", "metrics"), { recursive: true });
  await writeFile(
    join(root, "docs", "validator-inventory.generated.yaml"),
    `contracts:
  - contract: knowledge
    validators:
      - rules:
          - id: FIRED-01
            severity: error
          - id: QUIET-01
            severity: error
`,
  );
  await writeFile(join(root, "docs", "frictions.yaml"), "frictions: []\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("variantCandidates (RFC-1473)", () => {
  test("fired-with-unique-finding → candidate; silent rule excluded", async () => {
    await writeFile(
      join(root, "docs", "sessions", "audit", "s1.audit.yaml"),
      `sessionId: s1
findings:
  - ruleId: FIRED-01
    signature: "sig-x"
`,
    );
    const res = await runContributionReport(flags({}), ctx());
    expect(res.data?.variantCandidates.some((v) => v.rule === "FIRED-01" && v.siblingScope === "knowledge")).toBe(true);
    expect(res.data?.variantCandidates.some((v) => v.rule === "QUIET-01")).toBe(false);
  });
});
