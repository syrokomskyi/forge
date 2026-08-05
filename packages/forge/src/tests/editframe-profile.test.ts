/*
<MODULE_CONTRACT>
<purpose>Unit tests for the editframe stack profile — verifies domain fields, terminology, artifacts, workspaceTypes, invariants, and detect markers.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0641: initial editframe-html profile tests.</item>
  <item>RFC-0694: update for editframe profile rename and React template.</item>
</CHANGE_SUMMARY>
*/

import { test, expect } from "vitest";
import { join } from "node:path";
import { loadStackProfile, stackProfileSchema } from "../profiles/stack-profile.ts";

const FORGE_ROOT = join(import.meta.dirname, "..", "..");
const PROFILE_PATH = join(FORGE_ROOT, "profiles", "editframe.yaml");

test("loadStackProfile succeeds on editframe.yaml", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.id).toBe("editframe");
});

test("stackProfileSchema.safeParse succeeds on editframe profile", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  const result = stackProfileSchema.safeParse(profile);
  expect(result.success).toBe(true);
});

test("editframe profile declares domain: video", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.domain).toBe("video");
});

test("editframe profile declares register: creative", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.register).toBe("creative");
});

test("editframe profile declares terminology map with artifact, module, operator", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.terminology?.artifact).toBe("composition");
  expect(profile.terminology?.module).toBe("scene");
  expect(profile.terminology?.operator).toBe("director");
});

test("editframe profile declares artifacts with composition extensions", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.artifacts).toBeDefined();
  expect(profile.artifacts?.length).toBeGreaterThanOrEqual(1);
  const composition = profile.artifacts?.find((a) => a.id === "composition");
  expect(composition).toBeDefined();
  expect(composition?.extensions).toContain(".tsx");
  expect(composition?.produce?.command).toBe("editframe render");
  expect(composition?.validate?.command).toBe("editframe check");
});

test("editframe profile declares workspaceTypes with composition detection markers", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.workspaceTypes).toBeDefined();
  const compositionType = profile.workspaceTypes?.find((w) => w.id === "composition");
  expect(compositionType).toBeDefined();
  expect(compositionType?.detect.glob).toBe("*.tsx");
  expect(compositionType?.detect.contains).toBe("TimelineRoot");
  expect(compositionType?.detect.packageJsonDep).toBe("@editframe/react");
});

test("editframe profile declares detect.anyOf with editframe.config.*", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.detect.anyOf).toContain("editframe.config.*");
});

test("editframe profile declares at least 3 VIDEO-* invariants", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.invariants).toBeDefined();
  const videoInvariants = profile.invariants?.filter((i) => i.id.startsWith("VIDEO-"));
  expect(videoInvariants?.length).toBeGreaterThanOrEqual(9);
});

test("editframe profile includes workspace layout with compositions/ directory", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.workspace.dirs).toContain("compositions");
});

test("editframe profile includes first workspace template with sample React composition", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.firstWorkspace).toBeDefined();
  expect(profile.firstWorkspace?.path).toBe("compositions/my-first-video");
  const tsxFile = profile.firstWorkspace?.files.find((f) => f.path === "composition.tsx");
  expect(tsxFile).toBeDefined();
  expect(tsxFile?.content).toContain("TimelineRoot");
  expect(tsxFile?.content).toContain("@editframe/react");
});

test("editframe profile includes @warpgogol/forge in install steps", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  const hasForge = profile.install.some((cmd) => cmd.includes("@warpgogol/forge"));
  expect(hasForge).toBe(true);
});

test("editframe profile invariants use attribute-pattern with elements array", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  const attrPatternInvariants = profile.invariants?.filter(
    (i) => i.check?.kind === "attribute-pattern",
  );
  expect(attrPatternInvariants?.length).toBeGreaterThanOrEqual(4);
  for (const inv of attrPatternInvariants ?? []) {
    expect(inv.check?.elements).toBeDefined();
    expect(inv.check?.elements?.length).toBeGreaterThan(0);
    expect(inv.check?.elements).toContain("Timegroup");
    expect(inv.check?.attribute).toBeDefined();
    expect(inv.check?.pattern).toBeDefined();
  }
});
