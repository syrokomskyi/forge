/*
<MODULE_CONTRACT>
<purpose>Unit tests for RFC-0638 domain-neutral profile schema extensions.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0638: initial domain field tests — parsing, defaults, validation, backward compat.</item>
</CHANGE_SUMMARY>
*/

import { test, expect } from "vitest";
import {
  stackProfileSchema,
  loadStackProfile,
  listStackProfiles,
  type StackProfile,
} from "../profiles/stack-profile.ts";
import {
  profileInvariantSchema,
  UNIVERSAL_TERMINOLOGY_KEYS,
  TERMINOLOGY_DEFAULTS,
} from "../profiles/profile-schema.ts";
import { join } from "node:path";

const FORGE_ROOT = join(import.meta.dirname, "..", "..");

const baseProfile: StackProfile = {
  schema: "forge/stack-profile@1",
  id: "test-profile",
  displayName: "Test Profile",
  detect: { anyOf: ["astro.config.*"] },
  workspace: {
    dirs: ["sites"],
    files: [{ path: "package.json", content: "{}" }],
  },
  install: [],
};

test("profile with all six domain fields parses successfully", () => {
  const profile = {
    ...baseProfile,
    domain: "video",
    register: "creative",
    terminology: {
      artifact: "composition",
      artifactPlural: "compositions",
      module: "scene",
      source: "composition file",
      output: "render",
      verify: "render-verify",
      operator: "director",
    },
    artifacts: [
      {
        id: "composition",
        extensions: [".html", ".tsx"],
        produce: { command: "ref(bindings.commands.produce)", output: "dist/renders/{name}.mp4" },
        validate: { command: "ref(bindings.commands.validate)" },
        determinism: {
          hashable: true,
          inputs: ["composition files", "assets", "editframe version"],
        },
      },
    ],
    workspaceTypes: [
      {
        id: "composition",
        detect: { glob: "*.html", contains: "ef-timegroup" },
        skills: ["ef-composition-review"],
        agentsMdTemplate: "templates/composition-agents.md",
      },
    ],
    invariants: [
      { id: "VIDEO-01", rule: "Compositions use kebab-case filenames", severity: "error" },
      { id: "VIDEO-02", rule: "Scene durations use contain mode by default", severity: "warning" },
    ],
  };
  const result = stackProfileSchema.safeParse(profile);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.domain).toBe("video");
    expect(result.data.register).toBe("creative");
    expect(result.data.artifacts).toHaveLength(1);
    expect(result.data.workspaceTypes).toHaveLength(1);
    expect(result.data.invariants).toHaveLength(2);
  }
});

test("profile with no domain fields parses successfully (backward compat)", () => {
  const result = stackProfileSchema.safeParse(baseProfile);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.domain).toBeUndefined();
    expect(result.data.terminology).toBeUndefined();
    expect(result.data.artifacts).toBeUndefined();
    expect(result.data.workspaceTypes).toBeUndefined();
    expect(result.data.invariants).toBeUndefined();
    expect(result.data.register).toBeUndefined();
  }
});

test("profile with partial domain fields (only domain and register) parses", () => {
  const profile = { ...baseProfile, domain: "book", register: "business" };
  const result = stackProfileSchema.safeParse(profile);
  expect(result.success).toBe(true);
});

test("terminology with unknown keys parses (open vocabulary)", () => {
  const profile = {
    ...baseProfile,
    terminology: { artifact: "chapter", customKey: "custom-value" },
  };
  const result = stackProfileSchema.safeParse(profile);
  expect(result.success).toBe(true);
});

test("invariants with invalid id format (lowercase) fails validation", () => {
  const profile = {
    ...baseProfile,
    invariants: [{ id: "video-01", rule: "test rule", severity: "error" }],
  };
  const result = stackProfileSchema.safeParse(profile);
  expect(result.success).toBe(false);
});

test("invariants with valid id format (VIDEO-01) passes", () => {
  const profile = {
    ...baseProfile,
    invariants: [{ id: "VIDEO-01", rule: "test rule", severity: "error" }],
  };
  const result = stackProfileSchema.safeParse(profile);
  expect(result.success).toBe(true);
});

test("profileInvariantSchema rejects invalid severity", () => {
  const result = profileInvariantSchema.safeParse({
    id: "VIDEO-01",
    rule: "test",
    severity: "critical",
  });
  expect(result.success).toBe(false);
});

test("register with invalid value fails validation", () => {
  const profile = { ...baseProfile, register: "personal" };
  const result = stackProfileSchema.safeParse(profile);
  expect(result.success).toBe(false);
});

test("artifacts with missing required extensions field fails", () => {
  const profile = {
    ...baseProfile,
    artifacts: [{ id: "composition" }],
  };
  const result = stackProfileSchema.safeParse(profile);
  expect(result.success).toBe(false);
});

test("all shipped profiles parse without changes", () => {
  const profiles = listStackProfiles(FORGE_ROOT);
  expect(profiles.length).toBe(5);
  for (const profile of profiles) {
    expect(profile.id).toBeDefined();
    expect(profile.workspace.dirs.length).toBeGreaterThan(0);
    // Domain fields should be undefined for existing software-domain profiles
    if (profile.id !== "editframe" && profile.id !== "obsidian-vault") {
      expect(profile.domain).toBeUndefined();
      expect(profile.register).toBeUndefined();
    }
  }
});

test("shipped astro-typescript-turborepo profile loads via loadStackProfile", () => {
  const profile = loadStackProfile(join(FORGE_ROOT, "profiles", "astro-typescript-turborepo.yaml"));
  expect(profile.id).toBe("astro-typescript-turborepo");
});

test("UNIVERSAL_TERMINOLOGY_KEYS contains the 7 documented keys", () => {
  expect(UNIVERSAL_TERMINOLOGY_KEYS).toHaveLength(7);
  expect(UNIVERSAL_TERMINOLOGY_KEYS).toContain("artifact");
  expect(UNIVERSAL_TERMINOLOGY_KEYS).toContain("artifactPlural");
  expect(UNIVERSAL_TERMINOLOGY_KEYS).toContain("module");
  expect(UNIVERSAL_TERMINOLOGY_KEYS).toContain("source");
  expect(UNIVERSAL_TERMINOLOGY_KEYS).toContain("output");
  expect(UNIVERSAL_TERMINOLOGY_KEYS).toContain("verify");
  expect(UNIVERSAL_TERMINOLOGY_KEYS).toContain("operator");
});

test("TERMINOLOGY_DEFAULTS maps each key to a non-empty default string", () => {
  for (const key of UNIVERSAL_TERMINOLOGY_KEYS) {
    const value = TERMINOLOGY_DEFAULTS[key];
    expect(value).toBeDefined();
    expect(value.length).toBeGreaterThan(0);
  }
});
