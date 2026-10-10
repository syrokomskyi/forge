/*
<MODULE_CONTRACT>
<purpose>
  RFC-1253 AC-1/AC-2/AC-3: compass.docs.scaffold materializes the six-document
  Compass corpus with the forge/compass-docs@1 marker, writes
  bindings.paths.compassDocs when absent, stays byte-stable on rerun, and
  merges only missing workspace nodes into an existing knowledge-graph.xml.
</purpose>
</MODULE_CONTRACT>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompassDocsScaffold } from "../../os/compass/handlers/compass-docs-scaffold.ts";
import { forgeYaml } from "../../os/compass/handlers/tests/forge-yaml-fixture.ts";
import { ambientIo } from "../utils/io.ts";
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

function makeContext(workspaceRoot: string, dryRun = false): ForgeRuntimeContext {
  return {
    workspaceRoot,
    site: undefined,
    siteExplicit: false,
    logger: logger as never,
    dryRun,
    outputFormat: "json",
    io: ambientIo,
    actualState: undefined as never,
    fileIntents: [],
  } as unknown as ForgeRuntimeContext;
}

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { argv: [], flags } as unknown as ForgeCommandInput;
}

// forgeYaml("") → schema-valid minimal config with empty bindings.paths
const FORGE_YAML = forgeYaml("");

const PACKAGE_JSON = JSON.stringify(
  { name: "fixture", engines: { node: ">=24 <25" }, packageManager: "pnpm@10" },
  null,
  2,
);

const WORKSPACE_PKG = JSON.stringify({ name: "@fixture/alpha" });

async function seedWorkspace(root: string): Promise<void> {
  await writeFile(join(root, "forge.yaml"), FORGE_YAML);
  await writeFile(join(root, "package.json"), PACKAGE_JSON);
  await mkdir(join(root, "packages", "alpha"), { recursive: true });
  await writeFile(join(root, "packages", "alpha", "package.json"), WORKSPACE_PKG);
}

const SIX_DOCS = [
  "requirements.xml",
  "technology.xml",
  "development-plan.xml",
  "knowledge-graph.xml",
  "verification-plan.xml",
  "source-markup.xml",
];

describe("compass.docs.scaffold — RFC-1253", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compass-docs-scaffold-"));
    await seedWorkspace(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("AC-1: creates the six corpus docs, each carrying the forge/compass-docs@1 marker", async () => {
    const result = await runCompassDocsScaffold(makeInput(), makeContext(root));
    expect(result.exitCode).toBe(0);
    for (const doc of SIX_DOCS) {
      const content = await readFile(join(root, "docs", doc), "utf8");
      expect(content).toContain("<schema>forge/compass-docs@1</schema>");
      expect(result.data?.files.find((f) => f.path === `docs/${doc}`)?.action).toBe("created");
    }
    // generated-from-state docs carry real workspace nodes
    const kg = await readFile(join(root, "docs", "knowledge-graph.xml"), "utf8");
    expect(kg).toContain('id="pkg-alpha"');
    expect(kg).toContain("`packages/alpha`");
    // skeletons stay authored-intent drafts
    const req = await readFile(join(root, "docs", "requirements.xml"), "utf8");
    expect(req).toContain("<status>draft</status>");
    expect(req).toContain("TODO");
  });

  it("AC-2: writes bindings.paths.compassDocs into forge.yaml when absent", async () => {
    await runCompassDocsScaffold(makeInput(), makeContext(root));
    const forgeYaml = await readFile(join(root, "forge.yaml"), "utf8");
    expect(forgeYaml).toContain("compassDocs:");
    for (const doc of SIX_DOCS) {
      expect(forgeYaml).toContain(`docs/${doc}`);
    }
  });

  it("AC-3: rerun preserves non-KG docs byte-identically and only appends missing KG nodes", async () => {
    await runCompassDocsScaffold(makeInput(), makeContext(root));
    const before = new Map<string, string>();
    for (const doc of SIX_DOCS) {
      before.set(doc, await readFile(join(root, "docs", doc), "utf8"));
    }
    // author edits one doc — rerun must not clobber it
    const editedReq = before
      .get("requirements.xml")!
      .replace("TODO — describe", "AUTHORED — describe");
    await writeFile(join(root, "docs", "requirements.xml"), editedReq);
    before.set("requirements.xml", editedReq);
    // add a workspace — KG should merge only the new node
    await mkdir(join(root, "services", "beta"), { recursive: true });
    await writeFile(
      join(root, "services", "beta", "package.json"),
      JSON.stringify({ name: "@fixture/beta" }),
    );
    await writeFile(join(root, "services", "beta", "service.config.yaml"), "name: beta\n");

    const rerun = await runCompassDocsScaffold(makeInput(), makeContext(root));
    expect(rerun.exitCode).toBe(0);
    expect(rerun.data?.files.find((f) => f.path === "docs/knowledge-graph.xml")?.action).toBe(
      "merged",
    );
    for (const doc of SIX_DOCS) {
      if (doc === "knowledge-graph.xml") continue;
      const after = await readFile(join(root, "docs", doc), "utf8");
      expect(after).toBe(before.get(doc));
    }
    const req = await readFile(join(root, "docs", "requirements.xml"), "utf8");
    expect(req).toContain("AUTHORED");
    const kg = await readFile(join(root, "docs", "knowledge-graph.xml"), "utf8");
    expect(kg).toContain('id="pkg-alpha"');
    expect(kg).toContain('id="svc-beta"');
    expect((kg.match(/id="pkg-alpha"/g) ?? []).length).toBe(1);
  });

  it("honors a pre-declared custom binding path for a canonical doc", async () => {
    // bindings.paths is emitted as `paths: {}` by the fixture — replace it inline
    const customYaml = FORGE_YAML.replace(
      "  paths: {}",
      "  paths:\n    compassDocs:\n      - docs/corpus/requirements.xml",
    );
    await writeFile(join(root, "forge.yaml"), customYaml);
    const result = await runCompassDocsScaffold(makeInput(), makeContext(root));
    expect(result.exitCode).toBe(0);
    // requirements lands on the custom path; the others on defaults
    expect(result.data?.files.find((f) => f.path === "docs/corpus/requirements.xml")?.action).toBe(
      "created",
    );
    expect(result.data?.binding.final).toContain("docs/corpus/requirements.xml");
    const forgeYaml = await readFile(join(root, "forge.yaml"), "utf8");
    expect(forgeYaml).toContain("docs/corpus/requirements.xml");
    expect(forgeYaml).toContain("docs/knowledge-graph.xml");
  });

  it("dry-run reports the manifest without writing", async () => {
    const result = await runCompassDocsScaffold(
      makeInput({ "dry-run": true }),
      makeContext(root, true),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data?.dryRun).toBe(true);
    expect(result.data?.files.filter((f) => f.action === "created")).toHaveLength(6);
    await expect(readFile(join(root, "docs", "requirements.xml"), "utf8")).rejects.toThrow();
    const forgeYaml = await readFile(join(root, "forge.yaml"), "utf8");
    expect(forgeYaml).not.toContain("compassDocs:");
  });

  it("fails with a next-step when forge.yaml is absent", async () => {
    const empty = await mkdtemp(join(tmpdir(), "compass-docs-noforge-"));
    try {
      const result = await runCompassDocsScaffold(makeInput(), makeContext(empty));
      expect(result.exitCode).toBe(1);
      expect(result.data?.status).toBe("fail");
      expect(result.nextSteps?.[0]?.action).toContain("forge init");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
