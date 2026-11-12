/*
<MODULE_CONTRACT>
<purpose>RFC-1578: temp-repository builder for correctness contour tests — a
minimal forge.yaml, compass requirements document, DNA file, an anchored
source file, and a manifest, each overridable per test.</purpose>
<non-goals>
  <item>Not production code — imported by *.test.ts only.</item>
  <item>Never initializes git with an exported GIT_DIR — fixture repos stay isolated.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1578: initial fixture builder.</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
</CHANGE_SUMMARY>
*/
// test-adjacency: exempt — no test reason: test support module, exercised by every correctness test

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FixtureOptions {
  mode?: string;
  tier?: string;
  manifest?: string | null;
  manifestBinding?: string | null;
  checkRun?: string | null;
  requirements?: string[];
  dna?: number[];
  files?: Record<string, string>;
}

/** Split so this file never declares an invariant itself (RFC-1390 lexical scan). */
export const MARKER = "@ai-" + "invariant";

export const ANCHORED_SOURCE = [
  "export function dispatch(): void {",
  `  // ${MARKER}[INV-dispatch-01]: dispatch queries only columns the openers migration declares`,
  "  //   (checked-by: test:src/dispatch.schema.test.ts)",
  "}",
  "",
].join("\n");

export function forgeYaml(opts: FixtureOptions): string {
  const binding =
    opts.manifestBinding === undefined ? "docs/correctness.yaml" : opts.manifestBinding;
  const lines = [
    "schema: forge/config@1",
    "project:",
    "  name: fixture",
    "paths:",
    "  rfcsDir: docs/rfcs",
    "bindings:",
    "  schema: forge/bindings@1",
    "  commands:",
    `    checkRun: ${opts.checkRun === undefined ? '"pnpm exec vitest run {file}"' : opts.checkRun === null ? "null" : JSON.stringify(opts.checkRun)}`,
    "  paths:",
    "    invariantsFile: docs/architecture-dna.md",
    "    compassDocs:",
    "      - docs/requirements.xml",
    `    correctnessManifest: ${binding === null ? "null" : binding}`,
  ];
  if (opts.mode !== undefined || opts.tier !== undefined) {
    lines.push("correctness:");
    if (opts.mode !== undefined) lines.push(`  mode: ${opts.mode}`);
    if (opts.tier !== undefined) lines.push(`  tier: ${opts.tier}`);
  }
  return `${lines.join("\n")}\n`;
}

export function requirementsXml(ids: string[]): string {
  return [
    "<requirements>",
    "  <meta>",
    "    <document-id>requirements</document-id>",
    "    <schema>forge/compass-docs@1</schema>",
    "  </meta>",
    ...ids.map((id) => `  <requirement id="${id}" priority="must">Requirement ${id}</requirement>`),
    "</requirements>",
    "",
  ].join("\n");
}

export function dnaMd(ids: number[]): string {
  return `# Architecture DNA\n\n${ids.map((n) => `## DNA-${n} · Invariant ${n}\n\nText.\n`).join("\n")}`;
}

export const BASE_MANIFEST = `schema: forge/correctness-manifest@1
entries:
  - id: CM-dispatch-01
    source: req
    ref: REQ-01
    seam: data
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:src/dispatch.schema.test.ts
        substrate: L1
support: []
exemptions: []
`;

/** Write a fixture workspace; returns its root and a cleanup callback. */
export function makeWorkspace(opts: FixtureOptions = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), "forge-correctness-"));
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  write("forge.yaml", forgeYaml(opts));
  write("docs/requirements.xml", requirementsXml(opts.requirements ?? ["REQ-01"]));
  write("docs/architecture-dna.md", dnaMd(opts.dna ?? []));
  write("src/dispatch.ts", ANCHORED_SOURCE);
  write("src/dispatch.schema.test.ts", "// oracle\n");
  if (opts.manifest !== null) write("docs/correctness.yaml", opts.manifest ?? BASE_MANIFEST);
  for (const [rel, body] of Object.entries(opts.files ?? {})) write(rel, body);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
