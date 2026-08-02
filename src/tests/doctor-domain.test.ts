/*
<MODULE_CONTRACT>
<purpose>Unit tests for domain-aware forge.doctor (RFC-0640).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0640: initial domain-aware doctor tests.</item>
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
  tempDir = await mkdtemp(join(tmpdir(), "doctor-domain-test-"));
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

test("doctor reports default software domain when no forge.yaml", async () => {
  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runDoctor(input, makeContext());

  expect(result.data!.domain).toBeDefined();
  expect(result.data!.domain!.domain).toBe("software");
  expect(result.data!.domain!.source).toBe("default");
});

test("doctor reports domain from forge.yaml when present", async () => {
  await writeFile(
    join(tempDir, "forge.yaml"),
    `schema: "forge/config@1"\nproject:\n  name: test-project\n  stack: []\n  packageManager: pnpm\n  domain: video\npaths:\n  rfcsDir: docs/rfcs\n  adrsDir: docs/adrs\n  plansDir: docs/plans\n  auditsDir: docs/audits\n  specsDir: docs/specs\n  skillsDir: .agents/skills\n  sessionsDir: docs/sessions\n`,
    "utf8",
  );

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runDoctor(input, makeContext());

  expect(result.data!.domain).toBeDefined();
  expect(result.data!.domain!.domain).toBe("video");
  expect(result.data!.domain!.source).toBe("forge.yaml");
});

test("doctor includes domain-info check in checks array", async () => {
  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runDoctor(input, makeContext());

  const domainCheck = result.data!.checks.find((c) => c.name === "domain-info");
  expect(domainCheck).toBeDefined();
  expect(domainCheck!.status).toBe("pass");
});

test("doctor --strict does not affect invariant reporting (reserved for future use)", async () => {
  await mkdir(join(tempDir, "packages", "forge", "profiles"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "forge", "profiles", "test.yaml"),
    `schema: "forge/stack-profile@1"\nid: test\ndisplayName: Test\ndetect:\n  anyOf: ["package.json"]\nworkspace:\n  dirs: ["packages"]\n  files: []\ninstall: []\ndomain: video\ninvariants:\n  - id: VIDEO-01\n    rule: "All videos must have audio"\n    severity: error\n`,
    "utf8",
  );
  await writeFile(
    join(tempDir, "forge.yaml"),
    `schema: "forge/config@1"\nproject:\n  name: test-project\n  stack: ["test"]\n  packageManager: pnpm\npaths:\n  rfcsDir: docs/rfcs\n  adrsDir: docs/adrs\n  plansDir: docs/plans\n  auditsDir: docs/audits\n  specsDir: docs/specs\n  skillsDir: .agents/skills\n  sessionsDir: docs/sessions\n`,
    "utf8",
  );

  const input: ForgeCommandInput = { argv: [], flags: { strict: true } };
  const result = await runDoctor(input, makeContext());

  const invariantsCheck = result.data!.checks.find((c) => c.name === "domain-invariants");
  expect(invariantsCheck).toBeDefined();
  // --strict elevates warn to fail for domain-invariants and profile-validate,
  // but invariants check is "pass" here (invariants declared), so no elevation
  expect(invariantsCheck!.status).toBe("pass");
});

test("doctor runs nested AGENTS.md check for non-software domain (RFC-0640 fix)", async () => {
  await writeFile(
    join(tempDir, "forge.yaml"),
    `schema: "forge/config@1"\nproject:\n  name: test-project\n  stack: []\n  packageManager: pnpm\n  domain: video\npaths:\n  rfcsDir: docs/rfcs\n  adrsDir: docs/adrs\n  plansDir: docs/plans\n  auditsDir: docs/audits\n  specsDir: docs/specs\n  skillsDir: .agents/skills\n  sessionsDir: docs/sessions\n`,
    "utf8",
  );

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runDoctor(input, makeContext());

  // RFC-0640 fix: nested AGENTS.md check now runs for all domains
  // (previously gated by isSoftwareDomain, which skipped non-software domains)
  const nestedCheck = result.data!.checks.find((c) => c.name === "nested-AGENTS.md");
  expect(nestedCheck).toBeDefined();
  expect(nestedCheck!.status).toBe("pass");
});
