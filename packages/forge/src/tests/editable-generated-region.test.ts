/*
<MODULE_CONTRACT>
<purpose>Unit tests for the RFC-1153 preservation boundary — splitEditableGenerated
and mergeEditableGenerated (forge:custom marker + canonical-footer fallback),
plus an integration pass through generateNestedAgentsMd on a temp workspace.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1153: initial boundary merge tests — marker, footer fallback, fail-closed, comment styles, CRLF, integration.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  splitEditableGenerated,
  mergeEditableGenerated,
  canonicalFooterOf,
} from "../utils/editable-region.ts";
import {
  CUSTOM_BOUNDARY_HINTS,
  CUSTOM_BOUNDARY_MARKERS,
  buildGeneratedHeader,
} from "../utils/generated-marker.ts";
import { generateNestedAgentsMd } from "../onboarding/nested-agents-generate.ts";
import { loadForgeConfig } from "../config/forge-config.ts";

const MD = "AGENTS.md";
const MD_MARKER = CUSTOM_BOUNDARY_MARKERS["block-html"]; // <!-- forge:custom -->
const MD_HINT = CUSTOM_BOUNDARY_HINTS["block-html"];

const FOOTER = "See the root `AGENTS.md` for project-wide rules, skills, and capabilities.";

function render(body: string): string {
  return `${buildGeneratedHeader({ filePath: MD, ownerCommand: "forge.agents.generate", editable: true })}\n${body}\n\n${FOOTER}\n`;
}

test("AC-1: content below the forge:custom marker is preserved byte-identical", () => {
  const tail = "\n## Workspace rules\n\n- always run pnpm test first\n- custom note\n";
  const existing = `${render("old body v1")}${MD_MARKER}\n${MD_HINT}\n${tail}`;
  const merged = mergeEditableGenerated(render("fresh body v2"), existing, MD);
  expect(merged).not.toBeNull();
  // Fresh head regenerated, tail below the marker verbatim
  expect(merged).toContain("fresh body v2");
  expect(merged).not.toContain("old body v1");
  expect(
    merged!.endsWith(tail.trimStart() === tail ? tail : `\n${tail}`) || merged!.includes(tail),
  ).toBe(true);
  expect(merged).toContain(MD_MARKER);
});

test("marker line itself belongs to the generated head — operator-placed marker also merges", () => {
  const tail = "everything below survives\n";
  const existing = `hand-tuned intro\n${MD_MARKER}\n${tail}`;
  const merged = mergeEditableGenerated(render("body"), existing, MD);
  expect(merged).toBe(`${render("body")}${MD_MARKER}\n${MD_HINT}\n${tail}`);
});

test("AC-2: footer fallback preserves text below the canonical template footer", () => {
  const tail = "\noperator-appended rules\n";
  const existing = `${render("stale body")}${tail}`; // marker-less, ends with footer + tail
  const merged = mergeEditableGenerated(render("new body"), existing, MD);
  expect(merged).not.toBeNull();
  expect(merged!.endsWith(tail)).toBe(true);
});

test("AC-3: footer-fallback merge introduces the forge:custom marker as the new boundary", () => {
  const existing = `${render("body")}\ncustom tail\n`;
  const merged = mergeEditableGenerated(render("body"), existing, MD);
  expect(merged).toContain(MD_MARKER);
  expect(merged).toContain(MD_HINT);
});

test("AC-5: footer-less marker-less divergent content returns null — caller must skip", () => {
  const existing = `${buildGeneratedHeader({ filePath: MD, ownerCommand: "forge.agents.generate", editable: true })}\n# Custom\n\ntotally divergent, no footer\n`;
  expect(mergeEditableGenerated(render("body"), existing, MD)).toBeNull();
});

test("identical content is a clean regeneration — marker appended for future runs", () => {
  const r = render("body");
  const merged = mergeEditableGenerated(r, r, MD);
  expect(merged).toBe(`${r}${MD_MARKER}\n${MD_HINT}\n`);
});

test("new file (existing null) gains the boundary marker and hint", () => {
  const merged = mergeEditableGenerated(render("body"), null, MD);
  expect(merged).toBe(`${render("body")}${MD_MARKER}\n${MD_HINT}\n`);
});

test("AC-4: boundary marker is emitted in the comment style of the target file", () => {
  for (const [file, style] of [
    ["AGENTS.md", "block-html"],
    ["config.ts", "line-slash"],
    ["data.yaml", "line-hash"],
    ["styles.css", "block-css"],
  ] as const) {
    const merged = mergeEditableGenerated("content\n", null, file);
    expect(merged, `marker for ${file} must use ${style} comment syntax`).toContain(
      CUSTOM_BOUNDARY_MARKERS[style],
    );
  }
});

test("CRLF input normalizes to LF and still resolves the marker boundary", () => {
  const tail = "preserved tail\n";
  const existing = `a\r\nb\r\n${MD_MARKER}\r\n${tail}`;
  const merged = mergeEditableGenerated("fresh\n", existing, MD);
  expect(merged).toBe(`fresh\n${MD_MARKER}\n${MD_HINT}\n${tail}`);
  expect(merged).not.toContain("\r\n");
});

test("mid-file marker freezes everything below the first occurrence", () => {
  const tail = "mid doc\nfrozen rules\n";
  const existing = `intro\n${MD_MARKER}\n${tail}`;
  const merged = mergeEditableGenerated(render("body"), existing, MD);
  expect(merged!.endsWith(tail)).toBe(true);
});

test("forge:custom token in prose is treated as a boundary (first occurrence wins)", () => {
  const existing = `notes on the forge:custom feature\nkept anyway\n`;
  const split = splitEditableGenerated(existing, MD);
  expect(split.boundary).toBe("marker");
  expect(split.customTail).toBe("kept anyway\n");
});

test("boundary none: split returns whole content as head", () => {
  const split = splitEditableGenerated("plain\nfile\n", MD, FOOTER);
  expect(split.boundary).toBe("none");
  expect(split.customTail).toBeNull();
});

test("canonicalFooterOf returns the last non-empty line", () => {
  expect(canonicalFooterOf("a\nb\n\n\n")).toBe("b");
  expect(canonicalFooterOf("x\n")).toBe("x");
});

// --- Integration through the real write path -----------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "editable-region-it-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const FORGE_YAML = `schema: "forge/config@1"
project:
  name: test-project
  stack: []
  packageManager: pnpm
paths:
  rfcsDir: docs/rfcs
  adrsDir: docs/adrs
  plansDir: docs/plans
  auditsDir: docs/audits
  specsDir: docs/specs
  skillsDir: .agents/skills
  sessionsDir: docs/sessions
bindings:
  schema: forge/bindings@1
  commands:
    validateRfc: null
    validateAdr: null
    implementStamp: null
    typecheck: null
    test: null
    scopedBuild: null
    specValidate: null
    sessionSave: null
  paths:
    invariantsFile: null
    compassDocs: []
    reviewsDir: null
    handoffsDir: null
    sessionsDir: null
`;

test("generateNestedAgentsMd regenerates the head and preserves the custom tail", async () => {
  await writeFile(join(tempDir, "forge.yaml"), FORGE_YAML, "utf8");
  await mkdir(join(tempDir, "packages", "pkg"), { recursive: true });
  await writeFile(join(tempDir, "packages", "pkg", "package.json"), '{"name":"pkg"}', "utf8");

  const config = loadForgeConfig(tempDir);

  // First run — fresh file gains the marker + hint
  const first = await generateNestedAgentsMd(tempDir, config, false);
  expect(first.generated).toContain(join("packages", "pkg", "AGENTS.md"));
  const agentsPath = join(tempDir, "packages", "pkg", "AGENTS.md");
  const initial = await readFile(agentsPath, "utf8");
  expect(initial).toContain(MD_MARKER);
  expect(initial).toContain(MD_HINT);

  // Operator appends a custom section below the boundary
  await appendFile(agentsPath, "\n## Workspace rules\n\n- never touch dist/\n", "utf8");

  // Second run — head regenerated, tail preserved verbatim
  const second = await generateNestedAgentsMd(tempDir, config, false);
  expect(second.preserved).toContain(join("packages", "pkg", "AGENTS.md"));
  const merged = await readFile(agentsPath, "utf8");
  expect(merged).toContain("## Workspace rules");
  expect(merged).toContain("- never touch dist/");
  // Boundary sits between generated head and custom tail
  expect(merged.indexOf(MD_MARKER)).toBeLessThan(merged.indexOf("## Workspace rules"));
});

test("generateNestedAgentsMd skips a divergent file without a resolvable boundary", async () => {
  await writeFile(join(tempDir, "forge.yaml"), FORGE_YAML, "utf8");
  await mkdir(join(tempDir, "packages", "legacy"), { recursive: true });
  await writeFile(join(tempDir, "packages", "legacy", "package.json"), '{"name":"legacy"}', "utf8");
  // Marker-bearing (isGenerated) file whose body diverges and lacks the footer
  await writeFile(
    join(tempDir, "packages", "legacy", "AGENTS.md"),
    `${buildGeneratedHeader({ filePath: "AGENTS.md", ownerCommand: "forge.agents.generate", editable: true })}\n# Hand-maintained\n\ndivergent body\n`,
    "utf8",
  );

  const config = loadForgeConfig(tempDir);
  const result = await generateNestedAgentsMd(tempDir, config, false);
  const skippedEntry = result.skipped.find((s) => s.includes("legacy"));
  expect(
    skippedEntry,
    "Divergent file without forge:custom/footer boundary must be skipped as unmapped-customization",
  ).toContain("unmapped-customization");
  // File untouched
  const content = await readFile(join(tempDir, "packages", "legacy", "AGENTS.md"), "utf8");
  expect(content).toContain("divergent body");
});
