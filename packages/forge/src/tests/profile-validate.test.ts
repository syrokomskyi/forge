/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.profile.validate command handler (RFC-0640).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0640: initial profile-validate tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProfileValidate } from "../onboarding/profile-validate.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../types.ts";

let tempDir: string;
let profilesDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "profile-validate-test-"));
  profilesDir = join(tempDir, "profiles");
  await mkdir(profilesDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeContext(forgeRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot: tempDir,
    forgeRoot,
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

test("profile.validate returns valid when profiles directory has valid YAML", async () => {
  await writeFile(
    join(profilesDir, "test-profile.yaml"),
    `schema: "forge/stack-profile@1"\nid: test-profile\ndisplayName: Test Profile\ndetect:\n  anyOf:\n    - "package.json"\nworkspace:\n  dirs:\n    - "packages"\n  files: []\ninstall: []\n`,
    "utf8",
  );

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runProfileValidate(input, makeContext(tempDir));

  expect(result.data!.valid).toBe(true);
  expect(result.data!.profiles).toHaveLength(1);
  expect(result.data!.profiles[0].id).toBe("test-profile");
  expect(result.data!.profiles[0].valid).toBe(true);
  expect(result.exitCode).toBe(0);
});

test("profile.validate returns invalid when profile has schema errors", async () => {
  await writeFile(
    join(profilesDir, "bad-profile.yaml"),
    `schema: "forge/stack-profile@1"\nid: ""\ndisplayName: Bad\ndetect:\n  anyOf: []\nworkspace:\n  dirs: []\n  files: []\n`,
    "utf8",
  );

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runProfileValidate(input, makeContext(tempDir));

  expect(result.data!.valid).toBe(false);
  expect(result.data!.profiles).toHaveLength(1);
  expect(result.data!.profiles[0].valid).toBe(false);
  expect(result.data!.profiles[0].errors.length).toBeGreaterThan(0);
  expect(result.exitCode).toBe(1);
});

test("profile.validate --id filters to single profile", async () => {
  await writeFile(
    join(profilesDir, "alpha.yaml"),
    `schema: "forge/stack-profile@1"\nid: alpha\ndisplayName: Alpha\ndetect:\n  anyOf: ["package.json"]\nworkspace:\n  dirs: ["packages"]\n  files: []\ninstall: []\n`,
    "utf8",
  );
  await writeFile(
    join(profilesDir, "beta.yaml"),
    `schema: "forge/stack-profile@1"\nid: beta\ndisplayName: Beta\ndetect:\n  anyOf: ["package.json"]\nworkspace:\n  dirs: ["packages"]\n  files: []\ninstall: []\n`,
    "utf8",
  );

  const input: ForgeCommandInput = { argv: [], flags: { id: "alpha" } };
  const result = await runProfileValidate(input, makeContext(tempDir));

  expect(result.data!.profiles).toHaveLength(1);
  expect(result.data!.profiles[0].id).toBe("alpha");
});

test("profile.validate returns valid=true with empty profiles when directory missing", async () => {
  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runProfileValidate(input, makeContext(join(tempDir, "nonexistent")));

  expect(result.data!.valid).toBe(true);
  expect(result.data!.profiles).toHaveLength(0);
  expect(result.exitCode).toBe(0);
});

test("profile.validate validates profiles with domain fields (RFC-0638)", async () => {
  await writeFile(
    join(profilesDir, "domain-profile.yaml"),
    `schema: "forge/stack-profile@1"\nid: domain-profile\ndisplayName: Domain Profile\ndetect:\n  anyOf: ["package.json"]\nworkspace:\n  dirs: ["packages"]\n  files: []\ninstall: []\ndomain: video\nterminology:\n  artifact: composition\nartifacts:\n  - id: video\n    extensions: [".mp4"]\nworkspaceTypes:\n  - id: scene\n    detect:\n      glob: "*.scene"\ninvariants:\n  - id: VIDEO-01\n    rule: "All videos must have audio"\n    severity: error\nregister: creative\n`,
    "utf8",
  );

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runProfileValidate(input, makeContext(tempDir));

  expect(result.data!.valid).toBe(true);
  expect(result.data!.profiles[0].valid).toBe(true);
});
