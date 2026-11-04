/*
<MODULE_CONTRACT>
<purpose>Acceptance tests for the system stack profile (RFC-1508 AC-7..AC-10):
forge create --in-place --profile system scaffolds a repository that carries the
system map, ignores products.local.yaml and passes system.map.validate; the
profile file itself satisfies the stack-profile schema.</purpose>
<non-goals>
  <item>Fixtures are minimal scaffolding — forge.create owns the contract.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1508: step 4 — system profile acceptance tests (AC-7..AC-10)</item>
  <item>RFC-1508: implement RFC-1508 — system profile, system map schemas and system.map.validate</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCreate } from "../../../src/onboarding/create.ts";
import { loadStackProfile, listStackProfiles } from "../../../src/profiles/stack-profile.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";
import { runSystemMapValidate } from "../handlers/system-map-validate.ts";

const FORGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function createContext(root: string): ForgeRuntimeContext {
  const sink = (_msg: string, _details?: unknown): void => {};
  return {
    workspaceRoot: root,
    forgeRoot: FORGE_ROOT,
    logger: { section: sink, info: sink, warn: sink, error: sink, success: sink },
    dryRun: false,
    outputFormat: "json",
  };
}

describe("system profile (forge create)", () => {
  it("AC-7..AC-9: create produces a map-bearing repo that ignores local file and validates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-system-create-"));
    const result = await runCreate(
      {
        argv: [],
        flags: { "in-place": true, profile: "system", name: "demo-system", "no-flow": true },
      },
      createContext(root),
    );
    expect(result.exitCode).toBe(0);

    // AC-7: the scaffolded map exists and declares the project
    const systemYaml = path.join(root, "system", "system.yaml");
    expect(existsSync(systemYaml)).toBe(true);
    expect(readFileSync(systemYaml, "utf8")).toContain("schema: forge/system@1");
    expect(readFileSync(path.join(root, "system", "products.yaml"), "utf8")).toContain(
      "forge/system-products@1",
    );
    expect(readFileSync(path.join(root, "system", "edges.yaml"), "utf8")).toContain(
      "forge/system-edges@1",
    );

    // AC-8: products.local.yaml is git-ignored
    const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("system/products.local.yaml");
    expect(() =>
      execFileSync("git", ["check-ignore", "system/products.local.yaml"], { cwd: root }),
    ).not.toThrow();

    // AC-9: the freshly created repository passes system.map.validate
    const validate = await runSystemMapValidate({ argv: [], flags: {} }, createContext(root));
    expect(validate.exitCode).toBe(0);
    expect(validate.data?.systemId).toBe("demo-system");
  });

  it("AC-10: profiles/system.yaml satisfies the stack-profile schema with a unique id", () => {
    const profile = loadStackProfile(path.join(FORGE_ROOT, "profiles", "system.yaml"));
    expect(profile.id).toBe("system");
    expect(profile.workspace.dirs).toContain("system");
    expect(profile.workspace.dirs).not.toContain("missions");
    const ids = listStackProfiles(FORGE_ROOT).map((p) => p.id);
    expect(ids.filter((id) => id === "system")).toHaveLength(1);
  });
});
