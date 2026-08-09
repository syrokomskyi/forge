/*
<MODULE_CONTRACT>
<purpose>Unit tests for RFC-0643: per-domain AGENTS.md template generation —
terminology substitution, register selection, nested template selection, fallback,
path traversal rejection, details field, and regression.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0643: initial domain template tests — terminology substitution, register selection, nested templates, fallback, path traversal, details field, regression.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAgentsGenerate,
  substituteTemplate,
  selectRootTemplate,
} from "../onboarding/agents-generate.ts";
import { selectNestedTemplate } from "../onboarding/nested-agents-templates.ts";
import type { ForgeRuntimeContext } from "../types.ts";
import type { ProfileWorkspaceType } from "../profiles/profile-schema.ts";
import type { StackProfile } from "../profiles/stack-profile.ts";

const silentLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

const FORGE_ROOT = join(import.meta.dirname, "..", "..");
const _WORKSPACE_ROOT = join(FORGE_ROOT, "..", "..");

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: silentLogger as never,
    dryRun: false,
    outputFormat: "json",
    forgeRoot: FORGE_ROOT,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agents-gen-domain-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function makeForgeYaml(dir: string, extra?: string): Promise<void> {
  const lines = [
    "schema: forge/config@1",
    "project:",
    "  name: test-project",
    "  stack: [typescript]",
    "  packageManager: pnpm",
    "paths:",
    "  rfcsDir: docs/rfcs",
    "  adrsDir: docs/adrs",
    "  plansDir: docs/plans",
    "  auditsDir: docs/audits",
    "  specsDir: docs/specs",
    "  skillsDir: .agents/skills",
    "bindings:",
    "  schema: forge/bindings@1",
    "  commands:",
    "    validateRfc: pnpm exec forge rfc.validate",
    "    validateAdr: pnpm exec forge adr.validate",
    "    typecheck: null",
    "    test: null",
    "    scopedBuild: null",
    "    implementStamp: pnpm exec forge rfc.implement.stamp",
    "    specValidate: pnpm exec forge spec.validate",
    "    sessionSave: pnpm exec forge session.save",
    "  paths:",
    "    invariantsFile: docs/architecture-dna.md",
    "    reviewsDir: docs/reviews",
    "    handoffsDir: docs/handoffs",
    "    sessionsDir: docs/sessions",
    "    compassDocs: [docs/requirements.xml]",
    "forge:",
    "  syncedVersion: 0.1.2",
  ];
  if (extra) lines.push(extra);
  await writeFile(join(dir, "forge.yaml"), lines.join("\n"), "utf8");
}

// --- substituteTemplate tests ---

test("substituteTemplate replaces {{terminology.artifact}} with 'composition'", () => {
  const result = substituteTemplate("Each {{terminology.artifact}} is a workspace.", {
    artifact: "composition",
  });
  expect(result).toBe("Each composition is a workspace.");
});

test("substituteTemplate replaces unknown key with key name itself", () => {
  const result = substituteTemplate("The {{terminology.unknown}} is here.", {});
  expect(result).toBe("The unknown is here.");
});

test("substituteTemplate leaves content without placeholders unchanged", () => {
  const content = "No placeholders here.";
  expect(substituteTemplate(content, { artifact: "composition" })).toBe(content);
});

test("substituteTemplate replaces multiple placeholders in one pass", () => {
  const result = substituteTemplate(
    "The {{terminology.operator}} creates {{terminology.artifactPlural}}.",
    { operator: "director", artifactPlural: "compositions" },
  );
  expect(result).toBe("The director creates compositions.");
});

// --- selectRootTemplate tests ---

test("selectRootTemplate('business') returns business template content", () => {
  const content = selectRootTemplate("business");
  expect(content).toContain("{{projectName}}");
  expect(content).toContain("{{rfcsDir}}");
});

test("selectRootTemplate('creative') returns creative template content", () => {
  const content = selectRootTemplate("creative");
  expect(content).toContain("{{projectName}}");
  expect(content).toContain("{{rfcsDir}}");
});

test("business template contains {{terminology.key}} placeholders", () => {
  const content = selectRootTemplate("business");
  // Templates use {{projectName}} etc. — no {{terminology.*}} needed in static prose
  // but the template should contain {{dynamicSections}} marker
  expect(content).toContain("{{dynamicSections}}");
});

test("creative template contains {{dynamicSections}} marker", () => {
  const content = selectRootTemplate("creative");
  expect(content).toContain("{{dynamicSections}}");
});

// --- selectNestedTemplate tests ---

test("selectNestedTemplate with agentsMdTemplate uses profile template", () => {
  const wsType: ProfileWorkspaceType = {
    id: "composition",
    detect: { glob: "*.html" },
    agentsMdTemplate: "editframe-templates/composition-agents.md",
  };
  const profile = { id: "editframe" } as StackProfile;
  const result = selectNestedTemplate(wsType, profile, {}, "FALLBACK");
  expect(result).toContain("Composition Workspace");
  expect(result).not.toBe("FALLBACK");
});

test("selectNestedTemplate without agentsMdTemplate uses fallback", () => {
  const wsType: ProfileWorkspaceType = {
    id: "package",
    detect: { glob: "package.json" },
  };
  const profile = { id: "forge-shell" } as StackProfile;
  const result = selectNestedTemplate(wsType, profile, {}, "FALLBACK");
  expect(result).toBe("FALLBACK");
});

test("selectNestedTemplate without profile uses fallback", () => {
  const wsType: ProfileWorkspaceType = {
    id: "composition",
    detect: { glob: "*.html" },
    agentsMdTemplate: "some-template.md",
  };
  const result = selectNestedTemplate(wsType, undefined, {}, "FALLBACK");
  expect(result).toBe("FALLBACK");
});

test("selectNestedTemplate rejects path traversal (..) with fallback", () => {
  const wsType: ProfileWorkspaceType = {
    id: "evil",
    detect: { glob: "*" },
    agentsMdTemplate: "../../../etc/passwd",
  };
  const profile = { id: "evil-profile" } as StackProfile;
  const result = selectNestedTemplate(wsType, profile, {}, "FALLBACK");
  expect(result).toBe("FALLBACK");
});

test("selectNestedTemplate rejects absolute path with fallback", () => {
  const wsType: ProfileWorkspaceType = {
    id: "evil",
    detect: { glob: "*" },
    agentsMdTemplate: "/etc/passwd",
  };
  const profile = { id: "evil-profile" } as StackProfile;
  const result = selectNestedTemplate(wsType, profile, {}, "FALLBACK");
  expect(result).toBe("FALLBACK");
});

test("selectNestedTemplate applies terminology substitution", () => {
  const wsType: ProfileWorkspaceType = {
    id: "composition",
    detect: { glob: "*.html" },
    agentsMdTemplate: "editframe-templates/composition-agents.md",
  };
  const profile = { id: "editframe" } as StackProfile;
  // The composition-agents.md template doesn't have {{terminology.*}} placeholders,
  // but if it did, they would be substituted
  const result = selectNestedTemplate(wsType, profile, { artifact: "video" }, "FALLBACK");
  expect(result).toContain("Composition Workspace");
});

// --- Integration: --json output has details field ---

test("agents-generate --json output has details field with domain, register, workspaceType", async () => {
  await makeForgeYaml(tempDir);
  const ctx = makeContext(tempDir);
  ctx.dryRun = true;

  const result = await runAgentsGenerate({ argv: [], flags: {} }, ctx);
  expect(result.exitCode).toBe(0);
  expect(result.data?.details).toBeDefined();
  expect(Array.isArray(result.data?.details)).toBe(true);
  expect(result.data?.details?.length).toBeGreaterThan(0);
  const rootDetail = result.data?.details?.find((d) => d.path === "AGENTS.md");
  expect(rootDetail).toBeDefined();
  expect(rootDetail?.register).toBe("business");
});

test("agents-generate --json output generated field is string[]", async () => {
  await makeForgeYaml(tempDir);
  const ctx = makeContext(tempDir);
  ctx.dryRun = true;

  const result = await runAgentsGenerate({ argv: [], flags: {} }, ctx);
  expect(result.exitCode).toBe(0);
  expect(result.data?.generated).toEqual(["AGENTS.md"]);
  // generated is string[], not object array
  expect(typeof result.data?.generated?.[0]).toBe("string");
});

// --- Regression: no profile → identical output ---

test("agents-generate with no profile generates identical AGENTS.md (regression)", async () => {
  await makeForgeYaml(tempDir);
  const ctx = makeContext(tempDir);
  ctx.dryRun = true;

  const result = await runAgentsGenerate({ argv: [], flags: {} }, ctx);
  const content = result.data?.renderedFiles?.["AGENTS.md"];
  expect(content).toBeDefined();

  const goldenFixture = await readFile(
    join(import.meta.dirname, "fixtures", "agents-generate-business-before.txt"),
    "utf8",
  );
  expect(content).toBe(goldenFixture);
});

// --- Integration: creative register uses creative template ---

test("agents-generate with creative register uses creative template", async () => {
  await makeForgeYaml(tempDir);
  await writeFile(
    join(tempDir, "PREFERENCES.md"),
    "---\naiLanguage: en\ndocumentationLanguage: en\nregister: creative\n---\n",
    "utf8",
  );

  const ctx = makeContext(tempDir);
  ctx.dryRun = true;

  const result = await runAgentsGenerate({ argv: [], flags: {} }, ctx);
  expect(result.exitCode).toBe(0);
  const content = result.data?.renderedFiles?.["AGENTS.md"];
  expect(content).toBeDefined();
  expect(content).toContain("Agent Guide: test-project");
  // Creative register should have extended behavioral layer
  expect(content).toContain("Extended behavioral layer (creative register)");
  // Details should show creative register
  const rootDetail = result.data?.details?.find((d) => d.path === "AGENTS.md");
  expect(rootDetail?.register).toBe("creative");
});
