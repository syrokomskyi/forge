/*
<MODULE_CONTRACT>
<purpose>
Unit tests for the compass.header.scaffold codemod (RFC-1318) — pure
scaffoldFile dispositions (insert, repair, sentinel, skip, unchanged) and the
handler's census/apply/dirty-target/--files behavior across fixture workspaces
in temp dirs.
</purpose>
<non-goals>
  <item>Fixture Compass markup is built via string concatenation so source-level validators never see literal forbidden tags — do not inline real tag literals.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1318: add compass.header.scaffold codemod for mechanical header sweeps</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldFile, type ScaffoldFileInput } from "../compass-header-scaffold.ts";
import { runCompassHeaderScaffold } from "../compass-header-scaffold-handler.ts";
import { resolveCompassPolicy, type CompassPolicy } from "../../policy.ts";
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

// Dynamic tags: literal compass blocks in this file would be matched by
// compass.summary.record and the AC-4 source scans.
const MC_OPEN = "<" + "MODULE_CONTRACT>";
const MC_CLOSE = "</" + "MODULE_CONTRACT>";
const KD_OPEN = "<" + "KEY_DECISIONS>";
const KD_CLOSE = "</" + "KEY_DECISIONS>";
const CS_OPEN = "<" + "CHANGE_SUMMARY>";
const CS_CLOSE = "</" + "CHANGE_SUMMARY>";
const wrap = (...blocks: string[]) => `/*\n${blocks.join("\n")}\n*/`;

const PURPOSE =
  "Validates mission widget fixtures for the compass header scaffold test suite coverage.";
const KD_ITEM = "Fixtures live in a temp workspace so tests never touch the real repository.";

// Medium-risk: workspace-relative src/components/** → layer component.
const MEDIUM_ROOT = "packages/fixture-pkg/src/components/mission-widget.ts";
const MEDIUM_WS = "src/components/mission-widget.ts";
// Low-risk: bare src/** → layer source.
const LOW_ROOT = "packages/fixture-pkg/src/mission-notes.ts";
const LOW_WS = "src/mission-notes.ts";
// High-risk: src/layouts/** → layer layout.
const HIGH_ROOT = "packages/fixture-pkg/src/layouts/main.astro";
const HIGH_WS = "src/layouts/main.astro";

let policy: CompassPolicy;

function input(source: string, overrides: Partial<ScaffoldFileInput> = {}): ScaffoldFileInput {
  return {
    pathFromRoot: MEDIUM_ROOT,
    workspaceRelativePath: MEDIUM_WS,
    source,
    riskClass: "medium",
    keyDecisionsRequired: true,
    isTest: false,
    ...overrides,
  };
}

describe("scaffoldFile codemod (RFC-1318)", () => {
  beforeEach(() => {
    policy = resolveCompassPolicy(mkdtempSync(join(tmpdir(), "scaffold-policy-")));
  });

  it("inserted: headerless file gains a closed, canonically ordered header", () => {
    const source = `export function missionWidget() {\n  return 1;\n}\n`;
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("inserted");
    const out = result.source;
    expect(out.indexOf(MC_OPEN)).toBeLessThan(out.indexOf(KD_OPEN));
    expect(out.indexOf(KD_OPEN)).toBeLessThan(out.indexOf(CS_OPEN));
    expect(out).toContain(MC_CLOSE);
    expect(out).toContain(KD_CLOSE);
    expect(out).toContain(CS_CLOSE);
    expect(out).not.toContain("<purpose>TODO(compass)");
    expect(out.endsWith(source)).toBe(true);
  });

  it("inserted: low-risk file gets MODULE_CONTRACT + CHANGE_SUMMARY but no KEY_DECISIONS", () => {
    const result = scaffoldFile(
      input(`export const missionNotes = 1;\n`, {
        pathFromRoot: LOW_ROOT,
        workspaceRelativePath: LOW_WS,
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(result.disposition).toBe("inserted");
    expect(result.source).not.toContain(KD_OPEN);
    expect(result.source).toContain(MC_OPEN);
    expect(result.source).toContain(CS_OPEN);
  });

  it("sentinel: no derivable purpose signal emits TODO(compass), never boilerplate", () => {
    const result = scaffoldFile(
      input(`const local = 1;\nexport default local;\n`, {
        pathFromRoot: "packages/fixture-pkg/src/alpha.ts",
        workspaceRelativePath: "src/alpha.ts",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(result.disposition).toBe("sentinel");
    expect(result.source).toContain("TODO(compass)");
    expect(result.source).not.toContain("This file provides");
  });

  it("inserted: scaffold-required test derives purpose from the describe title", () => {
    const source = `import { describe, it } from "vitest";\ndescribe("mission widget contract", () => {\n  it("passes", () => {});\n});\n`;
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: "packages/fixture-pkg/src/components/mission-widget.test.ts",
        workspaceRelativePath: "src/components/mission-widget.test.ts",
        isTest: true,
      }),
      policy,
    );
    expect(result.disposition).toBe("inserted");
    expect(result.source).toContain("mission widget contract");
    expect(result.source).not.toContain("<purpose>TODO(compass)");
  });

  it("SCAFFOLD-01: literal tag markup outside a header comment is skipped with line evidence", () => {
    const source = [
      `const template = "${MC_OPEN}";`,
      `const closer = "${MC_CLOSE}";`,
      `export const t = 1;`,
    ].join("\n");
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("skipped");
    expect(result.diagnostic?.ruleId).toBe("SCAFFOLD-01");
    expect(result.diagnostic?.message).toContain("L1:");
    expect(result.source).toBe(source);
  });

  it("repaired: missing CHANGE_SUMMARY and KEY_DECISIONS append without touching authored text", () => {
    const authored = `  <item>${KD_ITEM}</item>`;
    const header = `${MC_OPEN}\n<purpose>${PURPOSE}</purpose>\n<non-goals>\n  <item>Fixtures only.</item>\n</non-goals>\n${MC_CLOSE}\n${KD_OPEN}\n${authored}\n${KD_CLOSE}`;
    const source = `${wrap(header)}\n\nexport const missionWidget = 1;\n`;
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("repaired");
    expect(result.source).toContain(CS_OPEN);
    expect(result.source).toContain(authored);
    // Existing blocks stay byte-for-byte.
    expect(result.source).toContain(header);
  });

  it("repaired: unclosed MODULE_CONTRACT is closed before the next sibling tag", () => {
    const header = `${MC_OPEN}\n<purpose>${PURPOSE}</purpose>\n<non-goals>\n  <item>Fixtures only.</item>\n</non-goals>\n${KD_OPEN}\n  <item>${KD_ITEM}</item>\n${KD_CLOSE}\n${CS_OPEN}\n${CS_CLOSE}`;
    const source = `${wrap(header)}\n\nexport const missionWidget = 1;\n`;
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("repaired");
    const mcClose = result.source.indexOf(MC_CLOSE);
    const kdOpen = result.source.indexOf(KD_OPEN);
    expect(mcClose).toBeGreaterThan(-1);
    expect(mcClose).toBeLessThan(kdOpen);
    expect(result.repairs).toContain("closed-module-contract");
  });

  it("repaired: missing purpose is derived and inserted inside MODULE_CONTRACT", () => {
    const header = `${MC_OPEN}\n<non-goals>\n  <item>Fixtures only.</item>\n</non-goals>\n${MC_CLOSE}\n${KD_OPEN}\n  <item>${KD_ITEM}</item>\n${KD_CLOSE}\n${CS_OPEN}\n${CS_CLOSE}`;
    const source = `${wrap(header)}\n\nexport const missionWidget = 1;\n`;
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("repaired");
    expect(result.source).toContain("<purpose>");
    expect(result.source).not.toContain("<purpose>TODO(compass)");
  });

  it("repaired: missing non-goals is appended inside MODULE_CONTRACT", () => {
    const header = `${MC_OPEN}\n<purpose>${PURPOSE}</purpose>\n${MC_CLOSE}\n${KD_OPEN}\n  <item>${KD_ITEM}</item>\n${KD_CLOSE}\n${CS_OPEN}\n${CS_CLOSE}`;
    const source = `${wrap(header)}\n\nexport const missionWidget = 1;\n`;
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("repaired");
    expect(result.source).toContain("<non-goals>");
    expect(result.source.indexOf("<non-goals>")).toBeLessThan(result.source.indexOf(MC_CLOSE));
  });

  it("repaired: item-less non-goals normalize bare text into items preserving the words", () => {
    const header = `${MC_OPEN}\n<purpose>${PURPOSE}</purpose>\n<non-goals>\n  Fixtures only, no real validation.\n</non-goals>\n${MC_CLOSE}\n${KD_OPEN}\n  <item>${KD_ITEM}</item>\n${KD_CLOSE}\n${CS_OPEN}\n${CS_CLOSE}`;
    const source = `${wrap(header)}\n\nexport const missionWidget = 1;\n`;
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("repaired");
    expect(result.source).toContain("<item>Fixtures only, no real validation.</item>");
    expect(result.repairs).toContain("non-goals-items");
  });

  it("skipped: high-risk file without @ai-invariant defers to agent authorship", () => {
    const result = scaffoldFile(
      input(`<div>layout</div>\n`, {
        pathFromRoot: HIGH_ROOT,
        workspaceRelativePath: HIGH_WS,
        riskClass: "high",
      }),
      policy,
    );
    expect(result.disposition).toBe("skipped");
    expect(result.skipReason).toContain("@ai-invariant");
  });

  it("inserted: high-risk file with @ai-invariant seeds KEY_DECISIONS from it", () => {
    const source = `<!-- @ai-invariant Layout tokens must stay deterministic. -->\n<div>layout</div>\n`;
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: HIGH_ROOT,
        workspaceRelativePath: HIGH_WS,
        riskClass: "high",
      }),
      policy,
    );
    expect(result.disposition).not.toBe("skipped");
    expect(result.source).toContain(KD_OPEN);
    expect(result.source).toContain("Layout tokens must stay deterministic.");
    // The comment anchor in the body must not absorb the header boundary.
    expect(result.source).toContain("@ai-invariant");
  });

  it("inserted: .astro headers land inside frontmatter as a block comment", () => {
    const source = `---\nconst title = "Mission";\n---\n<section>{title}</section>\n`;
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: "packages/fixture-pkg/src/pages/mission.astro",
        workspaceRelativePath: "src/pages/mission.astro",
      }),
      policy,
    );
    expect(result.disposition).not.toBe("skipped");
    expect(result.source.startsWith("---\n/*\n" + MC_OPEN)).toBe(true);
    expect(result.source).toContain(CS_CLOSE + "\n*/\n");
    expect(result.source.indexOf("*/")).toBeLessThan(result.source.indexOf("const title"));
  });

  it("unchanged: .astro file with a markup-side html header is a no-op", () => {
    const header = `<!--\n${MC_OPEN}\n<purpose>${PURPOSE}</purpose>\n<non-goals>\n  <item>Fixtures only.</item>\n</non-goals>\n${MC_CLOSE}\n${CS_OPEN}\n  <item>RFC-1318: fixture.</item>\n${CS_CLOSE}\n-->`;
    const source = `---\nconst title = "Mission";\n---\n${header}\n<section>{title}</section>\n`;
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: "packages/fixture-pkg/src/pages/mission.astro",
        workspaceRelativePath: "src/pages/mission.astro",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(result.disposition).toBe("unchanged");
    expect(result.source).toBe(source);
  });

  it("unchanged: fully scaffolded file is a no-op and idempotent", () => {
    const first = scaffoldFile(input(`export const missionWidget = 1;\n`), policy);
    expect(first.disposition).not.toBe("unchanged");
    const second = scaffoldFile(input(first.source), policy);
    expect(second.disposition).toBe("unchanged");
    expect(second.source).toBe(first.source);
  });

  it("unchanged: complete authored header stays byte-identical", () => {
    const header = `${MC_OPEN}\n<purpose>${PURPOSE}</purpose>\n<non-goals>\n  <item>Fixtures only.</item>\n</non-goals>\n${MC_CLOSE}\n${KD_OPEN}\n  <item>${KD_ITEM}</item>\n${KD_CLOSE}\n${CS_OPEN}\n  <item>RFC-1318: fixture.</item>\n${CS_CLOSE}`;
    const source = `${wrap(header)}\n\nexport const missionWidget = 1;\n`;
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("unchanged");
    expect(result.source).toBe(source);
  });
});

describe("runCompassHeaderScaffold handler (RFC-1318)", () => {
  let tempDir: string;

  function git(...args: string[]): void {
    execFileSync("git", args, { cwd: tempDir, stdio: "ignore", timeout: 10000 });
  }

  function writeFixture(relPath: string, body: string): void {
    const abs = join(tempDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }

  function commitAll(message = "fixture"): void {
    git("add", "-A");
    git("commit", "-q", "-m", message);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "compass-scaffold-handler-"));
    policy = resolveCompassPolicy(tempDir);
    git("init", "-q");
    git("config", "user.email", "test@test.com");
    git("config", "user.name", "Test");
    git("commit", "-q", "--allow-empty", "-m", "init");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("census reports dispositions and writes nothing", async () => {
    writeFixture(MEDIUM_ROOT, `export const missionWidget = 1;\n`);
    const result = await runCompassHeaderScaffold(
      makeInput({ census: true }),
      makeContext(tempDir),
    );
    expect(result.exitCode).toBe(0);
    const data = dataOf(result);
    expect(data.mode).toBe("census");
    expect(data.scanned).toBeGreaterThan(0);
    const report = data.files.find((f) => f.path === MEDIUM_ROOT);
    expect(report?.disposition).toBe("inserted");
    expect(readFileSync(join(tempDir, MEDIUM_ROOT), "utf8")).toBe(
      `export const missionWidget = 1;\n`,
    );
  });

  it("apply writes headers and a second run reports unchanged", async () => {
    writeFixture(MEDIUM_ROOT, `export const missionWidget = 1;\n`);
    commitAll();
    const first = await runCompassHeaderScaffold(makeInput(), makeContext(tempDir));
    expect(first.exitCode).toBe(0);
    const written = readFileSync(join(tempDir, MEDIUM_ROOT), "utf8");
    expect(written).toContain(MC_OPEN);
    expect(written).toContain(CS_CLOSE);
    commitAll("scaffold");

    const second = await runCompassHeaderScaffold(makeInput(), makeContext(tempDir));
    const report = dataOf(second).files.find((f) => f.path === MEDIUM_ROOT);
    expect(report?.disposition).toBe("unchanged");
    expect(readFileSync(join(tempDir, MEDIUM_ROOT), "utf8")).toBe(written);
  });

  it("refuses when the only write target carries uncommitted changes", async () => {
    writeFixture(MEDIUM_ROOT, `export const missionWidget = 1;\n`);
    // File is dirty (untracked) — apply must refuse; --force overrides.
    const refused = await runCompassHeaderScaffold(makeInput(), makeContext(tempDir));
    expect(refused.exitCode).toBe(1);
    expect(refused.summary).toContain("dirty");
    expect(readFileSync(join(tempDir, MEDIUM_ROOT), "utf8")).toBe(
      `export const missionWidget = 1;\n`,
    );

    const forced = await runCompassHeaderScaffold(makeInput({ force: true }), makeContext(tempDir));
    expect(forced.exitCode).toBe(0);
    expect(readFileSync(join(tempDir, MEDIUM_ROOT), "utf8")).toContain(MC_OPEN);
  });

  it("apply proceeds when dirty paths sit outside the write set", async () => {
    writeFixture(MEDIUM_ROOT, `export const missionWidget = 1;\n`);
    writeFixture("docs/notes.md", `# notes\n`);
    commitAll();
    // Dirty file outside the target set — unrelated churn must not block.
    writeFixture("docs/notes.md", `# notes updated\n`);

    const result = await runCompassHeaderScaffold(makeInput(), makeContext(tempDir));
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(tempDir, MEDIUM_ROOT), "utf8")).toContain(MC_OPEN);
  });

  it("--files bypasses scan roots and processes the explicit list", async () => {
    const outside = "custom-dir/widget-helper.ts";
    writeFixture(outside, `export const widgetHelper = 1;\n`);
    commitAll();

    const result = await runCompassHeaderScaffold(
      makeInput({ files: [outside] }),
      makeContext(tempDir),
    );
    expect(result.exitCode).toBe(0);
    const data = dataOf(result);
    expect(data.files).toHaveLength(1);
    expect(data.files[0]!.path).toBe(outside);
    expect(readFileSync(join(tempDir, outside), "utf8")).toContain(MC_OPEN);
  });
});
