/*
<MODULE_CONTRACT>
<purpose>RFC-1481 regression test that forge doctor reports unresolved knowledge ID conflicts without requiring forge.upgrade.</purpose>
<non-goals>
  <item>Not a contract source of truth — RFC-1481 and doctor.ts own the behavior.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1481: test first — doctor surfaces planKnowledgeSync conflicts.</item>
  <item>RFC-1481: add knowledge collision resolution and surfacing

Add the explicit resolver, namespace-aware parsing and validation, safe reference remapping, doctor/upgrade hints, and regression coverage.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDoctor } from "../onboarding/doctor.ts";
import { FORGE_SKILLS } from "../registry.ts";
import { ambientIo } from "../utils/io.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../types.ts";

let tempDir: string;

const input: ForgeCommandInput = { argv: [], flags: {} };

function makeContext(): ForgeRuntimeContext {
  return {
    workspaceRoot: tempDir,
    io: ambientIo,
    logger: { section() {}, success() {}, warn() {}, error() {}, info() {} },
    outputFormat: "json",
    dryRun: false,
  } as unknown as ForgeRuntimeContext;
}

function entry(id: string, body: string): string {
  return `### ${id}: Same title

\`\`\`knowledge-entry
id: ${id}
layer: L2
created: 2026-08-03
lastConfirmedAt: 2026-08-03
confirmations: 1
status: active
\`\`\`

${body}
`;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "doctor-knowledge-conflicts-"));
  const forgeRoot = join(tempDir, "packages", "forge");
  await mkdir(join(forgeRoot, "skills"), { recursive: true });
  await writeFile(join(forgeRoot, "package.json"), '{"name":"@warpgogol/forge","version":"9.0.0"}');

  const skill = FORGE_SKILLS.find((candidate) => candidate.name === "fo-session-save");
  if (!skill?.knowledge?.includes("learned-principles.md")) {
    throw new Error("Fixture requires fo-session-save to declare learned-principles.md.");
  }

  const sourcePath = join(forgeRoot, skill.path);
  const sourceDir = dirname(sourcePath);
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    sourcePath,
    "---\nname: fo-session-save\nknowledge: [learned-principles.md]\n---\n# fo-session-save\n",
  );
  await writeFile(
    join(sourceDir, "learned-principles.md"),
    `<!-- knowledge-layer: L2 -->\n\n${entry("K-0007", "Upstream canonical.")}`,
  );

  await mkdir(join(tempDir, ".agents", "skills", skill.name), { recursive: true });
  await writeFile(
    join(tempDir, ".agents", "skills", skill.name, "learned-principles.md"),
    `<!-- knowledge-layer: L2 -->\n\n${entry("K-0007", "Local divergent body.")}`,
  );
  await writeFile(
    join(tempDir, "forge.yaml"),
    `schema: "forge/config@1"
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
`,
  );
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("knowledge-files warns with conflict count and resolver hint", async () => {
  const result = await runDoctor(input, makeContext());
  const check = result.data?.checks.find((candidate) => candidate.name === "knowledge-files");

  expect(check?.status).toBe("warn");
  expect(check?.message).toContain("1 knowledge id conflict");
  expect(check?.message).toContain("forge knowledge.conflicts.resolve");
});
