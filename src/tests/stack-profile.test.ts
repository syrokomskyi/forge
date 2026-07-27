/*
<MODULE_CONTRACT>
<purpose>Unit tests for stack profile schema, loader, and detector.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0392: initial stack profile tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stackProfileSchema,
  loadStackProfile,
  listStackProfiles,
  detectStack,
  type StackProfile,
} from "../profiles/stack-profile.ts";

// Resolve forge root from this test file's location
const FORGE_ROOT = join(import.meta.dirname, "..", "..");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "stack-profile-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const validProfile: StackProfile = {
  schema: "forge/stack-profile@1",
  id: "test-profile",
  displayName: "Test Profile",
  detect: { anyOf: ["astro.config.*", "tsconfig.json"] },
  workspace: {
    dirs: ["sites", "packages"],
    files: [{ path: "pnpm-workspace.yaml", content: "packages:\n  - sites/*\n  - packages/*" }],
  },
  install: ["pnpm add -D typescript"],
};

test("stackProfileSchema validates a valid profile", () => {
  const result = stackProfileSchema.safeParse(validProfile);
  expect(result.success).toBe(true);
});

test("stackProfileSchema rejects missing schema field", () => {
  const bad = { ...validProfile, schema: "wrong" };
  const result = stackProfileSchema.safeParse(bad);
  expect(result.success).toBe(false);
});

test("stackProfileSchema rejects empty detect.anyOf", () => {
  const bad = { ...validProfile, detect: { anyOf: [] } };
  const result = stackProfileSchema.safeParse(bad);
  expect(result.success).toBe(false);
});

test("loadStackProfile parses valid YAML", async () => {
  const yaml = `
schema: forge/stack-profile@1
id: my-profile
displayName: My Profile
detect:
  anyOf: ["package.json"]
workspace:
  dirs: ["src"]
  files:
    - path: package.json
      content: "{}"
install: []
`;
  const profilePath = join(tempDir, "test.yaml");
  await writeFile(profilePath, yaml, "utf8");
  const profile = loadStackProfile(profilePath);
  expect(profile.id).toBe("my-profile");
  expect(profile.workspace.dirs).toEqual(["src"]);
});

test("loadStackProfile throws on invalid YAML", async () => {
  const yaml = `schema: forge/stack-profile@1\nid: ""`;
  const profilePath = join(tempDir, "bad.yaml");
  await writeFile(profilePath, yaml, "utf8");
  expect(() => loadStackProfile(profilePath)).toThrow("failed schema validation");
});

test("listStackProfiles loads all YAML files from profiles dir", async () => {
  const profilesDir = join(tempDir, "profiles");
  await mkdir(profilesDir, { recursive: true });
  await writeFile(
    join(profilesDir, "a.yaml"),
    `schema: forge/stack-profile@1\nid: a\ndisplayName: A\ndetect:\n  anyOf: ["a.txt"]\nworkspace:\n  dirs: ["src"]\n  files: []\ninstall: []`,
    "utf8",
  );
  await writeFile(
    join(profilesDir, "b.yaml"),
    `schema: forge/stack-profile@1\nid: b\ndisplayName: B\ndetect:\n  anyOf: ["b.txt"]\nworkspace:\n  dirs: ["src"]\n  files: []\ninstall: []`,
    "utf8",
  );
  const profiles = listStackProfiles(tempDir);
  expect(profiles.length).toBe(2);
  expect(profiles.map((p) => p.id).sort()).toEqual(["a", "b"]);
});

test("listStackProfiles returns empty array when profiles dir missing", () => {
  const profiles = listStackProfiles(tempDir);
  expect(profiles).toEqual([]);
});

test("detectStack matches on anyOf glob", async () => {
  await writeFile(join(tempDir, "astro.config.mjs"), "export default {}", "utf8");
  const profiles: StackProfile[] = [
    { ...validProfile, id: "astro", detect: { anyOf: ["astro.config.*"] } },
    { ...validProfile, id: "phaser", detect: { anyOf: ["phaser.config.*"] } },
  ];
  const match = detectStack(tempDir, profiles);
  expect(match?.id).toBe("astro");
});

test("detectStack returns null when no pattern matches", async () => {
  const profiles: StackProfile[] = [
    { ...validProfile, id: "rust", detect: { anyOf: ["Cargo.toml"] } },
  ];
  const match = detectStack(tempDir, profiles);
  expect(match).toBeNull();
});

test("detectStack matches on exact filename", async () => {
  await writeFile(join(tempDir, "tsconfig.json"), "{}", "utf8");
  const profiles: StackProfile[] = [
    { ...validProfile, id: "ts", detect: { anyOf: ["tsconfig.json"] } },
  ];
  const match = detectStack(tempDir, profiles);
  expect(match?.id).toBe("ts");
});

test("shipped astro-typescript-turborepo profile validates", () => {
  const profile = loadStackProfile(join(FORGE_ROOT, "profiles", "astro-typescript-turborepo.yaml"));
  expect(profile.id).toBe("astro-typescript-turborepo");
  expect(profile.workspace.dirs.length).toBeGreaterThan(0);
});

test("shipped phaser-turborepo profile validates", () => {
  const profile = loadStackProfile(join(FORGE_ROOT, "profiles", "phaser-turborepo.yaml"));
  expect(profile.id).toBe("phaser-turborepo");
  expect(profile.workspace.dirs.length).toBeGreaterThan(0);
});

test("listStackProfiles finds both shipped profiles", () => {
  const profiles = listStackProfiles(FORGE_ROOT);
  const ids = profiles.map((p) => p.id).sort();
  expect(ids).toContain("astro-typescript-turborepo");
  expect(ids).toContain("phaser-turborepo");
});

test("all shipped profiles include @webgogol/forge in install steps", () => {
  const profiles = listStackProfiles(FORGE_ROOT);
  for (const profile of profiles) {
    const hasForge = profile.install.some((cmd) => cmd.includes("@webgogol/forge"));
    expect(hasForge).toBe(true);
  }
});

test("all shipped profiles include operator-profile.md in .gitignore content", () => {
  const profiles = listStackProfiles(FORGE_ROOT);
  for (const profile of profiles) {
    const gitignoreFile = profile.workspace.files.find((f) => f.path === ".gitignore");
    expect(gitignoreFile).toBeDefined();
    expect(gitignoreFile?.content).toContain("operator-profile.md");
  }
});
