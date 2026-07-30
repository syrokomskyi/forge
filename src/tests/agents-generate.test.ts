/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.agents.generate — behavioral layer generation,
routing table, conditional extended layer, markers, and idempotency (RFC-0548, RFC-0549).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0548: initial agents-generate tests for behavioral layer.</item>
  <item>RFC-0549: added tests for nine extended sections and key policy phrases.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentsGenerate } from "../onboarding/agents-generate.ts";
import type { ForgeRuntimeContext } from "../types.ts";

const silentLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

const FORGE_ROOT = join(import.meta.dirname, "..", "..");
const WORKSPACE_ROOT = join(FORGE_ROOT, "..", "..");

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: silentLogger as never,
    dryRun: false,
    outputFormat: "json",
    forgeRoot: FORGE_ROOT,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agents-gen-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function makeForgeYaml(dir: string): Promise<void> {
  const forgeYaml = [
    "schema: forge/config@1",
    "project:",
    "  name: test-project",
    "  stack: [typescript]",
    "  packageManager: pnpm",
    "paths:",
    "  rfcsDir: docs/rfcs",
    "  adrsDir: docs/adrs",
    "  plansDir: docs/plans",
    "  auditsDir: docs/audits",
    "  specsDir: docs/specs",
    "  skillsDir: .agents/skills",
    "bindings:",
    "  schema: forge/bindings@1",
    "  commands:",
    "    validateRfc: pnpm exec forge rfc.validate",
    "    validateAdr: pnpm exec forge adr.validate",
    "    typecheck: null",
    "    test: null",
    "    scopedBuild: null",
    "    implementStamp: pnpm exec forge rfc.implement.stamp",
    "    specValidate: pnpm exec forge spec.validate",
    "    sessionSave: pnpm exec forge session.save",
    "  paths:",
    "    invariantsFile: docs/architecture-dna.md",
    "    reviewsDir: docs/reviews",
    "    handoffsDir: docs/handoffs",
    "    sessionsDir: docs/sessions",
    "    compassDocs: [docs/requirements.xml]",
    "forge:",
    "  syncedVersion: 0.1.2",
  ].join("\n");
  await writeFile(join(dir, "forge.yaml"), forgeYaml, "utf8");
}

test("agents-generate produces AGENTS.md with behavioral layer markers", async () => {
  await makeForgeYaml(tempDir);
  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  expect(agentsMd).toContain("<!-- forge:begin behavioral-layer -->");
  expect(agentsMd).toContain("<!-- forge:end behavioral-layer -->");
});

test("agents-generate includes intent-to-skill routing table", async () => {
  await makeForgeYaml(tempDir);
  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  expect(agentsMd).toContain("### Intent-to-skill routing");
  expect(agentsMd).toContain("| Operator says something like | Skill |");
  // Should contain at least one skill name from the registry
  expect(agentsMd).toContain("fo-");
});

test("agents-generate includes fixed policy text sections", async () => {
  await makeForgeYaml(tempDir);
  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  expect(agentsMd).toContain("### Auto-grilling");
  expect(agentsMd).toContain("### Creator-facing communication");
  expect(agentsMd).toContain("### Safety net and graceful failure");
  expect(agentsMd).toContain("### Adaptive learning");
  expect(agentsMd).toContain("### Pushback policy");
});

test("agents-generate defaults to business register (no extended layer)", async () => {
  await makeForgeYaml(tempDir);
  // No PREFERENCES.md → defaults to business
  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  expect(agentsMd).toContain("The current register is **business**");
  expect(agentsMd).not.toContain("Extended behavioral layer (RFC-0549)");
});

test("agents-generate includes extended layer when register is creative", async () => {
  await makeForgeYaml(tempDir);
  await writeFile(
    join(tempDir, "PREFERENCES.md"),
    "---\naiLanguage: en\ndocumentationLanguage: en\nregister: creative\n---\n",
    "utf8",
  );

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  expect(agentsMd).toContain("The current register is **creative**");
  expect(agentsMd).toContain("Extended behavioral layer (creative register)");
});

test("agents-generate extended layer includes all nine sections when creative", async () => {
  await makeForgeYaml(tempDir);
  await writeFile(
    join(tempDir, "PREFERENCES.md"),
    "---\naiLanguage: en\ndocumentationLanguage: en\nregister: creative\n---\n",
    "utf8",
  );

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  expect(agentsMd).toContain("#### Personal connection");
  expect(agentsMd).toContain("#### Creative memory");
  expect(agentsMd).toContain("#### Emotional rhythm");
  expect(agentsMd).toContain("#### Gentle accountability");
  expect(agentsMd).toContain("#### Creative partnership");
  expect(agentsMd).toContain("#### Visual thinking");
  expect(agentsMd).toContain("#### Audience empathy");
  expect(agentsMd).toContain("#### Creative companion");
  expect(agentsMd).toContain("#### Creative confidence");
});

test("agents-generate extended layer includes key policy phrases when creative", async () => {
  await makeForgeYaml(tempDir);
  await writeFile(
    join(tempDir, "PREFERENCES.md"),
    "---\naiLanguage: en\ndocumentationLanguage: en\nregister: creative\n---\n",
    "utf8",
  );

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  // Questions not declarations
  expect(agentsMd).toContain("do NOT declare");
  // Outcome-based praise
  expect(agentsMd).toContain("outcome-based praise");
  // Never refuse creative direction
  expect(agentsMd).toContain("Never refuse creative direction");
  // Companion mode session saving flag
  expect(agentsMd).toContain("saveCompanionSessions");
  // Inspiration feed pull-only
  expect(agentsMd).toContain("pull-only");
});

test("agents-generate extended layer is absent when register is business", async () => {
  await makeForgeYaml(tempDir);
  await writeFile(
    join(tempDir, "PREFERENCES.md"),
    "---\naiLanguage: en\ndocumentationLanguage: en\nregister: business\n---\n",
    "utf8",
  );

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(0);

  const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
  expect(agentsMd).not.toContain("Extended behavioral layer (creative register)");
  expect(agentsMd).not.toContain("#### Personal connection");
  expect(agentsMd).not.toContain("#### Creative companion");
});

test("agents-generate is idempotent — running twice produces the same content", async () => {
  await makeForgeYaml(tempDir);

  const ctx = makeContext(tempDir);
  await runAgentsGenerate({ argv: [], flags: {} }, ctx);
  const first = await readFile(join(tempDir, "AGENTS.md"), "utf8");

  await runAgentsGenerate({ argv: [], flags: {} }, ctx);
  const second = await readFile(join(tempDir, "AGENTS.md"), "utf8");

  expect(second).toBe(first);
});

test("agents-generate refuses to overwrite hand-written AGENTS.md", async () => {
  await makeForgeYaml(tempDir);
  await writeFile(join(tempDir, "AGENTS.md"), "# Hand-written\nNo marker.\n", "utf8");

  const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(1);
  expect(result.data?.status).toBe("fail");
});
