/*
<MODULE_CONTRACT>
<purpose>
  RFC-1253 AC-5: forge.validate runs compass.docs.validate when
  bindings.paths.compassDocs resolves non-empty, reports a compassDocs result
  section, and feeds corpus errors into allPassed.
</purpose>
</MODULE_CONTRACT>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runValidate } from "../../os/core/handlers/validate.ts";
import { forgeYaml } from "../../os/compass/handlers/tests/forge-yaml-fixture.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../types.ts";

const logger = {
  section() {},
  info() {},
  warn() {},
  error() {},
  success() {},
  getEvents() {
    return [];
  },
};

function makeContext(workspaceRoot: string, forgeRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    forgeRoot,
    site: undefined,
    siteExplicit: false,
    logger: logger as never,
    dryRun: false,
    outputFormat: "json",
    io: undefined,
    actualState: undefined as never,
    fileIntents: [],
  } as unknown as ForgeRuntimeContext;
}

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { argv: [], flags } as unknown as ForgeCommandInput;
}

// Minimal profile whose single artifact validate command exits 0 instantly.
const TEST_PROFILE = `schema: forge/stack-profile@1
id: test-profile
displayName: Test Profile
detect:
  anyOf:
    - package.json
workspace:
  dirs: [packages]
  files: []
artifacts:
  - id: noop
    extensions: [.ts]
    validate:
      command: "true"
`;

const MARKED_REQUIREMENTS = `<requirements>
  <meta>
    <document>Requirements</document>
    <status>active</status>
    <schema>forge/compass-docs@1</schema>
  </meta>
  <body><path>\`docs/requirements.xml\`</path></body>
</requirements>
`;

const BROKEN_REQUIREMENTS = `<requirements>
  <meta>
    <document>Requirements</document>
    <status>active</status>
    <schema>forge/compass-docs@1</schema>
  </meta>
  <body><path>\`docs/definitely-not-there.xml\`</path></body>
</requirements>
`;

async function seedWorkspace(root: string, compassDocsYaml: string): Promise<string> {
  // fake forgeRoot carrying only the test profile
  const forgeRoot = join(root, ".forge-root");
  await mkdir(join(forgeRoot, "profiles"), { recursive: true });
  await writeFile(join(forgeRoot, "profiles", "test-profile.yaml"), TEST_PROFILE);

  // fixture emits `paths: {}` — inline the binding via replace; profile is a
  // top-level key read by readProfileIdFromForgeYaml
  const base = compassDocsYaml
    ? forgeYaml("").replace("  paths: {}", compassDocsYaml.trimEnd())
    : forgeYaml("");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "forge.yaml"), `${base}\nprofile: test-profile\n`);
  return forgeRoot;
}

describe("forge.validate — compassDocs section (RFC-1253)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "forge-validate-docs-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("emits a passing compassDocs section when the bound corpus is clean", async () => {
    const forgeRoot = await seedWorkspace(
      root,
      "  paths:\n    compassDocs:\n      - docs/requirements.xml",
    );
    await writeFile(join(root, "docs", "requirements.xml"), MARKED_REQUIREMENTS);

    const result = await runValidate(makeInput(), makeContext(root, forgeRoot));
    expect(result.data?.compassDocs).toBeDefined();
    expect(result.data?.compassDocs?.passed).toBe(true);
    expect(result.data?.compassDocs?.scanned.xmlFiles).toBe(1);
    expect(result.data?.allPassed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("compassDocs: OK");
  });

  it("feeds corpus errors into allPassed when the bound corpus is broken", async () => {
    const forgeRoot = await seedWorkspace(
      root,
      "  paths:\n    compassDocs:\n      - docs/requirements.xml",
    );
    await writeFile(join(root, "docs", "requirements.xml"), BROKEN_REQUIREMENTS);

    const result = await runValidate(makeInput(), makeContext(root, forgeRoot));
    expect(result.data?.compassDocs?.passed).toBe(false);
    expect(result.data?.allPassed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.data?.compassDocs?.diagnostics.some((d) => d.ruleId === "COMPASS-DOC-01")).toBe(
      true,
    );
    expect(result.summary).toContain("compassDocs: 1 error(s)");
  });

  it("omits the section entirely when the binding is absent", async () => {
    const forgeRoot = await seedWorkspace(root, "");

    const result = await runValidate(makeInput(), makeContext(root, forgeRoot));
    expect(result.data?.compassDocs).toBeUndefined();
    expect(result.data?.allPassed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.summary).not.toContain("compassDocs");
  });
});
