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
  <item>RFC-1318</item>
  <item>RFC-1323: review pass — still-open enclosing-style detection, per-file pre-pass parity, scaffold never-throws, docs.scaffold raw-leaf assert, trim per-file skip, CS-08 always-error severity</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldFile, type ScaffoldFileInput } from "../compass-header-scaffold.ts";
import { forgeYaml } from "./forge-yaml-fixture.ts";
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

  it("COMPASS-CS-08: a describe title carrying the terminator skips the file, never throws (RFC-1323)", () => {
    // The title's star-slash flows into the derived purpose — the emission
    // assert converts to a skipped disposition instead of crashing the batch.
    const source = `import { describe, it } from "vitest";\ndescribe("mission widget glob ${"*"}${"/"} pairs", () => {\n  it("passes", () => {});\n});\n`;
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: "packages/fixture-pkg/src/components/mission-widget.test.ts",
        workspaceRelativePath: "src/components/mission-widget.test.ts",
        isTest: true,
      }),
      policy,
    );
    expect(result.disposition).toBe("skipped");
    expect(result.diagnostic?.ruleId).toBe("COMPASS-CS-08");
    expect(result.diagnostic?.message).toContain("file left untouched");
    expect(result.source).toBe(source);
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

  it("inserted: .md keeps YAML frontmatter at byte zero and inserts <!-- --> after it", () => {
    const source = `---\ntitle: Mission Notes\n---\n\n# Notes\n\nBody text.\n`;
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: "packages/fixture-pkg/docs/mission-notes.md",
        workspaceRelativePath: "docs/mission-notes.md",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(result.disposition).not.toBe("skipped");
    expect(result.source.startsWith("---\ntitle: Mission Notes\n---\n")).toBe(true);
    const headerAt = result.source.indexOf("<!--");
    expect(headerAt).toBeGreaterThan(result.source.indexOf("---\n\n"));
    expect(result.source).toContain(MC_OPEN);
    // Idempotent — the html comment is detected on the second pass.
    const second = scaffoldFile(
      input(result.source, {
        pathFromRoot: "packages/fixture-pkg/docs/mission-notes.md",
        workspaceRelativePath: "docs/mission-notes.md",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(second.disposition).toBe("unchanged");
  });

  it("repaired: unclosed trailing tag after .md frontmatter closes inside the header comment", () => {
    // Non-zero offset regression — the header starts after frontmatter, so a
    // close anchored at absolute closeStart would land before the header.
    const header = `<!--\n${MC_OPEN}\n<purpose>${PURPOSE}</purpose>\n<non-goals>\n  <item>Fixtures only.</item>\n</non-goals>\n${MC_CLOSE}\n${CS_OPEN}`;
    const source = `---\ntitle: Notes\n---\n\n${header}\n-->\n\n# Body\n`;
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: "packages/fixture-pkg/docs/mission-notes.md",
        workspaceRelativePath: "docs/mission-notes.md",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(result.disposition).toBe("repaired");
    expect(result.repairs).toContain("closed-change-summary");
    const csClose = result.source.indexOf(CS_CLOSE);
    const commentClose = result.source.indexOf("-->");
    expect(csClose).toBeGreaterThan(-1);
    expect(csClose).toBeLessThan(commentClose);
  });

  it("inserted: .gd line-comment headers carry exactly one prefix per line", () => {
    const source = `extends Node\n\nfunc mission_ready() -> bool:\n\treturn true\n`;
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: "packages/fixture-pkg/src/mission-widget.gd",
        workspaceRelativePath: "src/mission-widget.gd",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(result.disposition).not.toBe("skipped");
    expect(result.source).toContain(`# ${MC_OPEN}`);
    expect(result.source).toContain(`# ${CS_CLOSE}`);
    expect(result.source).not.toContain("# #");
    // Contiguous prefix run — second run is a no-op.
    const second = scaffoldFile(
      input(result.source, {
        pathFromRoot: "packages/fixture-pkg/src/mission-widget.gd",
        workspaceRelativePath: "src/mission-widget.gd",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(second.disposition).toBe("unchanged");
    expect(second.source).toBe(result.source);
  });

  it("repaired: .gd header with a missing block inserts prefixed lines, no doubled markers", () => {
    const header = `# ${MC_OPEN}\n# <purpose>${PURPOSE}</purpose>\n# <non-goals>\n#   <item>Fixtures only.</item>\n# </non-goals>\n# ${MC_CLOSE}`;
    const source = `${header}\nextends Node\n`;
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: "packages/fixture-pkg/src/mission-widget.gd",
        workspaceRelativePath: "src/mission-widget.gd",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(result.disposition).toBe("repaired");
    expect(result.source).toContain(`# ${CS_OPEN}`);
    expect(result.source).not.toContain("# #");
    expect(result.source).not.toMatch(/\n<CHANGE_SUMMARY>/);
  });

  it("repaired: unclosed <purpose> gets closed before its siblings", () => {
    const header = `${MC_OPEN}\n<purpose>${PURPOSE}\n<non-goals>\n  <item>Fixtures only.</item>\n</non-goals>\n${MC_CLOSE}\n${KD_OPEN}\n  <item>${KD_ITEM}</item>\n${KD_CLOSE}\n${CS_OPEN}\n${CS_CLOSE}`;
    const source = `${wrap(header)}\n\nexport const missionWidget = 1;\n`;
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("repaired");
    expect(result.repairs).toContain("closed-purpose");
    const purposeClose = result.source.indexOf("</purpose>");
    expect(purposeClose).toBeGreaterThan(-1);
    expect(purposeClose).toBeLessThan(result.source.indexOf("<non-goals>"));
  });

  it("repaired: an unclosed <item> inside non-goals gets closed", () => {
    const header = `${MC_OPEN}\n<purpose>${PURPOSE}</purpose>\n<non-goals>\n  <item>Fixtures only.\n  <item>No rewrites.</item>\n</non-goals>\n${MC_CLOSE}\n${KD_OPEN}\n  <item>${KD_ITEM}</item>\n${KD_CLOSE}\n${CS_OPEN}\n${CS_CLOSE}`;
    const source = `${wrap(header)}\n\nexport const missionWidget = 1;\n`;
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("repaired");
    expect(result.repairs).toContain("closed-item");
  });

  it("inserted: frontmatter-less .astro gets an html comment header, not /* */", () => {
    const source = `<section>Mission</section>\n`;
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: "packages/fixture-pkg/src/pages/mission.astro",
        workspaceRelativePath: "src/pages/mission.astro",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(result.disposition).not.toBe("skipped");
    expect(result.source.startsWith("<!--\n" + MC_OPEN)).toBe(true);
    expect(result.source).not.toContain("/*");
  });

  it("inserted: shebang, BOM, and directive prologues stay above the header", () => {
    const shebang = `#!/usr/bin/env node\nexport const missionWidget = 1;\n`;
    const shebanged = scaffoldFile(input(shebang), policy);
    expect(shebanged.source.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(shebanged.source.indexOf(MC_OPEN)).toBeGreaterThan(shebanged.source.indexOf("#!"));

    const bom = `﻿export const missionWidget = 1;\n`;
    const bombed = scaffoldFile(input(bom), policy);
    expect(bombed.source.charCodeAt(0)).toBe(0xfeff);
    expect(bombed.source.indexOf("/*")).toBe(2); // BOM, newline, then /*

    const directive = `"use client";\n\nexport const missionWidget = 1;\n`;
    const directived = scaffoldFile(input(directive), policy);
    expect(directived.source.startsWith('"use client";')).toBe(true);
    expect(directived.source.indexOf('"use client"')).toBeLessThan(
      directived.source.indexOf(MC_OPEN),
    );
  });

  it("SCAFFOLD-01: a comment opener inside a string literal is fixture material", () => {
    const source = ["const fixture = `/*", MC_OPEN, "*/`;", "export const t = 1;"].join("\n");
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("skipped");
    expect(result.diagnostic?.ruleId).toBe("SCAFFOLD-01");
    expect(result.source).toBe(source);
  });

  it("SCAFFOLD-02: an unterminated comment carrying tags leaves the file untouched", () => {
    const source = `/*\n${MC_OPEN}\n<purpose>${PURPOSE}</purpose>\nexport const missionWidget = 1;\n`;
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("skipped");
    expect(result.diagnostic?.ruleId).toBe("SCAFFOLD-02");
    expect(result.source).toBe(source);
  });

  it("SCAFFOLD-01: a line-start /* inside a multi-line template literal stays untouched", () => {
    const source = ["const fixture = `", "/*", MC_OPEN, "*/", "`;", "export const t = 1;"].join(
      "\n",
    );
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("skipped");
    expect(result.diagnostic?.ruleId).toBe("SCAFFOLD-01");
    expect(result.source).toBe(source);
  });

  it("SCAFFOLD-01: an html comment inside a fenced code block stays untouched", () => {
    const fence = "```";
    const source = ["# Doc", "", fence, "<!--", MC_OPEN, "-->", fence, "", "Body."].join("\n");
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: "packages/fixture-pkg/docs/mission-notes.md",
        workspaceRelativePath: "docs/mission-notes.md",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(result.disposition).toBe("skipped");
    expect(result.diagnostic?.ruleId).toBe("SCAFFOLD-01");
    expect(result.source).toBe(source);
  });

  it("repaired: .gd stage-1 close lands on its own prefixed line before the sibling", () => {
    const header = `# ${MC_OPEN}\n# <purpose>${PURPOSE}</purpose>\n# <non-goals>\n#   <item>Fixtures only.</item>\n# </non-goals>\n# ${CS_OPEN}\n# ${CS_CLOSE}`;
    const source = `${header}\nextends Node\n`;
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: "packages/fixture-pkg/src/mission-widget.gd",
        workspaceRelativePath: "src/mission-widget.gd",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(result.disposition).toBe("repaired");
    expect(result.repairs).toContain("closed-module-contract");
    const mcClose = result.source.indexOf(MC_CLOSE);
    const csOpen = result.source.indexOf(CS_OPEN);
    expect(result.source).toContain(`# ${MC_CLOSE}`);
    expect(mcClose).toBeLessThan(csOpen);
    expect(result.source).not.toContain("# #");
  });

  it("repaired: .gd stage-2 inner repairs keep every inserted line prefixed", () => {
    // Unclosed <purpose> + missing CHANGE_SUMMARY — exercises stage-2 and
    // stage-4 anchors on a line-style span.
    const header = `# ${MC_OPEN}\n# <purpose>${PURPOSE}\n# <non-goals>\n#   <item>Fixtures only.</item>\n# </non-goals>\n# ${MC_CLOSE}`;
    const source = `${header}\nextends Node\n`;
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: "packages/fixture-pkg/src/mission-widget.gd",
        workspaceRelativePath: "src/mission-widget.gd",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(result.disposition).toBe("repaired");
    expect(result.repairs).toContain("closed-purpose");
    expect(result.repairs).toContain("inserted-change-summary");
    expect(result.source).toContain("# </purpose>");
    expect(result.source).toContain(`# ${CS_OPEN}`);
    expect(result.source).not.toContain("# #");
    // No bare tag lines — every tag line keeps its comment prefix.
    for (const line of result.source.split("\n")) {
      if (line.includes("<") && line.includes(">")) {
        expect(line.trimStart().startsWith("#") || line.includes("extends")).toBe(true);
      }
    }
    const second = scaffoldFile(
      input(result.source, {
        pathFromRoot: "packages/fixture-pkg/src/mission-widget.gd",
        workspaceRelativePath: "src/mission-widget.gd",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(second.disposition).toBe("unchanged");
  });

  it("inserted: .tscn headers use the ; line prefix", () => {
    const source = `[gd_scene format=3]\n\n[node name="Mission" type="Node"]\n`;
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: "packages/fixture-pkg/scenes/mission.tscn",
        workspaceRelativePath: "scenes/mission.tscn",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(result.disposition).not.toBe("skipped");
    expect(result.source).toContain(`; ${MC_OPEN}`);
    expect(result.source).not.toContain("; ;");
    const second = scaffoldFile(
      input(result.source, {
        pathFromRoot: "packages/fixture-pkg/scenes/mission.tscn",
        workspaceRelativePath: "scenes/mission.tscn",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(second.disposition).toBe("unchanged");
  });

  it("repaired: unclosed purpose + missing non-goals emit closes before new blocks", () => {
    // Shared </MODULE_CONTRACT> anchor — closed-purpose must land before the
    // inserted non-goals block, not after it.
    const header = `${MC_OPEN}\n<purpose>${PURPOSE}\n${MC_CLOSE}\n${KD_OPEN}\n  <item>${KD_ITEM}</item>\n${KD_CLOSE}\n${CS_OPEN}\n${CS_CLOSE}`;
    const source = `${wrap(header)}\n\nexport const missionWidget = 1;\n`;
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("repaired");
    expect(result.repairs).toContain("closed-purpose");
    expect(result.repairs).toContain("inserted-non-goals");
    const purposeClose = result.source.indexOf("</purpose>");
    const ngOpen = result.source.indexOf("<non-goals>");
    expect(purposeClose).toBeLessThan(ngOpen);
    expect(ngOpen).toBeLessThan(result.source.indexOf(MC_CLOSE));
  });

  it("repaired: an adjacent empty contract emits purpose before non-goals", () => {
    const header = `${MC_OPEN}${MC_CLOSE}\n${KD_OPEN}\n  <item>${KD_ITEM}</item>\n${KD_CLOSE}\n${CS_OPEN}\n${CS_CLOSE}`;
    const source = `${wrap(header)}\n\nexport const missionWidget = 1;\n`;
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("repaired");
    const purposeOpen = result.source.indexOf("<purpose>");
    const ngOpen = result.source.indexOf("<non-goals>");
    expect(purposeOpen).toBeGreaterThan(-1);
    expect(purposeOpen).toBeLessThan(ngOpen);
  });

  it("repaired: same-line siblings in a line-style header close inline", () => {
    const header = `# ${MC_OPEN}\n# <purpose>${PURPOSE} <non-goals>\n#   <item>Fixtures only.</item>\n# </non-goals>\n# ${MC_CLOSE}\n# ${CS_OPEN}\n# ${CS_CLOSE}`;
    const source = `${header}\nextends Node\n`;
    const result = scaffoldFile(
      input(source, {
        pathFromRoot: "packages/fixture-pkg/src/mission-widget.gd",
        workspaceRelativePath: "src/mission-widget.gd",
        riskClass: "low",
        keyDecisionsRequired: false,
      }),
      policy,
    );
    expect(result.disposition).toBe("repaired");
    expect(result.repairs).toContain("closed-purpose");
    const line = result.source.split("\n").find((l) => l.includes("<purpose>"));
    expect(line).toContain("</purpose>");
    expect(result.source.indexOf("<purpose>")).toBeLessThan(result.source.indexOf("</purpose>"));
  });

  it("repaired: a stray CHANGE_SUMMARY without a contract keeps canonical order", () => {
    const header = `${CS_OPEN}\n  <item>RFC-9999: stray.</item>\n${CS_CLOSE}`;
    const source = `${wrap(header)}\n\nexport const missionWidget = 1;\n`;
    const result = scaffoldFile(input(source), policy);
    expect(result.disposition).toBe("repaired");
    const mcOpen = result.source.indexOf(MC_OPEN);
    const csOpen = result.source.indexOf(CS_OPEN);
    expect(mcOpen).toBeGreaterThan(-1);
    expect(mcOpen).toBeLessThan(csOpen);
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

  it("--files refuses unsupported extensions — bypass is scan-root only", async () => {
    const yaml = "packages/fixture-pkg/config.yaml";
    writeFixture(yaml, `key: value\n`);
    commitAll();

    const result = await runCompassHeaderScaffold(
      makeInput({ files: [yaml], force: true }),
      makeContext(tempDir),
    );
    expect(result.exitCode).toBe(0);
    const report = dataOf(result).files.find((f) => f.path === yaml);
    expect(report?.disposition).toBe("skipped");
    expect(report?.skipReason).toContain("extension");
    expect(readFileSync(join(tempDir, yaml), "utf8")).toBe("key: value\n");
  });

  it("apply exits non-zero naming files skipped on COMPASS-CS-08 (RFC-1323)", async () => {
    // An existing html-enclosed partial header whose <non-goals> carries a
    // bare line with `<!--` — the repair re-emits it as an <item>, the guard
    // rejects it (CS-08), the file is skipped, and apply fails closed.
    const target = "packages/fixture-pkg/src/page.astro";
    const body = `---\nconst x = 1;\n---\n${"<"}!--\n${MC_OPEN}\n<purpose>${PURPOSE}</purpose>\n<non-goals>\nbare ${"<"}!-- note\n</non-goals>\n${MC_CLOSE}\n${"--" + ">"}\n<main/>\n`;
    writeFixture(target, body);
    commitAll();

    const result = await runCompassHeaderScaffold(
      makeInput({ files: [target] }),
      makeContext(tempDir),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("COMPASS-CS-08");
    expect(result.summary).toContain(target);
    const report = dataOf(result).files.find((f) => f.path === target);
    expect(report?.disposition).toBe("skipped");
    expect(report?.diagnostic?.ruleId).toBe("COMPASS-CS-08");
    expect(readFileSync(join(tempDir, target), "utf8")).toBe(body);
  });

  it("report payload carries path/disposition/repairs — never full file source", async () => {
    writeFixture(MEDIUM_ROOT, `export const missionWidget = 1;\n`);
    const result = await runCompassHeaderScaffold(
      makeInput({ census: true }),
      makeContext(tempDir),
    );
    const report = dataOf(result).files.find((f) => f.path === MEDIUM_ROOT);
    expect(report).toBeDefined();
    expect("source" in (report ?? {})).toBe(false);
  });

  it("census on a dirty tree still reports dispositions without refusing", async () => {
    writeFixture(MEDIUM_ROOT, `export const missionWidget = 1;\n`);
    // Uncommitted (dirty) target — census never writes so it never refuses.
    const result = await runCompassHeaderScaffold(
      makeInput({ census: true }),
      makeContext(tempDir),
    );
    expect(result.exitCode).toBe(0);
    expect(dataOf(result).files.find((f) => f.path === MEDIUM_ROOT)?.disposition).toBe("inserted");
  });

  it("apply under --package refuses dirty targets inside the scanned package", async () => {
    // Porcelain paths are repo-top-relative — a package-scoped scan must still
    // match dirty files below the scan root.
    const target = "packages/fixture-pkg/src/widget.ts";
    writeFixture(target, `export const widget = 1;\n`);
    commitAll();
    writeFixture(target, `export const widget = 2;\n`); // dirty

    const result = await runCompassHeaderScaffold(
      makeInput({ package: "fixture-pkg" }),
      makeContext(tempDir),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("dirty");
    expect(readFileSync(join(tempDir, target), "utf8")).toBe("export const widget = 2;\n");
  });

  it("--files honors excludedPaths — exclusions cannot be overridden by naming a file", async () => {
    writeFileSync(
      join(tempDir, "forge.yaml"),
      forgeYaml(
        '  compass:\n    excludedPaths:\n      - { pattern: "src/templates/**", reason: template-source }\n',
      ),
    );
    const excluded = "packages/fixture-pkg/src/templates/widget.ts";
    writeFixture(excluded, `export const widget = 1;\n`);
    commitAll();

    const result = await runCompassHeaderScaffold(
      makeInput({ files: [excluded], force: true }),
      makeContext(tempDir),
    );
    expect(result.exitCode).toBe(0);
    const report = dataOf(result).files.find((f) => f.path === excluded);
    expect(report?.disposition).toBe("skipped");
    expect(report?.skipReason).toContain("template-source");
    expect(readFileSync(join(tempDir, excluded), "utf8")).toBe("export const widget = 1;\n");
  });

  it("apply inside a --workpiece leaf repo refuses dirty targets it can see", async () => {
    const workpiece = "missions/m1/workpiece";
    const target = `${workpiece}/src/widget.ts`;
    writeFixture(target, `export const widget = 1;\n`);
    // Nested git repo: git status inside it reports workpiece-relative paths.
    execFileSync("git", ["init", "-q"], { cwd: join(tempDir, workpiece), stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], {
      cwd: join(tempDir, workpiece),
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test"], {
      cwd: join(tempDir, workpiece),
      stdio: "ignore",
    });

    const result = await runCompassHeaderScaffold(makeInput({ workpiece }), makeContext(tempDir));
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("dirty");
    expect(readFileSync(join(tempDir, target), "utf8")).toBe("export const widget = 1;\n");
  });
});
