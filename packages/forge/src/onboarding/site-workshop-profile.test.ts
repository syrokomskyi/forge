/*
<MODULE_CONTRACT>
<purpose>Unit tests for the site-workshop stack profile (RFC-1125) — verifies the profile parses, scaffolds the workshop contract, and never scaffolds systems-cache inside the workshop root.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1125: initial site-workshop profile tests (AC-1 evidence).</item>
</CHANGE_SUMMARY>
*/

import { test, expect } from "vitest";
import { join } from "node:path";
import { listStackProfiles } from "../profiles/stack-profile.ts";

// Resolve forge root from this test file's location
const FORGE_ROOT = join(import.meta.dirname, "..", "..");

function loadSiteWorkshop() {
  const profiles = listStackProfiles(FORGE_ROOT);
  const profile = profiles.find((p) => p.id === "site-workshop");
  expect(profile, "site-workshop profile must exist in packages/forge/profiles/").toBeDefined();
  return profile!;
}

test("site-workshop profile parses and is discoverable", () => {
  const profile = loadSiteWorkshop();
  expect(profile.schema).toBe("forge/stack-profile@1");
  expect(profile.displayName).toBeTruthy();
});

test("scaffolds kernel wiring, missions/, and governance dirs — but never systems-cache", () => {
  const profile = loadSiteWorkshop();
  const dirs = profile.workspace.dirs;
  const filePaths = profile.workspace.files.map((f) => f.path);

  // AC-1: kernel wiring + missions + governance dirs present
  expect(dirs).toContain("missions");
  expect(dirs).toContain("docs");
  expect(dirs).toContain("tools");
  expect(filePaths).toContain("tools/kernel.config.ts");
  expect(filePaths).toContain("missions/.gitkeep");

  // AC-1: systems-cache is a sibling (../systems-cache), never scaffolded inside root
  expect(
    dirs,
    "systems-cache must not be a scaffolded dir — sibling convention per RFC-1125",
  ).not.toContain("systems-cache");
  expect(
    filePaths.some((p) => p.startsWith("systems-cache")),
    "no systems-cache files may be scaffolded — created by sternsystem.register on demand",
  ).toBe(false);
});

test("scaffolded kernel.config.ts consumes the single-sourced WorkshopModuleMap", () => {
  const profile = loadSiteWorkshop();
  const kernelConfig = profile.workspace.files.find((f) => f.path === "tools/kernel.config.ts");
  expect(kernelConfig, "profile must scaffold tools/kernel.config.ts").toBeDefined();
  // AC-5: the scaffolded config spreads workshopModuleLoaders() — no hand-copied loader list
  expect(kernelConfig!.content).toContain("workshopModuleLoaders");
  expect(kernelConfig!.content).toContain("@warpgogol/werkstatt-engine/kernel/module-map");
  expect(
    kernelConfig!.content,
    "kernel.config.ts must not embed per-module loader thunks — they live in WORKSHOP_MODULE_MAP",
  ).not.toContain("createMissionModule");
});

test("install set includes engine, site plugin, and forge", () => {
  const profile = loadSiteWorkshop();
  const install = profile.install.join(" ");
  expect(install).toContain("@warpgogol/werkstatt-engine");
  expect(install).toContain("@warpgogol/werkstatt-site");
  expect(install).toContain("@warpgogol/forge");
});

test("ships .npmrc token template and site-workshop nextSteps guidance", () => {
  const profile = loadSiteWorkshop();
  const npmrc = profile.workspace.files.find((f) => f.path === ".npmrc");
  expect(npmrc, "profile must scaffold .npmrc for the private @warpgogol scope").toBeDefined();
  expect(npmrc!.content).toContain("@warpgogol:registry");

  // RFC-1125: token lifecycle + identity.bootstrap guidance lives in NEXT_STEPS.md
  expect(profile.nextSteps, "profile must provide nextSteps for token/identity onboarding").toBeTruthy();
  expect(profile.nextSteps).toContain("NPM_TOKEN");
  expect(profile.nextSteps).toContain("identity.bootstrap");
});
