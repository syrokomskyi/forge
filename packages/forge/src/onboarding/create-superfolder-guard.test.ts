/*
<MODULE_CONTRACT>
<purpose>Unit tests for the forge.create superfolder guard (RFC-1639 AC-7, CREATE-SUPERFOLDER-01) — a directory of forge-governed children refuses scaffolding in favour of the system-hub model.</purpose>
<non-goals>
  <item>Not a contract source of truth — the implementation under test owns the behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1639: step 5-6 — acceptance tests, system-hub reference, regenerated manifests</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { ForgeRuntimeContext } from "../types.ts";
import { runCreate } from "./create.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "create-superfolder-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function ctx(): ForgeRuntimeContext {
  const sink = (_msg: string, _details?: unknown): void => {};
  return {
    workspaceRoot: tmpDir,
    logger: { section: sink, info: sink, warn: sink, error: sink, success: sink },
    dryRun: false,
    outputFormat: "json",
  };
}

async function childWithForge(name: string): Promise<void> {
  await fs.mkdir(path.join(tmpDir, name), { recursive: true });
  await fs.writeFile(path.join(tmpDir, name, "forge.yaml"), 'schema: "forge/workspace@1"\n');
}

describe("forge.create — CREATE-SUPERFOLDER-01 (RFC-1639)", () => {
  test("a directory of ≥2 forge-governed children refuses with the hub diagnostic", async () => {
    await childWithForge("alpha");
    await childWithForge("beta");
    const result = await runCreate(
      { argv: [], flags: { "in-place": true, profile: "typescript" } },
      ctx(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data?.status).toBe("fail");
    const msg = result.data?.errors.join("\n") ?? "";
    expect(msg).toContain("CREATE-SUPERFOLDER-01");
    expect(msg).toContain("system-profile hub");
    expect(result.data?.filesCreated).toEqual([]);
  });

  test("a single forge-governed child falls through to the plain empty-dir refusal", async () => {
    await childWithForge("alpha");
    const result = await runCreate(
      { argv: [], flags: { "in-place": true, profile: "typescript" } },
      ctx(),
    );
    expect(result.exitCode).toBe(1);
    const msg = result.data?.errors.join("\n") ?? "";
    expect(msg).toContain("Directory is not empty");
    expect(msg).not.toContain("CREATE-SUPERFOLDER-01");
  });
});
