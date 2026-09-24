/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge doctor --fix — safe remediations for warn/fail
checks: nested-AGENTS.md regeneration and memory-layer compaction (RFC-1151).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1151: initial doctor --fix tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../onboarding/doctor.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../types.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "doctor-fix-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeContext(dryRun = false): ForgeRuntimeContext {
  return {
    workspaceRoot: tempDir,
    logger: {
      section: () => {},
      success: () => {},
      warn: () => {},
      error: () => {},
      info: () => {},
    },
    dryRun,
    outputFormat: "json",
  };
}

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
`;

const GENERATED_MARKER =
  "<!--\n  GENERATED. Do not change this line unless the file contains project specific changes.\n-->\n";

async function makeStaleWorkspace(): Promise<void> {
  await mkdir(join(tempDir, "packages", "my-pkg"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-pkg", "package.json"),
    JSON.stringify({ name: "@test/my-pkg" }),
  );
  // Generated marker + outdated content → stale
  await writeFile(
    join(tempDir, "packages", "my-pkg", "AGENTS.md"),
    `${GENERATED_MARKER}# Old content\n`,
    "utf8",
  );
}

test("doctor --fix regenerates stale nested AGENTS.md and subsequent run passes", async () => {
  await writeFile(join(tempDir, "forge.yaml"), FORGE_YAML, "utf8");
  await makeStaleWorkspace();

  const fixInput: ForgeCommandInput = { argv: [], flags: { fix: true } };
  const fixResult = await runDoctor(fixInput, makeContext());

  const fixEntry = fixResult.data!.fixes?.find((f) => f.check === "nested-AGENTS.md");
  expect(fixEntry).toBeDefined();
  expect(fixEntry!.action).toBe("fixed");

  const regenerated = await readFile(
    join(tempDir, "packages", "my-pkg", "AGENTS.md"),
    "utf8",
  );
  expect(regenerated).toContain("`@test/my-pkg` — Agent Guide");
  expect(regenerated).not.toContain("Old content");

  // Subsequent doctor run: nested-AGENTS.md no longer reports this file stale
  const verifyResult = await runDoctor({ argv: [], flags: {} }, makeContext());
  const check = verifyResult.data!.checks.find((c) => c.name === "nested-AGENTS.md");
  expect(check!.message).not.toContain("my-pkg/AGENTS.md stale");
});

test("doctor --fix does not modify hand-written nested AGENTS.md", async () => {
  await writeFile(join(tempDir, "forge.yaml"), FORGE_YAML, "utf8");
  await mkdir(join(tempDir, "packages", "my-pkg"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "my-pkg", "package.json"),
    JSON.stringify({ name: "@test/my-pkg" }),
  );
  const handwritten = "# Custom\nNo marker.\n";
  await writeFile(join(tempDir, "packages", "my-pkg", "AGENTS.md"), handwritten, "utf8");

  const result = await runDoctor({ argv: [], flags: { fix: true } }, makeContext());
  expect(result.data!.fixes).toBeDefined();

  const after = await readFile(join(tempDir, "packages", "my-pkg", "AGENTS.md"), "utf8");
  expect(after).toBe(handwritten);
});

test("doctor --fix compacts over-budget MEMORY.md", async () => {
  await writeFile(join(tempDir, "forge.yaml"), FORGE_YAML, "utf8");
  await mkdir(join(tempDir, ".agents", "memory"), { recursive: true });
  const env = Array.from({ length: 30 }, (_, i) => `- env ${i} ${"x".repeat(200)}`).join("\n");
  await writeFile(
    join(tempDir, ".agents", "memory", "MEMORY.md"),
    `# Project Memory\n\n## Current focus\n\n- keep\n\n## Environment notes\n\n${env}\n`,
    "utf8",
  );

  const result = await runDoctor({ argv: [], flags: { fix: true } }, makeContext());
  const fixEntry = result.data!.fixes?.find((f) => f.check === "memory-layer");
  expect(fixEntry).toBeDefined();
  expect(fixEntry!.action).toBe("fixed");

  const after = await readFile(join(tempDir, ".agents", "memory", "MEMORY.md"), "utf8");
  expect(after.length).toBeLessThanOrEqual(4096);
  expect(after).toContain("- keep");
});

test("doctor without --fix produces no fixes array and does not mutate", async () => {
  await writeFile(join(tempDir, "forge.yaml"), FORGE_YAML, "utf8");
  await makeStaleWorkspace();

  const result = await runDoctor({ argv: [], flags: {} }, makeContext());
  expect(result.data!.fixes).toBeUndefined();

  const after = await readFile(join(tempDir, "packages", "my-pkg", "AGENTS.md"), "utf8");
  expect(after).toContain("Old content");
});
