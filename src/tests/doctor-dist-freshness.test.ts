/*
<MODULE_CONTRACT>
<purpose>Unit tests for the dist-freshness doctor check — warns when a forge
source checkout's dist/ is older than the newest src/ file (RFC-1151).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1151: initial dist-freshness tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../onboarding/doctor.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../types.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "doctor-dist-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeContext(): ForgeRuntimeContext {
  return {
    workspaceRoot: tempDir,
    // forgeRoot falls back to <workspaceRoot>/packages/forge when unresolvable
    forgeRoot: join(tempDir, "packages", "forge"),
    logger: {
      section: () => {},
      success: () => {},
      warn: () => {},
      error: () => {},
      info: () => {},
    },
    dryRun: false,
    outputFormat: "json",
  };
}

const FORGE_YAML = `schema: "forge/config@1"
project:
  name: test-project
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
`;

async function makeForgeCheckout(srcMtime: Date, distMtime: Date): Promise<void> {
  const forgeRoot = join(tempDir, "packages", "forge");
  await mkdir(join(forgeRoot, "src"), { recursive: true });
  await mkdir(join(forgeRoot, "dist"), { recursive: true });
  await writeFile(join(forgeRoot, "package.json"), JSON.stringify({ name: "@warpgogol/forge" }));
  await writeFile(join(forgeRoot, "src", "index.ts"), "export {};\n");
  await writeFile(join(forgeRoot, "dist", "index.js"), "export {};\n");
  await utimes(join(forgeRoot, "src", "index.ts"), srcMtime, srcMtime);
  await utimes(join(forgeRoot, "dist"), distMtime, distMtime);
}

test("dist-freshness warns when dist is older than newest src file", async () => {
  await writeFile(join(tempDir, "forge.yaml"), FORGE_YAML, "utf8");
  const old = new Date("2026-01-01T00:00:00Z");
  const recent = new Date("2026-09-01T00:00:00Z");
  await makeForgeCheckout(recent, old);

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runDoctor(input, makeContext());

  const check = result.data!.checks.find((c) => c.name === "dist-freshness");
  expect(check).toBeDefined();
  expect(check!.status).toBe("warn");
  expect(check!.message).toContain("pnpm run build");
});

test("dist-freshness passes when dist is absent (npm consumer layout)", async () => {
  await writeFile(join(tempDir, "forge.yaml"), FORGE_YAML, "utf8");
  // No packages/forge at all — forgeRoot fallback dir doesn't exist
  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runDoctor(input, makeContext());

  const check = result.data!.checks.find((c) => c.name === "dist-freshness");
  expect(check).toBeDefined();
  expect(check!.status).toBe("pass");
});

test("dist-freshness passes when dist is newer than src", async () => {
  await writeFile(join(tempDir, "forge.yaml"), FORGE_YAML, "utf8");
  const old = new Date("2026-01-01T00:00:00Z");
  const recent = new Date("2026-09-01T00:00:00Z");
  await makeForgeCheckout(old, recent);

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runDoctor(input, makeContext());

  const check = result.data!.checks.find((c) => c.name === "dist-freshness");
  expect(check).toBeDefined();
  expect(check!.status).toBe("pass");
  expect(check!.message).toContain("fresh");
});
