/*
<MODULE_CONTRACT>
<purpose>Unit tests for the nested-AGENTS.md doctor check — consumer-declared
workspace discovery exclusions via bindings.workspaces.skipDirs (RFC-1150).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1150: initial nested-AGENTS.md skipDirs tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../onboarding/doctor.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../types.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "doctor-nested-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeContext(): ForgeRuntimeContext {
  return {
    workspaceRoot: tempDir,
    logger: {
      section: () => {},
      success: () => {},
      warn: () => {},
      error: () => {},
      info: () => {},
    },
    dryRun: false,
    outputFormat: "json",
  };
}

function forgeYaml(skipDirs: string[]): string {
  const skip = skipDirs.length > 0 ? `\n  workspaces:\n    skipDirs: [${skipDirs.join(", ")}]` : "";
  return `schema: "forge/config@1"
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
    sessionsDir: null${skip}
`;
}

test("nested-AGENTS.md check excludes dirs declared in workspaces.skipDirs", async () => {
  await writeFile(join(tempDir, "forge.yaml"), forgeYaml(["builds"]), "utf8");
  // Artifact dir that would otherwise be discovered as a workspace
  await mkdir(join(tempDir, "builds", "out"), { recursive: true });
  await writeFile(join(tempDir, "builds", "out", "package.json"), "{}");
  // Real workspace without AGENTS.md — must still be reported missing
  await mkdir(join(tempDir, "packages", "real-pkg"), { recursive: true });
  await writeFile(join(tempDir, "packages", "real-pkg", "package.json"), "{}");

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runDoctor(input, makeContext());

  const check = result.data!.checks.find((c) => c.name === "nested-AGENTS.md");
  expect(check).toBeDefined();
  // missing-only reports pass (warn requires stale>0) — assert on message
  expect(check!.message).toContain("packages/real-pkg");
  expect(check!.message).not.toContain("builds");
});

test("nested-AGENTS.md check reports artifact dir as missing without skipDirs", async () => {
  await writeFile(join(tempDir, "forge.yaml"), forgeYaml([]), "utf8");
  await mkdir(join(tempDir, "builds", "out"), { recursive: true });
  await writeFile(join(tempDir, "builds", "out", "package.json"), "{}");

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runDoctor(input, makeContext());

  const check = result.data!.checks.find((c) => c.name === "nested-AGENTS.md");
  expect(check).toBeDefined();
  expect(check!.message).toContain("builds");
});
