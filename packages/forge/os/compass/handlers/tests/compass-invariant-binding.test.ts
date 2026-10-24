/*
<MODULE_CONTRACT>
<purpose>
RFC-1390 acceptance fixtures for the invariant-binding ruleset: tagged
invariant parsing, checked-by binding resolution, baselined/grandfathered
semantics, and the COMPASS-INVARIANT-02..07 rule table over tmp workspaces.
</purpose>
<non-goals>
  <item>Fixture invariant markers are built via string concatenation so the real scanner never parses this file's literals — do not inline real marker strings.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1390: binding-rule fixtures — parser, resolvers, severity table, baseline keying.</item>
  <item>RFC-1390: bind code invariants to enforcing checks (INV-tags, checked-by, baseline, generator)</item>
</CHANGE_SUMMARY>
*/

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCompassValidation } from "../compass-inventory-handler.ts";
import {
  baselineSet,
  evaluateInvariantRules,
  extractInvariants,
  invariantStatementSha,
  resolveInvariantBindings,
} from "../invariant-bindings.ts";
import { writeForgeYaml } from "./forge-yaml-fixture.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../../src/types.ts";

function dataOf<T>(result: ForgeCommandResult<T>): T {
  if (!result.data) throw new Error("command returned no data payload");
  return result.data;
}

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    site: undefined,
    siteExplicit: false,
    dryRun: false,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as ForgeRuntimeContext;
}

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { flags } as ForgeCommandInput;
}

// Marker literal is split so the real scanner never parses fixture strings in
// THIS file as invariant declarations (same escape convention as MC_OPEN).
const AI_INV = "@ai-" + "invariant";

const MC_OPEN = "<" + "MODULE_CONTRACT>";
const MC_CLOSE = "</" + "MODULE_CONTRACT>";
const MC = (purpose: string) =>
  `${MC_OPEN}\n<purpose>${purpose}</purpose>\n<non-goals>\n  <item>Do not perform real validation — fixtures only.</item>\n</non-goals>\n${MC_CLOSE}`;
const CS_OPEN = "<" + "CHANGE_SUMMARY>";
const CS_CLOSE = "</" + "CHANGE_SUMMARY>";
const CS = (items: string[]) =>
  `${CS_OPEN}\n${items.map((i) => `  <item>${i}</item>`).join("\n")}\n${CS_CLOSE}`;
const wrap = (...blocks: string[]) => `/*\n${blocks.join("\n")}\n*/`;

// purpose must carry >=10 words AND a file-derived token (CONTRACT-02/PURPOSE-02);
// the parent directory name is a file-derived token for every fixture path.
function purposeFor(relPath: string): string {
  const parent = relPath.split("/").slice(-2, -1)[0] ?? "fixture";
  return `The ${parent} fixture projects invariant bindings for the RFC-1390 validation suite`;
}

const CS_ITEM = "RFC-1390: invariant binding fixture.";

// High-risk via the generic layer rule src/middleware/** → riskClass high.
const HIGH_FILE = "packages/fixture-pkg/src/middleware/guard.ts";
const LOW_FILE = "packages/fixture-pkg/src/content/notes.ts";
const TEST_FILE = "packages/fixture-pkg/src/tests/guard.pbt.test.ts";

describe("RFC-1390 invariant bindings", () => {
  let tempDir: string;

  function write(relPath: string, content: string): void {
    const abs = join(tempDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  function writeSource(relPath: string, invariantLine: string): void {
    write(
      relPath,
      `${wrap(MC(purposeFor(relPath)), CS([CS_ITEM]))}\n\n${invariantLine}\n\nexport const x = 1;\n`,
    );
  }

  async function validate() {
    return runCompassValidation(makeInput(), makeContext(tempDir));
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "compass-inv-"));
    writeForgeYaml(tempDir, "");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses id, statement and checked-by bindings from a tagged invariant", async () => {
    const parsed = extractInvariants(
      `// ${AI_INV}[INV-guard-01]: resolveWinner picks the same winner for any arrival order (checked-by: test:${TEST_FILE}, lint:COMPASS-INVARIANT-01)\nexport const x = 1;`,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe("INV-guard-01");
    expect(parsed[0]!.statement).toBe("resolveWinner picks the same winner for any arrival order");
    expect(parsed[0]!.rawBindings).toEqual([
      { kind: "test", target: TEST_FILE },
      { kind: "lint", target: "COMPASS-INVARIANT-01" },
    ]);
    expect(parsed[0]!.vacuous).toBe(false);
  });

  it("joins wrapped checked-by continuation comment lines", () => {
    const parsed = extractInvariants(
      [
        `// ${AI_INV}[INV-guard-02]: statement that wraps`,
        "// (checked-by:",
        "//   test:a/b.test.ts,",
        "//   type:a/b.type.test.ts)",
        "export const x = 1;",
      ].join("\n"),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.rawBindings).toEqual([
      { kind: "test", target: "a/b.test.ts" },
      { kind: "type", target: "a/b.type.test.ts" },
    ]);
  });

  it("reports COMPASS-INVARIANT-04 when the bound test file does not contain the invariant id", async () => {
    writeSource(
      HIGH_FILE,
      `// ${AI_INV}[INV-guard-03]: the guard always fails closed (checked-by: test:${TEST_FILE})`,
    );
    write(TEST_FILE, `// no invariant id here\nexport const t = 1;\n`);

    const result = await validate();
    const diags = dataOf(result).diagnostics.filter((d) => d.ruleId === "COMPASS-INVARIANT-04");
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.message).toContain("INV-guard-03");
  });

  it("resolves a bound test file containing the literal id — no COMPASS-INVARIANT-04", async () => {
    writeSource(
      HIGH_FILE,
      `// ${AI_INV}[INV-guard-04]: the guard always fails closed (checked-by: test:${TEST_FILE})`,
    );
    write(TEST_FILE, `// INV-guard-04 is asserted below\nit("INV-guard-04 holds", () => {});\n`);

    const result = await validate();
    const diags = dataOf(result).diagnostics.filter(
      (d) => d.ruleId === "COMPASS-INVARIANT-04" && d.file === HIGH_FILE,
    );
    expect(diags).toEqual([]);
  });

  it("reports COMPASS-INVARIANT-05 for a duplicate invariant id", async () => {
    writeSource(HIGH_FILE, `// ${AI_INV}[INV-dup-01]: first declaration of this duplicate id`);
    writeSource(
      "packages/fixture-pkg/src/middleware/other.ts",
      `// ${AI_INV}[INV-dup-01]: second declaration of this duplicate id`,
    );

    const result = await validate();
    const diags = dataOf(result).diagnostics.filter((d) => d.ruleId === "COMPASS-INVARIANT-05");
    expect(diags.length).toBeGreaterThanOrEqual(2);
    expect(diags.every((d) => d.severity === "error")).toBe(true);
    expect(diags[0]!.message).toContain("INV-dup-01");
  });

  it("blocks an unbound invariant in a high-risk file that is absent from the baseline", async () => {
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    writeFileSync(
      join(tempDir, "docs/invariants.baseline.generated.yaml"),
      `schema: "forge/invariant-baseline@1"\nentries: []\n`,
    );
    writeSource(HIGH_FILE, `// ${AI_INV}[INV-guard-05]: the guard always fails closed`);

    const result = await validate();
    const diags = dataOf(result).diagnostics.filter((d) => d.ruleId === "COMPASS-INVARIANT-06");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.message).toContain("high-risk");
    expect(result.exitCode).toBe(1);
  });

  it("warns COMPASS-INVARIANT-03 on a boilerplate invariant statement", async () => {
    writeSource(
      LOW_FILE,
      `// ${AI_INV}: This is a high-risk module. Preserve its core logic and minimize external side effects during modification.`,
    );

    const result = await validate();
    const diags = dataOf(result).diagnostics.filter((d) => d.ruleId === "COMPASS-INVARIANT-03");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("warning");
  });

  it("warns COMPASS-INVARIANT-02 on an unbound invariant that is baselined", async () => {
    const statement = "The guard keeps a deliberately unratified constraint for now";
    writeSource(LOW_FILE, `// ${AI_INV}: ${statement}`);
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    writeFileSync(
      join(tempDir, "docs/invariants.baseline.generated.yaml"),
      `schema: "forge/invariant-baseline@1"\nentries:\n  - path: "${LOW_FILE}"\n    statementSha256: "${invariantStatementSha(statement)}"\n`,
    );

    const result = await validate();
    const diags = dataOf(result).diagnostics.filter((d) => d.ruleId === "COMPASS-INVARIANT-02");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("warning");
    expect(result.exitCode).toBe(0);
  });

  it("reports COMPASS-INVARIANT-04 on a malformed id", async () => {
    writeSource(LOW_FILE, `// ${AI_INV}[INV-BADSHAPE]: the statement text goes on here`);

    const result = await validate();
    const diags = dataOf(result).diagnostics.filter(
      (d) => d.ruleId === "COMPASS-INVARIANT-04" && d.severity === "error",
    );
    expect(diags.some((d) => d.message.includes("malformed"))).toBe(true);
  });

  it("reports COMPASS-INVARIANT-05 when a retired id is reused", async () => {
    writeSource(LOW_FILE, `// ${AI_INV}[INV-gone-01]: a resurrected retired id`);
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    writeFileSync(
      join(tempDir, "docs/invariants.generated.yaml"),
      `schema: "forge/invariant-index@1"\ninvariants: []\nretiredIds:\n  - INV-gone-01\n`,
    );

    const result = await validate();
    const diags = dataOf(result).diagnostics.filter((d) => d.ruleId === "COMPASS-INVARIANT-05");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("never reused");
  });

  it("legacy untagged form still counts as an invariant and reports unbound", async () => {
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    writeFileSync(
      join(tempDir, "docs/invariants.baseline.generated.yaml"),
      `schema: "forge/invariant-baseline@1"\nentries: []\n`,
    );
    writeSource(LOW_FILE, `// ${AI_INV}: legacy prose invariant with enough words to pass vacuity`);

    const result = await validate();
    const diags = dataOf(result).diagnostics.filter(
      (d) => d.ruleId === "COMPASS-INVARIANT-06" && d.file === LOW_FILE,
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("warning"); // low-risk file → warning not error
  });

  it("baselineSet keys entries by path#sha", () => {
    const set = baselineSet({
      schema: "forge/invariant-baseline@1",
      entries: [{ path: "a/b.ts", statementSha256: "deadbeef" }],
    });
    expect(set.has("a/b.ts#deadbeef")).toBe(true);
  });

  it("resolveInvariantBindings marks bound and baselined correctly", async () => {
    write(TEST_FILE, `// INV-guard-09 asserted\nit("x", () => {});`);
    const parsed = extractInvariants(
      `// ${AI_INV}[INV-guard-09]: guard bound here (checked-by: test:${TEST_FILE})`,
    );
    const resolved = await resolveInvariantBindings(parsed, HIGH_FILE, "high", new Set(), {
      workspaceRoot: tempDir,
      lintRuleIds: new Set(),
    });
    expect(resolved[0]!.bound).toBe(true);
    expect(resolved[0]!.bindings[0]!.resolved).toBe(true);
  });

  it("evaluateInvariantRules emits the severity table correctly", () => {
    const inv = {
      id: "INV-x-01",
      file: "f.ts",
      line: 1,
      statement: "sufficiently long statement for the fixture corpus",
      statementSha256: "abc",
      bindings: [],
      bound: false,
      riskClass: "high" as const,
      baselined: false,
      vacuous: false,
    };
    const diags = evaluateInvariantRules(
      [inv],
      {
        schema: "forge/invariant-baseline@1",
        entries: [],
      },
      new Set(),
    );
    expect(diags.map((d) => d.ruleId)).toEqual(["COMPASS-INVARIANT-06"]);
    expect(diags[0]!.severity).toBe("error");
  });
});
