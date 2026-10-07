/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.doctor skills-unmanaged check (RFC-1226): SKILL.md-bearing dirs without .forge-managed are reported as warnings.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1226: initial tests — AC-1 warn on unmanaged, AC-2 pass when all marked, AC-3 skip non-skill dirs, AC-4 skip without config/skillsDir.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../onboarding/doctor.ts";
import { buildSkillMarkerContent } from "../onboarding/skill-markers.ts";
import type { ForgeRuntimeContext, ForgeLogger } from "../types.ts";

const mockLogger: ForgeLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

const mockContext = (workspaceRoot: string): ForgeRuntimeContext => ({
  workspaceRoot,
  logger: mockLogger,
  dryRun: false,
  outputFormat: "json",
});

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-doctor-unmanaged-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const FORGE_YAML = `schema: forge/config@1
project:
  name: test
  stack: []
  packageManager: pnpm
paths:
  rfcsDir: docs/rfcs
  adrsDir: docs/adrs
  plansDir: docs/plans
  auditsDir: docs/audits
  specsDir: docs/specs
  skillsDir: .agents/skills
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

const SKILL_MD = "---\nname: test-skill\ndescription: test\n---\n# Test\n";

async function writeSkill(dir: string, name: string, managed: boolean): Promise<void> {
  const skillDir = join(dir, ".agents", "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), SKILL_MD, "utf8");
  if (managed) {
    await writeFile(
      join(skillDir, ".forge-managed"),
      buildSkillMarkerContent(["SKILL.md"]),
      "utf8",
    );
  }
}

function findCheck(result: Awaited<ReturnType<typeof runDoctor>>) {
  const check = result.data?.checks.find((c) => c.name === "skills-unmanaged");
  expect(check, "skills-unmanaged check must be present").toBeDefined();
  return check!;
}

test("AC-1: skills-unmanaged warns and names SKILL.md-bearing dirs without .forge-managed", async () => {
  await writeFile(join(tempDir, "forge.yaml"), FORGE_YAML, "utf8");
  await mkdir(join(tempDir, ".agents", "skills"), { recursive: true });
  await writeSkill(tempDir, "fo-managed-skill", true);
  await writeSkill(tempDir, "ask-matt", false);
  await writeSkill(tempDir, "tdd", false);

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const check = findCheck(result);
  expect(check.status).toBe("warn");
  expect(check.message).toContain("2 unmanaged skill dir(s)");
  expect(check.message).toContain("ask-matt");
  expect(check.message).toContain("tdd");
  expect(check.message).not.toContain("fo-managed-skill");
});

test("AC-2: skills-unmanaged passes when every SKILL.md-bearing dir carries .forge-managed", async () => {
  await writeFile(join(tempDir, "forge.yaml"), FORGE_YAML, "utf8");
  await mkdir(join(tempDir, ".agents", "skills"), { recursive: true });
  await writeSkill(tempDir, "fo-managed-skill", true);
  await writeSkill(tempDir, "grilling", true);

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const check = findCheck(result);
  expect(check.status).toBe("pass");
});

test("AC-3: skills-unmanaged excludes dirs without SKILL.md regardless of markers", async () => {
  await writeFile(join(tempDir, "forge.yaml"), FORGE_YAML, "utf8");
  const sharedDir = join(tempDir, ".agents", "skills", "_shared");
  await mkdir(sharedDir, { recursive: true });
  await writeFile(join(sharedDir, "notes.md"), "# support files\n", "utf8");
  const knowledgeDir = join(tempDir, ".agents", "skills", "knowledge");
  await mkdir(knowledgeDir, { recursive: true });
  await writeFile(join(knowledgeDir, "learned-principles.md"), "# L2\n", "utf8");

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const check = findCheck(result);
  expect(check.status).toBe("pass");
});

test("AC-4: skills-unmanaged passes without scanning when forge.yaml or skillsDir is absent", async () => {
  // No forge.yaml at all
  const noConfig = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  expect(findCheck(noConfig).status).toBe("pass");

  // forge.yaml present, skillsDir absent
  await writeFile(join(tempDir, "forge.yaml"), FORGE_YAML, "utf8");
  const noSkillsDir = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  expect(findCheck(noSkillsDir).status).toBe("pass");
});
