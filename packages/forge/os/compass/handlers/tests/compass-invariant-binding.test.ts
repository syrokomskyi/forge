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
  <item>RFC-1390: close review findings on invariant binding machinery</item>
  <item>RFC-1390: close round-2 review findings on invariant binding machinery</item>
  <item>RFC-1390: close round-3 review residue on invariant binding machinery</item>
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

  it("joins a wrapped statement across consecutive comment lines", () => {
    const parsed = extractInvariants(
      [
        `// ${AI_INV}: first half of the statement continues`,
        "// onto a second comment line before the code resumes",
        "export const x = 1;",
      ].join("\n"),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.statement).toBe(
      "first half of the statement continues onto a second comment line before the code resumes",
    );
  });

  it("stops statement continuation at an unrelated comment after a code line", () => {
    const parsed = extractInvariants(
      [
        `// ${AI_INV}: statement text here`,
        "export const x = 1;",
        "// an unrelated trailing comment that must not join",
      ].join("\n"),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.statement).toBe("statement text here");
  });

  it("does not treat a marker inside a string or regex literal as a declaration", () => {
    const parsed = extractInvariants(
      [
        `const re = /${AI_INV}: not an invariant/;`,
        `const s = "${AI_INV}: also not an invariant";`,
        `// ${AI_INV}: a real declaration follows`,
      ].join("\n"),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.statement).toBe("a real declaration follows");
  });

  it("reports COMPASS-INVARIANT-04 when checked-by is not the trailing group", async () => {
    writeSource(
      LOW_FILE,
      `// ${AI_INV}[INV-guard-10]: statement (checked-by: test:${TEST_FILE}) trailing prose after the group`,
    );
    const result = await validate();
    const diags = dataOf(result).diagnostics.filter(
      (d) => d.ruleId === "COMPASS-INVARIANT-04" && d.file === LOW_FILE,
    );
    expect(diags.length).toBeGreaterThan(0);
  });

  it("rejects a binding target that escapes the workspace via ../", async () => {
    writeSource(
      HIGH_FILE,
      `// ${AI_INV}[INV-guard-11]: the guard fails closed (checked-by: test:../../outside.test.ts)`,
    );
    const result = await validate();
    const diags = dataOf(result).diagnostics.filter(
      (d) => d.ruleId === "COMPASS-INVARIANT-04" && d.file === HIGH_FILE,
    );
    expect(diags.length).toBeGreaterThan(0);
  });

  it("does not match an invariant id as a prefix of a longer id in the bound file", async () => {
    writeSource(
      HIGH_FILE,
      `// ${AI_INV}[INV-guard-12]: the guard fails closed (checked-by: test:${TEST_FILE})`,
    );
    write(TEST_FILE, `// INV-guard-120 is asserted here\nit("INV-guard-120 holds", () => {});\n`);
    const result = await validate();
    const diags = dataOf(result).diagnostics.filter(
      (d) => d.ruleId === "COMPASS-INVARIANT-04" && d.file === HIGH_FILE,
    );
    expect(diags.length).toBeGreaterThan(0);
  });

  it("resolves a lint binding against a real validator-inventory rules shape", async () => {
    writeSource(
      LOW_FILE,
      `// ${AI_INV}[INV-guard-13]: statement bound to a lint rule (checked-by: lint:COMPASS-INVARIANT-01)`,
    );
    mkdirSync(join(tempDir, "docs"), { recursive: true });
    writeFileSync(
      join(tempDir, "docs/validator-inventory.generated.yaml"),
      [
        `contracts:`,
        `  - contract: compass`,
        `    validators:`,
        `      - command: compass.validate`,
        `        rules:`,
        `          - COMPASS-INVARIANT-01`,
        `          - COMPASS-INVARIANT-02`,
      ].join("\n") + "\n",
    );
    const result = await validate();
    const diags = dataOf(result).diagnostics.filter(
      (d) => d.ruleId === "COMPASS-INVARIANT-04" && d.file === LOW_FILE,
    );
    expect(diags).toEqual([]);
  });

  it("does not treat a marker after an escaped newline inside a template literal as a declaration", () => {
    // The \\n// shape is the compass-migrate false-positive class: the sigil
    // is glued to an escape sequence, i.e. string content, not a comment.
    const parsed = extractInvariants(
      [
        `const s = \`first line\\n// ${AI_INV}: phantom marker inside a template\`;`,
        `const t = "another\\n// ${AI_INV}: phantom inside a string";`,
        `const u = "a\\\\// ${AI_INV}: sigil glued to an escaped backslash";`,
        `// ${AI_INV}: the only real declaration in this source`,
      ].join("\n"),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.statement).toBe("the only real declaration in this source");
  });

  it("ignores an @ai-invariant mention mid-comment — the marker must open the comment", () => {
    const parsed = extractInvariants(
      [
        `// Seeded items (e.g. ${AI_INV}: lines captured) keep their text.`,
        `/* CHANGE_SUMMARY copies ${AI_INV}: comments into items. */`,
        `// ${AI_INV}: marker at comment start is the real declaration`,
      ].join("\n"),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.statement).toBe("marker at comment start is the real declaration");
  });

  it("extracts a marker inside an html comment", () => {
    const parsed = extractInvariants(
      [`<!-- ${AI_INV}: html-comment invariant statement text -->`, `<div>markup</div>`].join("\n"),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.statement).toBe("html-comment invariant statement text");
  });

  it("extracts invariants across mixed comment styles in one source", () => {
    const parsed = extractInvariants(
      [
        `// ${AI_INV}: line-comment invariant statement text`,
        `/*`,
        ` * ${AI_INV}: block-comment invariant statement text`,
        ` */`,
        `const x = 1;`,
      ].join("\n"),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.statement).toBe("line-comment invariant statement text");
    expect(parsed[1]!.statement).toBe("block-comment invariant statement text");
  });

  it("records the marker line, not the last continuation line", () => {
    const parsed = extractInvariants(
      [
        "const before = 0;", // line 1
        `// ${AI_INV}: a statement that wraps`, // line 2 — the marker
        "// onto this second comment line", // line 3 — continuation
        "const after = 1;",
      ].join("\n"),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.line).toBe(2);
  });

  it("ends a statement at a delimiter-prefixed comment line", () => {
    const lineStyle = extractInvariants(
      [`// ${AI_INV}: the statement must not absorb`, "// --- Section Start ---"].join("\n"),
    );
    expect(lineStyle).toHaveLength(1);
    expect(lineStyle[0]!.statement).toBe("the statement must not absorb");

    const blockStyle = extractInvariants(
      [
        "/*",
        ` * ${AI_INV}: the statement must not absorb`,
        "*************** <MODULE_CONTRACT>",
        " */",
      ].join("\n"),
    );
    expect(blockStyle).toHaveLength(1);
    expect(blockStyle[0]!.statement).toBe("the statement must not absorb");
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
