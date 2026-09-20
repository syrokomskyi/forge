/*
<MODULE_CONTRACT>
<purpose>Unit tests for RFC-1118 fail-closed handling of unresolvable forge.yaml profile id — profile-id-known doctor check, declared-id preservation, serializeForgeConfig, init re-detect guard.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1118: initial tests — AC-1..AC-8 plus corrupted-object recovery.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runDoctor } from "../onboarding/doctor.ts";
import { runUpgrade } from "../onboarding/upgrade.ts";
import { runInit } from "../onboarding/init.ts";
import { loadForgeConfig, serializeForgeConfig } from "../config/forge-config.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../types.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "doctor-profile-id-known-"));
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
  } as ForgeRuntimeContext;
}

const FORGE_YAML_BASE = `schema: "forge/config@1"
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

async function writeForgeYaml(extra = ""): Promise<void> {
  await writeFile(join(tempDir, "forge.yaml"), FORGE_YAML_BASE + extra, "utf8");
}

function minimalProfile(id: string, marker: string): string {
  return `schema: forge/stack-profile@1
id: ${id}
displayName: ${id} profile
detect:
  anyOf:
    - ${marker}
workspace:
  dirs:
    - docs
  files: []
`;
}

// A fake installed forge: packages/forge/package.json + profiles/<id>.yaml.
// resolveForgeRoot(workspaceRoot) picks it up via the monorepo path.
async function writeFakeForgeRoot(
  version: string,
  profiles: Array<{ id: string; marker: string }>,
): Promise<string> {
  const forgeRoot = join(tempDir, "packages", "forge");
  await mkdir(join(forgeRoot, "profiles"), { recursive: true });
  await writeFile(
    join(forgeRoot, "package.json"),
    JSON.stringify({ name: "@warpgogol/forge", version }) + "\n",
    "utf8",
  );
  for (const p of profiles) {
    await writeFile(join(forgeRoot, "profiles", `${p.id}.yaml`), minimalProfile(p.id, p.marker), "utf8");
  }
  return forgeRoot;
}

function findCheck(result: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  return result.data?.checks.find((c) => c.name === name);
}

// AC-1: unresolvable declared id → profile-id-known fails, names id + version
test("doctor fails profile-id-known when declared profile id is absent from installed catalog", async () => {
  await writeFakeForgeRoot("9.9.9", [{ id: "known-profile", marker: "marker-known.txt" }]);
  await writeForgeYaml(`profile: bogus-id\n`);

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runDoctor(input, makeContext());

  const check = findCheck(result, "profile-id-known");
  expect(check, "profile-id-known check must exist in doctor output").toBeDefined();
  expect(check!.status).toBe("fail");
  expect(check!.message).toContain("bogus-id");
  expect(check!.message).toContain("9.9.9");
  expect(result.exitCode).toBe(1);
});

// AC-2: ForgeConfig exposes profileDeclaredId + profileResolution
test("loadForgeConfig exposes profileDeclaredId and profileResolution", async () => {
  await writeFakeForgeRoot("9.9.9", [{ id: "known-profile", marker: "marker-known.txt" }]);
  await writeForgeYaml(`profile: bogus-id\n`);

  const config = loadForgeConfig(tempDir);
  expect(config.profileDeclaredId).toBe("bogus-id");
  expect(config.profileResolution).toBe("unknown");
  expect(config.profile).toBeUndefined();
});

// AC-3: no profile field → pass
test("doctor passes profile-id-known when no profile is declared", async () => {
  await writeFakeForgeRoot("9.9.9", [{ id: "known-profile", marker: "marker-known.txt" }]);
  await writeForgeYaml();

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runDoctor(input, makeContext());

  const check = findCheck(result, "profile-id-known");
  expect(check!.status).toBe("pass");
});

// AC-4: unresolvable id survives re-serialization verbatim
test("forge upgrade preserves an unresolvable declared profile id verbatim", async () => {
  const forgeRoot = await writeFakeForgeRoot("9.9.9", [
    { id: "known-profile", marker: "marker-known.txt" },
  ]);
  await writeForgeYaml(`profile: bogus-id\nforge:\n  syncedVersion: "0.0.0"\n`);

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const ctx = { ...makeContext(), forgeRoot };
  const result = await runUpgrade(input, ctx);
  expect(result.exitCode).toBe(0);

  const written = parseYaml(await readFile(join(tempDir, "forge.yaml"), "utf8")) as Record<
    string,
    unknown
  >;
  expect(
    written["profile"],
    "re-serialized forge.yaml must retain the declared id string, not drop it",
  ).toBe("bogus-id");
});

// AC-6: resolvable id serializes as the id string, not the StackProfile object
test("forge upgrade writes the profile id string, not the resolved object", async () => {
  const forgeRoot = await writeFakeForgeRoot("9.9.9", [
    { id: "known-profile", marker: "marker-known.txt" },
  ]);
  await writeForgeYaml(`profile: known-profile\nforge:\n  syncedVersion: "0.0.0"\n`);

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const ctx = { ...makeContext(), forgeRoot };
  const result = await runUpgrade(input, ctx);
  expect(result.exitCode).toBe(0);

  const written = parseYaml(await readFile(join(tempDir, "forge.yaml"), "utf8")) as Record<
    string,
    unknown
  >;
  expect(
    typeof written["profile"],
    "profile must serialize as the declared id string, not the StackProfile object",
  ).toBe("string");
  expect(written["profile"]).toBe("known-profile");
});

// AC-7: unreadable catalog → warn, not fail
test("doctor warns (not fails) when the profile catalog cannot be read", async () => {
  // No fake forge root — resolveForgeRoot falls back to a nonexistent path.
  await writeForgeYaml(`profile: bogus-id\n`);

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runDoctor(input, makeContext());

  const check = findCheck(result, "profile-id-known");
  expect(check!.status).toBe("warn");
  expect(check!.message).toContain("bogus-id");
});

// AC-8: init --from never overwrites a declared profile id
test("forge init preserves a declared profile id against conflicting detection", async () => {
  const forgeRoot = await writeFakeForgeRoot("9.9.9", [
    { id: "detected-y", marker: "marker-y.txt" },
  ]);
  await writeForgeYaml(`profile: declared-x\n`);

  // --from directory that detects as "detected-y"
  const fromDir = join(tempDir, "from-src");
  await mkdir(fromDir, { recursive: true });
  await writeFile(join(fromDir, "marker-y.txt"), "x", "utf8");

  const result = runInit(
    { flags: { from: fromDir } },
    { workspaceRoot: tempDir, forgeRoot },
  );

  const written = await readFile(join(tempDir, "forge.yaml"), "utf8");
  expect(written).toContain("profile: declared-x");
  expect(
    result.skipped.some((s) => s.includes("declared-x") && s.includes("detected-y")),
    "init must surface a warning that the declared id was preserved over the detection result",
  ).toBe(true);
});

// Corrupted state recovery: object-form profile (written by the old bug) heals to the declared id
test("loadForgeConfig recovers profileDeclaredId from a corrupted object-form profile", async () => {
  await writeFakeForgeRoot("9.9.9", [{ id: "known-profile", marker: "marker-known.txt" }]);
  await writeForgeYaml(
    `profile:\n  id: known-profile\n  displayName: known-profile profile\n`,
  );

  const config = loadForgeConfig(tempDir);
  expect(config.profileDeclaredId).toBe("known-profile");
  expect(config.profileResolution).toBe("resolved");

  // Re-serialization heals the field back to the id string
  const serialized = serializeForgeConfig(config);
  expect(serialized["profile"]).toBe("known-profile");
});
