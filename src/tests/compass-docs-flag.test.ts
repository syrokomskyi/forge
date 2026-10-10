/*
<MODULE_CONTRACT>
<purpose>
  RFC-1253 AC-9: --compass-docs on forge.init / forge.create / forge.upgrade
  invokes compass.docs.scaffold after the primary operation — corpus docs
  materialize and bindings.paths.compassDocs is written; without the flag the
  lifecycle leaves the corpus untouched.
</purpose>
</MODULE_CONTRACT>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForgeCoreModule } from "../../os/core/core.module.ts";
import { ambientIo } from "../utils/io.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../types.ts";

const FORGE_ROOT = join(import.meta.dirname, "..", "..");

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

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    forgeRoot: FORGE_ROOT,
    site: undefined,
    siteExplicit: false,
    logger: logger as never,
    dryRun: false,
    outputFormat: "json",
    io: ambientIo,
    actualState: undefined as never,
    fileIntents: [],
  } as unknown as ForgeRuntimeContext;
}

function makeInput(flags: Record<string, unknown>): ForgeCommandInput {
  return { argv: [], flags } as unknown as ForgeCommandInput;
}

describe("--compass-docs lifecycle flag (RFC-1253)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compass-docs-flag-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("declares the flag on forge.init, forge.create, and forge.upgrade", async () => {
    const mod = await createForgeCoreModule();
    for (const name of ["forge.init", "forge.create", "forge.upgrade"]) {
      const cmd = mod.commands.find((c) => c.name === name);
      expect(cmd, name).toBeDefined();
      expect(cmd?.flags?.["compass-docs"]).toBeDefined();
    }
  });

  it("forge.init --compass-docs materializes the corpus and writes the binding", async () => {
    const mod = await createForgeCoreModule();
    const init = mod.commands.find((c) => c.name === "forge.init")!;

    const result = await init.execute(makeInput({ "compass-docs": true }), makeContext(root));
    if (!result) throw new Error("forge.init returned no result");
    expect(result.exitCode).toBe(0);

    const req = await readFile(join(root, "docs", "requirements.xml"), "utf8");
    expect(req).toContain("<schema>forge/compass-docs@1</schema>");
    const forgeYaml = await readFile(join(root, "forge.yaml"), "utf8");
    expect(forgeYaml).toContain("compassDocs:");
    expect(forgeYaml).toContain("docs/requirements.xml");
    expect((result.data as { compassDocs?: { status?: string } })?.compassDocs?.status).toBe("ok");
  });

  it("forge.init without the flag leaves the corpus and binding untouched", async () => {
    const mod = await createForgeCoreModule();
    const init = mod.commands.find((c) => c.name === "forge.init")!;

    const result = await init.execute(makeInput({}), makeContext(root));
    if (!result) throw new Error("forge.init returned no result");
    expect(result.exitCode).toBe(0);

    await expect(readFile(join(root, "docs", "requirements.xml"), "utf8")).rejects.toThrow();
    const forgeYaml = await readFile(join(root, "forge.yaml"), "utf8");
    // the init default template declares the key empty — no corpus paths land
    expect(forgeYaml).toContain("compassDocs: []");
    expect((result.data as { compassDocs?: unknown })?.compassDocs).toBeUndefined();
  });
});
