/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.doctor defaultable-binding-null notices (RFC-0540).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0540: initial doctor binding notices tests.</item>
  <item>RFC-1224: adrImplementStamp added to notice inventory and fixtures.</item>
  <item>RFC-1224: preserve operator forge.yaml content on upgrade, promote adrImplementStamp binding</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../onboarding/doctor.ts";
import type { ForgeRuntimeContext, ForgeLogger } from "../types.ts";

const mockLogger: ForgeLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

const mockContext = (workspaceRoot: string): ForgeRuntimeContext => ({
  workspaceRoot,
  logger: mockLogger,
  dryRun: false,
  outputFormat: "json",
});

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-doctor-bindings-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeForgeYaml(dir: string, yaml: string): Promise<void> {
  await writeFile(join(dir, "forge.yaml"), yaml, "utf8");
}

async function setupMinimalProject(dir: string): Promise<void> {
  await mkdir(join(dir, "packages", "forge", "src"), { recursive: true });
  await writeFile(
    join(dir, "packages", "forge", "package.json"),
    '{"name":"@warpgogol/forge"}',
    "utf8",
  );
  await writeFile(join(dir, "packages", "forge", "src", "index.ts"), "export const x = 1;", "utf8");
  await mkdir(join(dir, ".agents", "skills"), { recursive: true });
  await mkdir(join(dir, "docs", "rfcs"), { recursive: true });
  await mkdir(join(dir, "docs", "adrs"), { recursive: true });
  await writeFile(join(dir, "AGENTS.md"), "# Test", "utf8");
  await writeFile(join(dir, "PREFERENCES.md"), "# Test", "utf8");
}

test("doctor emits defaultable-binding-null notices for all 6 forge-CLI bindings when null", async () => {
  await setupMinimalProject(tempDir);
  await writeForgeYaml(
    tempDir,
    `schema: forge/config@1
project:
  name: test
  stack: []
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
    implementStamp: null
    typecheck: null
    test: null
    scopedBuild: null
    specValidate: null
    sessionSave: null
  paths:
    invariantsFile: null
    compassDocs: []
    reviewsDir: null
    handoffsDir: null
    sessionsDir: null
`,
  );

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const notices = result.data?.bindings?.notices ?? [];
  expect(notices).toHaveLength(6);
  const keys = notices.map((n) => n.key);
  expect(keys).toContain("commands.validateRfc");
  expect(keys).toContain("commands.validateAdr");
  expect(keys).toContain("commands.implementStamp");
  expect(keys).toContain("commands.adrImplementStamp");
  expect(keys).toContain("commands.specValidate");
  expect(keys).toContain("commands.sessionSave");
  for (const notice of notices) {
    expect(notice.rule).toBe("defaultable-binding-null");
    expect(notice.suggestion).toContain("pnpm exec forge");
  }
});

test("doctor does NOT emit notices for non-null forge-CLI bindings (operator override)", async () => {
  await setupMinimalProject(tempDir);
  await writeForgeYaml(
    tempDir,
    `schema: forge/config@1
project:
  name: test
  stack: []
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
    validateRfc: "custom rfc validate command"
    validateAdr: "custom adr validate command"
    implementStamp: "custom stamp command"
    adrImplementStamp: "custom adr stamp command"
    typecheck: null
    test: null
    scopedBuild: null
    specValidate: "custom spec validate command"
    sessionSave: "custom session save command"
  paths:
    invariantsFile: null
    compassDocs: []
    reviewsDir: null
    handoffsDir: null
    sessionsDir: null
`,
  );

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const notices = result.data?.bindings?.notices ?? [];
  expect(notices).toHaveLength(0);
});

test("doctor emits zero notices when all forge-CLI bindings are non-null", async () => {
  await setupMinimalProject(tempDir);
  await writeForgeYaml(
    tempDir,
    `schema: forge/config@1
project:
  name: test
  stack: []
  packageManager: npm
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
    validateRfc: "npx forge rfc.validate --id {id} --json"
    validateAdr: "npx forge adr.validate --id {id} --json"
    implementStamp: "npx forge rfc.implement.stamp --id {id} --implementation-commit {commit}"
    adrImplementStamp: "npx forge adr.implement.stamp --id {id} --implementation-commit {commit}"
    typecheck: null
    test: null
    scopedBuild: null
    specValidate: "npx forge spec.validate --spec={id} --json"
    sessionSave: "npx forge session.save --json"
  paths:
    invariantsFile: null
    compassDocs: []
    reviewsDir: null
    handoffsDir: null
    sessionsDir: null
`,
  );

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const notices = result.data?.bindings?.notices ?? [];
  expect(notices).toHaveLength(0);
});

test("doctor notice suggestion uses npm runner when packageManager is npm", async () => {
  await setupMinimalProject(tempDir);
  await writeForgeYaml(
    tempDir,
    `schema: forge/config@1
project:
  name: test
  stack: []
  packageManager: npm
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
    implementStamp: null
    typecheck: null
    test: null
    scopedBuild: null
    specValidate: null
    sessionSave: null
  paths:
    invariantsFile: null
    compassDocs: []
    reviewsDir: null
    handoffsDir: null
    sessionsDir: null
`,
  );

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const notices = result.data?.bindings?.notices ?? [];
  expect(notices.length).toBeGreaterThan(0);
  for (const notice of notices) {
    expect(notice.suggestion).toContain("npx forge");
  }
});

test("doctor detects directories as existing paths (regression: pathExists used readFile which throws EISDIR on dirs)", async () => {
  await setupMinimalProject(tempDir);
  await mkdir(join(tempDir, "docs", "sessions"), { recursive: true });
  await writeForgeYaml(
    tempDir,
    `schema: forge/config@1
project:
  name: test
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
bindings:
  schema: forge/bindings@1
  commands:
    validateRfc: "pnpm exec forge rfc.validate --id {id} --json"
    validateAdr: "pnpm exec forge adr.validate --id {id} --json"
    implementStamp: "pnpm exec forge rfc.implement.stamp --id {id} --implementation-commit {commit}"
    typecheck: null
    test: null
    scopedBuild: null
    specValidate: "pnpm exec forge spec.validate --spec={id} --json"
    sessionSave: "pnpm exec forge session.save --json"
  paths:
    invariantsFile: null
    compassDocs: []
    reviewsDir: null
    handoffsDir: null
    sessionsDir: docs/sessions
`,
  );

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const skillsCheck = checks.find((c) => c.name === ".agents/skills/");
  expect(skillsCheck?.status).toBe("pass");
  const rfcsCheck = checks.find((c) => c.name === "docs/rfcs/");
  expect(rfcsCheck?.status).toBe("pass");
  const adrsCheck = checks.find((c) => c.name === "docs/adrs/");
  expect(adrsCheck?.status).toBe("pass");
  const bindingsCheck = checks.find((c) => c.name === "bindings");
  expect(bindingsCheck?.status).toBe("pass");
});

test("doctor emits compass-docs-scaffoldable notice when bound corpus docs are missing (RFC-1253)", async () => {
  await setupMinimalProject(tempDir);
  await writeForgeYaml(
    tempDir,
    `schema: forge/config@1
project:
  name: test
  stack: []
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
  commands: {}
  paths:
    invariantsFile: null
    compassDocs:
      - docs/requirements.xml
      - docs/missing-doc.xml
    reviewsDir: null
    handoffsDir: null
    sessionsDir: null
`,
  );
  await writeFile(join(tempDir, "docs", "requirements.xml"), "<root />", "utf8");

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const bindings = result.data?.bindings;
  expect(bindings?.invalid.some((e) => e.includes("missing-doc.xml"))).toBe(true);
  const hint = bindings?.notices.find((n) => n.rule === "compass-docs-scaffoldable");
  expect(hint).toBeDefined();
  expect(hint?.suggestion).toContain("compass.docs.scaffold");
});

test("doctor emits compass-docs-outside-docs notice for bound paths outside docs/ (RFC-1253)", async () => {
  await setupMinimalProject(tempDir);
  await mkdir(join(tempDir, "corpus"), { recursive: true });
  await writeFile(join(tempDir, "corpus", "requirements.xml"), "<root />", "utf8");
  await writeForgeYaml(
    tempDir,
    `schema: forge/config@1
project:
  name: test
  stack: []
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
  commands: {}
  paths:
    invariantsFile: null
    compassDocs:
      - corpus/requirements.xml
    reviewsDir: null
    handoffsDir: null
    sessionsDir: null
`,
  );

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const bindings = result.data?.bindings;
  expect(bindings?.resolved.some((e) => e.includes("corpus/requirements.xml"))).toBe(true);
  const notice = bindings?.notices.find((n) => n.rule === "compass-docs-outside-docs");
  expect(notice).toBeDefined();
  // resolved — no scaffold hint
  expect(bindings?.notices.find((n) => n.rule === "compass-docs-scaffoldable")).toBeUndefined();
});
