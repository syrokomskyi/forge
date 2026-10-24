/*
<MODULE_CONTRACT>
<purpose>
RFC-1390 acceptance fixtures for compass.invariants.generate: index projection,
seed once-only semantics, shrink removal-only behavior (AC-6 refusal),
retiredIds merge-forward, and dry-run write-freedom over tmp workspaces.
</purpose>
<non-goals>
  <item>Fixture invariant markers are built via string concatenation so the real scanner never parses this file's literals — do not inline real marker strings.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1390: generator fixtures — index, baseline seed/shrink, retiredIds merge, dry-run.</item>
  <item>RFC-1390: bind code invariants to enforcing checks (INV-tags, checked-by, baseline, generator)</item>
</CHANGE_SUMMARY>
*/

// Marker literal is split so the real scanner never parses fixture strings in
// THIS file as invariant declarations (same escape convention as MC_OPEN).
const AI_INV = "@ai-" + "invariant";

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCompassInvariantsGenerate } from "../compass-invariants-generate.ts";
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

function makeContext(workspaceRoot: string, dryRun = false): ForgeRuntimeContext {
  return {
    workspaceRoot,
    site: undefined,
    siteExplicit: false,
    dryRun,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as ForgeRuntimeContext;
}

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { flags } as ForgeCommandInput;
}

const MC_OPEN = "<" + "MODULE_CONTRACT>";
const MC_CLOSE = "</" + "MODULE_CONTRACT>";
const MC = (purpose: string) =>
  `${MC_OPEN}\n<purpose>${purpose}</purpose>\n<non-goals>\n  <item>Do not perform real validation — fixtures only.</item>\n</non-goals>\n${MC_CLOSE}`;
const CS_OPEN = "<" + "CHANGE_SUMMARY>";
const CS_CLOSE = "</" + "CHANGE_SUMMARY>";
const CS = (items: string[]) =>
  `${CS_OPEN}\n${items.map((i) => `  <item>${i}</item>`).join("\n")}\n${CS_CLOSE}`;
const wrap = (...blocks: string[]) => `/*\n${blocks.join("\n")}\n*/`;

const PURPOSE = "Projects invariant fixtures for the RFC-1390 generator suite.";
const CS_ITEM = "RFC-1390: generator fixture.";

const SRC_FILE = "packages/fixture-pkg/src/content/notes.ts";
const TEST_FILE = "packages/fixture-pkg/src/tests/inv.test.ts";

describe("compass.invariants.generate (RFC-1390)", () => {
  let tempDir: string;

  function write(relPath: string, content: string): void {
    const abs = join(tempDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  function writeSource(relPath: string, invariantLine: string): void {
    write(
      relPath,
      `${wrap(MC(PURPOSE), CS([CS_ITEM]))}\n\n${invariantLine}\n\nexport const x = 1;\n`,
    );
  }

  const indexPath = () => join(tempDir, "docs/invariants.generated.yaml");
  const baselinePath = () => join(tempDir, "docs/invariants.baseline.generated.yaml");

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "compass-inv-gen-"));
    writeForgeYaml(tempDir, "");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes the index with parsed invariants on a plain run", async () => {
    writeSource(SRC_FILE, `// ${AI_INV}[INV-notes-01]: the notes guard always fails closed`);
    const result = await runCompassInvariantsGenerate(makeInput(), makeContext(tempDir));
    expect(result.exitCode).toBe(0);
    expect(existsSync(indexPath())).toBe(true);
    const index = readFileSync(indexPath(), "utf8");
    expect(index).toContain("INV-notes-01");
    expect(index).toContain("forge/invariant-index@1");
    expect(dataOf(result).total).toBe(1);
    expect(dataOf(result).unbound).toBe(1);
  });

  it("--dry-run writes nothing", async () => {
    writeSource(SRC_FILE, `// ${AI_INV}[INV-notes-02]: the notes guard always fails closed`);
    const result = await runCompassInvariantsGenerate(makeInput(), makeContext(tempDir, true));
    expect(result.exitCode).toBe(0);
    expect(existsSync(indexPath())).toBe(false);
    expect(existsSync(baselinePath())).toBe(false);
  });

  it("--seed writes the baseline once and refuses a second run", async () => {
    writeSource(SRC_FILE, `// ${AI_INV}[INV-notes-03]: the notes guard always fails closed`);
    const first = await runCompassInvariantsGenerate(
      makeInput({ seed: true }),
      makeContext(tempDir),
    );
    expect(first.exitCode).toBe(0);
    const baseline = readFileSync(baselinePath(), "utf8");
    expect(baseline).toContain(SRC_FILE);

    const second = await runCompassInvariantsGenerate(
      makeInput({ seed: true }),
      makeContext(tempDir),
    );
    expect(second.exitCode).toBe(1);
    expect(second.summary).toContain("already exists");
  });

  it("shrink mode refuses to add entries to the baseline", async () => {
    writeSource(SRC_FILE, `// ${AI_INV}[INV-notes-04]: originally unbound statement here`);
    write(TEST_FILE, `// nothing bound yet\nexport const t = 1;`);
    await runCompassInvariantsGenerate(makeInput({ seed: true }), makeContext(tempDir));

    // Introduce NEW unbound debt not present at seeding — shrink must refuse
    // rather than silently grandfather it.
    writeSource(
      "packages/fixture-pkg/src/content/other.ts",
      `// ${AI_INV}[INV-other-01]: fresh unbound debt that is not baselined`,
    );

    const result = await runCompassInvariantsGenerate(
      makeInput({ shrink: true }),
      makeContext(tempDir),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("refused to add");
    // Baseline content unchanged — still exactly the seeded entry.
    const baseline = readFileSync(baselinePath(), "utf8");
    expect(baseline.match(/statementSha256/g)).toHaveLength(1);
  });

  it("--shrink removes an entry whose invariant gained a binding", async () => {
    writeSource(SRC_FILE, `// ${AI_INV}: an unbound invariant to be retired soon`);
    await runCompassInvariantsGenerate(makeInput({ seed: true }), makeContext(tempDir));

    // Now bind it — the entry becomes bound (id + resolvable binding).
    writeSource(
      SRC_FILE,
      `// ${AI_INV}[INV-notes-05]: an unbound invariant to be retired soon (checked-by: test:${TEST_FILE})`,
    );
    write(TEST_FILE, `// INV-notes-05 asserted\nit("x", () => {});`);

    const result = await runCompassInvariantsGenerate(
      makeInput({ shrink: true }),
      makeContext(tempDir),
    );
    expect(result.exitCode).toBe(0);
    const baseline = readFileSync(baselinePath(), "utf8");
    expect(baseline).not.toContain(SRC_FILE);
  });

  it("merge-forward keeps retiredIds across regeneration", async () => {
    writeSource(SRC_FILE, `// ${AI_INV}[INV-notes-06]: transient invariant later removed`);
    await runCompassInvariantsGenerate(makeInput(), makeContext(tempDir));

    // Remove the invariant — next regeneration must record INV-notes-06 retired.
    writeSource(SRC_FILE, `// no invariants on this line`);
    const result = await runCompassInvariantsGenerate(makeInput(), makeContext(tempDir));
    expect(result.exitCode).toBe(0);
    const index = readFileSync(indexPath(), "utf8");
    expect(index).toContain("INV-notes-06");
    expect(index).toContain("retiredIds");
    expect(dataOf(result).retiredIds).toBe(1);
  });
});
