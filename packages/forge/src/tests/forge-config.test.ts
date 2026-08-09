/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge config module — loadForgeConfig, resolveForgeRoot, defaultForgeConfig.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0391: initial config tests.</item>
  <item>RFC-0538: added compass binding section tests.</item>
  <item>RFC-0540: added CLI binding defaults, pm-runner, and package-manager-aware defaultForgeConfig tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadForgeConfig,
  resolveForgeRoot,
  defaultForgeConfig,
  forgeConfigSchema,
  forgeBindingsSchema,
  resolveBinding,
  FORGE_CLI_BINDING_DEFAULTS,
  resolvePmRunner,
  applyCliBindingDefaults,
  type ForgeConfig,
} from "../config/forge-config.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-config-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("defaultForgeConfig produces valid config", () => {
  const config = defaultForgeConfig("my-project");
  expect(config.schema).toBe("forge/config@1");
  expect(config.project.name).toBe("my-project");
  expect(config.project.packageManager).toBe("pnpm");
  expect(config.paths.rfcsDir).toBe("docs/rfcs");
  expect(config.paths.plansDir).toBe("docs/plans");
  expect(config.paths.auditsDir).toBe("docs/audits");
});

// ---------------------------------------------------------------------------
// CLI binding defaults tests (RFC-0540)
// ---------------------------------------------------------------------------

test("resolvePmRunner maps known package managers", () => {
  expect(resolvePmRunner("pnpm")).toBe("pnpm exec");
  expect(resolvePmRunner("npm")).toBe("npx");
  expect(resolvePmRunner("yarn")).toBe("yarn exec");
  expect(resolvePmRunner("bun")).toBe("bunx");
  expect(resolvePmRunner("none")).toBe("npx");
});

test("resolvePmRunner falls back to npx for unknown", () => {
  expect(resolvePmRunner("unknown")).toBe("npx");
  expect(resolvePmRunner("")).toBe("npx");
});

test("FORGE_CLI_BINDING_DEFAULTS has 5 entries with correct keys", () => {
  expect(FORGE_CLI_BINDING_DEFAULTS).toHaveLength(5);
  const keys = FORGE_CLI_BINDING_DEFAULTS.map((e) => e.key);
  expect(keys).toContain("commands.validateRfc");
  expect(keys).toContain("commands.validateAdr");
  expect(keys).toContain("commands.implementStamp");
  expect(keys).toContain("commands.specValidate");
  expect(keys).toContain("commands.sessionSave");
});

test("defaultForgeConfig with pnpm produces forge-CLI bindings with pnpm exec prefix", () => {
  const config = defaultForgeConfig("test", "pnpm");
  expect(config.bindings?.commands.validateRfc).toBe(
    "pnpm exec forge rfc.validate --id {id} --json",
  );
  expect(config.bindings?.commands.validateAdr).toBe(
    "pnpm exec forge adr.validate --id {id} --json",
  );
  expect(config.bindings?.commands.implementStamp).toBe(
    "pnpm exec forge rfc.implement.stamp --id {id} --implementation-commit {commit}",
  );
  expect(config.bindings?.commands.specValidate).toBe(
    "pnpm exec forge spec.validate --spec={id} --json",
  );
});

test("defaultForgeConfig with npm produces npx-prefixed bindings", () => {
  const config = defaultForgeConfig("test", "npm");
  expect(config.bindings?.commands.validateRfc).toBe("npx forge rfc.validate --id {id} --json");
  expect(config.bindings?.commands.implementStamp).toBe(
    "npx forge rfc.implement.stamp --id {id} --implementation-commit {commit}",
  );
});

test("defaultForgeConfig with bun produces bunx-prefixed bindings", () => {
  const config = defaultForgeConfig("test", "bun");
  expect(config.bindings?.commands.validateRfc).toBe("bunx forge rfc.validate --id {id} --json");
});

test("defaultForgeConfig without packageManager defaults to pnpm", () => {
  const config = defaultForgeConfig("test");
  expect(config.project.packageManager).toBe("pnpm");
  expect(config.bindings?.commands.validateRfc).toBe(
    "pnpm exec forge rfc.validate --id {id} --json",
  );
});

test("defaultForgeConfig keeps stack-dependent bindings null", () => {
  const config = defaultForgeConfig("test", "pnpm");
  expect(config.bindings?.commands.typecheck).toBeNull();
  expect(config.bindings?.commands.test).toBeNull();
  expect(config.bindings?.commands.scopedBuild).toBeNull();
});

test("defaultForgeConfig with CLI defaults passes schema validation", () => {
  const config = defaultForgeConfig("test", "pnpm");
  const result = forgeConfigSchema.safeParse(config);
  expect(result.success).toBe(true);
});

test("forgeBindingsSchema accepts config with implementStamp field", () => {
  const config = defaultForgeConfig("test", "pnpm");
  const result = forgeBindingsSchema.safeParse(config.bindings);
  expect(result.success).toBe(true);
});

test("applyCliBindingDefaults returns forge-CLI bindings non-null and stack bindings null", () => {
  const commands = applyCliBindingDefaults("pnpm");
  expect(commands.validateRfc).not.toBeNull();
  expect(commands.validateAdr).not.toBeNull();
  expect(commands.implementStamp).not.toBeNull();
  expect(commands.specValidate).not.toBeNull();
  expect(commands.sessionSave).not.toBeNull();
  expect(commands.typecheck).toBeNull();
  expect(commands.test).toBeNull();
  expect(commands.scopedBuild).toBeNull();
});

test("defaultForgeConfig passes schema validation", () => {
  const config = defaultForgeConfig("test-project");
  const result = forgeConfigSchema.safeParse(config);
  expect(result.success).toBe(true);
});

test("loadForgeConfig parses valid forge.yaml", async () => {
  const yaml = `
schema: forge/config@1
project:
  name: test-app
  stack: [typescript]
  packageManager: pnpm
paths:
  rfcsDir: docs/rfcs
  adrsDir: docs/adrs
  plansDir: docs/plans
  auditsDir: docs/audits
  specsDir: docs/specs
  skillsDir: .agents/skills
`;
  await writeFile(join(tempDir, "forge.yaml"), yaml, "utf8");
  const config = loadForgeConfig(tempDir);
  expect(config.project.name).toBe("test-app");
  expect(config.project.stack).toEqual(["typescript"]);
  expect(config.project.packageManager).toBe("pnpm");
});

test("loadForgeConfig throws on missing forge.yaml", () => {
  expect(() => loadForgeConfig(tempDir)).toThrow("forge.yaml not found");
});

test("loadForgeConfig throws on invalid schema", async () => {
  const yaml = `
schema: forge/config@1
project:
  name: ""
`;
  await writeFile(join(tempDir, "forge.yaml"), yaml, "utf8");
  expect(() => loadForgeConfig(tempDir)).toThrow("failed schema validation");
});

test("resolveForgeRoot finds packages/forge in monorepo layout", async () => {
  await mkdir(join(tempDir, "packages", "forge"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "forge", "package.json"),
    '{"name":"@warpgogol/forge"}',
    "utf8",
  );
  const root = resolveForgeRoot(tempDir);
  expect(root).toBe(join(tempDir, "packages", "forge"));
});

test("resolveForgeRoot finds node_modules/@warpgogol/forge in npm layout", async () => {
  await mkdir(join(tempDir, "node_modules", "@warpgogol", "forge"), { recursive: true });
  await writeFile(
    join(tempDir, "node_modules", "@warpgogol", "forge", "package.json"),
    '{"name":"@warpgogol/forge"}',
    "utf8",
  );
  const root = resolveForgeRoot(tempDir);
  expect(root).toBe(join(tempDir, "node_modules", "@warpgogol", "forge"));
});

test("resolveForgeRoot throws when forge not found", () => {
  expect(() => resolveForgeRoot(tempDir)).toThrow("Could not resolve forge root");
});

// ---------------------------------------------------------------------------
// Bindings tests (RFC-0393)
// ---------------------------------------------------------------------------

const configWithBindings: ForgeConfig = {
  schema: "forge/config@1",
  project: { name: "test", stack: [], packageManager: "pnpm" },
  paths: {
    rfcsDir: "docs/rfcs",
    adrsDir: "docs/adrs",
    plansDir: "docs/plans",
    auditsDir: "docs/audits",
    specsDir: "docs/specs",
    skillsDir: ".agents/skills",
    sessionsDir: "docs/sessions",
  },
  bindings: {
    schema: "forge/bindings@1",
    commands: {
      validateRfc: "pnpm exec site-kernel run rfc.validate --id {id} --json",
      validateAdr: null,
      implementStamp: null,
      typecheck: "pnpm --filter {workspace} run build:check",
      test: "pnpm --filter {workspace} run test",
      scopedBuild: null,
      specValidate: null,
      sessionSave: null,
      validate: null,
      produce: null,
      verify: null,
      preview: null,
      lint: null,
    },
    paths: {
      invariantsFile: "docs/architecture-dna.md",
      compassDocs: ["docs/requirements.xml", "docs/technology.xml"],
      reviewsDir: "docs/reviews",
      handoffsDir: null,
      sessionsDir: "docs/sessions",
    },
    terminology: { invariants: "DNA" },
  },
};

test("forgeBindingsSchema validates a valid bindings object", () => {
  const result = forgeBindingsSchema.safeParse(configWithBindings.bindings);
  expect(result.success).toBe(true);
});

test("forgeBindingsSchema rejects missing schema field", () => {
  const bad = { ...configWithBindings.bindings!, schema: "wrong" };
  const result = forgeBindingsSchema.safeParse(bad);
  expect(result.success).toBe(false);
});

test("resolveBinding returns a string for a valid key", () => {
  const result = resolveBinding(configWithBindings, "commands.validateRfc");
  expect(result).toBe("pnpm exec site-kernel run rfc.validate --id {id} --json");
});

test("resolveBinding returns null for an explicitly null binding", () => {
  const result = resolveBinding(configWithBindings, "commands.validateAdr");
  expect(result).toBeNull();
});

test("resolveBinding returns an array for compassDocs", () => {
  const result = resolveBinding(configWithBindings, "paths.compassDocs");
  expect(result).toEqual(["docs/requirements.xml", "docs/technology.xml"]);
});

test("resolveBinding returns null when bindings section is absent", () => {
  const configWithoutBindings: ForgeConfig = {
    ...configWithBindings,
    bindings: undefined,
  };
  const result = resolveBinding(configWithoutBindings, "commands.validateRfc");
  expect(result).toBeNull();
});

test("resolveBinding returns null for an unknown key", () => {
  const result = resolveBinding(configWithBindings, "commands.nonexistent");
  expect(result).toBeNull();
});

test("resolveBinding substitutes placeholders", () => {
  const result = resolveBinding(configWithBindings, "commands.validateRfc", { id: "RFC-0393" });
  expect(result).toBe("pnpm exec site-kernel run rfc.validate --id RFC-0393 --json");
});

test("resolveBinding substitutes multiple placeholders", () => {
  const result = resolveBinding(configWithBindings, "commands.typecheck", {
    workspace: "@warpgogol/forge",
  });
  expect(result).toBe("pnpm --filter @warpgogol/forge run build:check");
});

test("loadForgeConfig parses forge.yaml with bindings", async () => {
  const yaml = `
schema: forge/config@1
project:
  name: test-app
  stack: [typescript]
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
    validateRfc: "pnpm exec site-kernel run rfc.validate --id {id} --json"
    validateAdr: null
    typecheck: "pnpm --filter {workspace} run build:check"
    test: "pnpm --filter {workspace} run test"
    scopedBuild: null
    specValidate: null
  paths:
    invariantsFile: docs/architecture-dna.md
    compassDocs: [docs/requirements.xml]
    reviewsDir: docs/reviews
    handoffsDir: null
  terminology:
    invariants: DNA
`;
  await writeFile(join(tempDir, "forge.yaml"), yaml, "utf8");
  const config = loadForgeConfig(tempDir);
  expect(config.bindings).toBeDefined();
  expect(config.bindings?.commands.validateRfc).toBe(
    "pnpm exec site-kernel run rfc.validate --id {id} --json",
  );
  expect(config.bindings?.paths.invariantsFile).toBe("docs/architecture-dna.md");
});

// ---------------------------------------------------------------------------
// Compass binding tests (RFC-0538)
// ---------------------------------------------------------------------------

const configWithCompassBindings: ForgeConfig = {
  ...configWithBindings,
  bindings: {
    ...configWithBindings.bindings!,
    compass: {
      fileExtensions: [".ts", ".astro"],
      testPatterns: ["*.test.ts", "*.spec.ts", "**/test/**", "**/tests/**"],
    },
  },
};

test("forgeBindingsSchema validates compass section", () => {
  const result = forgeBindingsSchema.safeParse(configWithCompassBindings.bindings);
  expect(result.success).toBe(true);
});

test("resolveBinding returns array for compass.fileExtensions", () => {
  const result = resolveBinding(configWithCompassBindings, "compass.fileExtensions");
  expect(result).toEqual([".ts", ".astro"]);
});

test("resolveBinding returns array for compass.testPatterns", () => {
  const result = resolveBinding(configWithCompassBindings, "compass.testPatterns");
  expect(result).toEqual(["*.test.ts", "*.spec.ts", "**/test/**", "**/tests/**"]);
});

test("resolveBinding returns null when compass section is absent", () => {
  const result = resolveBinding(configWithBindings, "compass.fileExtensions");
  expect(result).toBeNull();
});

test("loadForgeConfig parses forge.yaml with compass bindings", async () => {
  const yaml = `
schema: forge/config@1
project:
  name: test-app
  stack: [typescript]
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
    typecheck: null
    test: null
    scopedBuild: null
    specValidate: null
  paths:
    invariantsFile: docs/architecture-dna.md
    compassDocs: []
    reviewsDir: null
    handoffsDir: null
  compass:
    fileExtensions: [".ts", ".astro"]
    testPatterns: ["*.test.ts", "*.spec.ts"]
`;
  await writeFile(join(tempDir, "forge.yaml"), yaml, "utf8");
  const config = loadForgeConfig(tempDir);
  expect(config.bindings?.compass).toBeDefined();
  expect(config.bindings?.compass?.fileExtensions).toEqual([".ts", ".astro"]);
  expect(config.bindings?.compass?.testPatterns).toEqual(["*.test.ts", "*.spec.ts"]);
});
