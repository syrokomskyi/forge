/*
<MODULE_CONTRACT>
<purpose>
Unit tests for the compass.summary.trim handler — CS-08 unsafe-text skip
semantics (exit 1, bytes untouched, skippedUnsafe channel) and the clean
over-cap collapse control case against .astro html-enclosed fixtures.
</purpose>
<non-goals>
  <item>Fixture Compass markup is built via string concatenation so source-level validators never see literal forbidden tags — do not inline real tag literals.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1323: trim skippedUnsafe coverage — unsafe fixture exits 1 with bytes untouched, clean over-cap fixture collapses.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompassSummaryTrim } from "../compass-change-summary-handler.ts";
import type { ForgeRuntimeContext } from "../../../../src/types.ts";

const logger = {
  section() {},
  info() {},
  warn() {},
  error() {},
  success() {},
  getEvents() {
    return [];
  },
};

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: logger as never,
    dryRun: false,
    outputFormat: "pretty",
  };
}

function makeInput(flags: Record<string, unknown> = {}) {
  return { argv: [], flags: flags as never };
}

const MC_OPEN = "<" + "MODULE_CONTRACT>";
const MC_CLOSE = "</" + "MODULE_CONTRACT>";
const CS_OPEN = "<" + "CHANGE_SUMMARY>";
const CS_CLOSE = "</" + "CHANGE_SUMMARY>";
const HTML_OPEN = "<!" + "--";
const HTML_CLOSE = "--" + ">";

// .astro html-enclosed header; the CS window is 5 so six items force a
// collapse re-emit — the seam under test.
const ASTRO = (items: string[]) => `---
const x = 1;
---
${HTML_OPEN}
${MC_OPEN}
<purpose>Astro page fixture for summary trim unsafe-text coverage.</purpose>
<non-goals><item>No production logic.</item></non-goals>
${MC_CLOSE}
${CS_OPEN}
${items.map((i) => `  <item>${i}</item>`).join("\n")}
${CS_CLOSE}
${HTML_CLOSE}
<main/>
`;

describe("compass.summary.trim", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "summary-trim-"));
    await mkdir(join(root, "packages", "fixture-pkg", "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("RFC-1323: an existing item carrying the terminator → skippedUnsafe, exit 1, bytes untouched", async () => {
    const target = "packages/fixture-pkg/src/page.astro";
    const items = [
      "RFC-0001: first.",
      "RFC-0002: second.",
      "RFC-0003: third.",
      "RFC-0004: fourth.",
      "RFC-0005: fifth.",
      `RFC-0006: notes ${HTML_OPEN} mid-item`,
    ];
    const body = ASTRO(items);
    await writeFile(join(root, target), body);

    const result = await runCompassSummaryTrim(makeInput(), makeContext(root));
    expect(result.exitCode).toBe(1);
    const data = result.data as { skippedUnsafe: string[]; files: Array<{ path: string }> };
    expect(data.skippedUnsafe).toEqual([target]);
    expect(data.files.find((f) => f.path === target)).toBeUndefined();
    expect(result.summary).toContain(target);
    expect(await readFile(join(root, target), "utf8")).toBe(body);
  });

  it("clean over-cap file trims normally alongside nothing unsafe", async () => {
    const target = "packages/fixture-pkg/src/page.astro";
    const items = [
      "RFC-0001: first.",
      "RFC-0002: second.",
      "RFC-0003: third.",
      "RFC-0004: fourth.",
      "RFC-0005: fifth.",
      "RFC-0006: sixth.",
    ];
    await writeFile(join(root, target), ASTRO(items));

    const result = await runCompassSummaryTrim(makeInput(), makeContext(root));
    expect(result.exitCode).toBe(0);
    const data = result.data as {
      skippedUnsafe: string[];
      files: Array<{ path: string; kept: number }>;
    };
    expect(data.skippedUnsafe).toEqual([]);
    const entry = data.files.find((f) => f.path === target);
    expect(entry?.kept).toBe(5);
    const after = await readFile(join(root, target), "utf8");
    expect(after).toContain("RFC-0006");
    expect(after).not.toContain("RFC-0001: first.");
  });
});
