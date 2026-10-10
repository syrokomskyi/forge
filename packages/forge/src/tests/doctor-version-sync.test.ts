/*
<MODULE_CONTRACT>
<purpose>Unit tests for the forge-version-sync doctor check — installed
@warpgogol/forge package version vs forge.yaml forge.syncedVersion. Drift is
a warn (pnpm up bumps the package without running forge.upgrade); missing
sides pass with a skipped note.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial forge-version-sync doctor check tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../onboarding/doctor.ts";
import { createForgeCoreModule } from "../../os/core/core.module.ts";
import { ambientIo } from "../utils/io.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../types.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "doctor-version-sync-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeContext(): ForgeRuntimeContext {
  return {
    workspaceRoot: tempDir,
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

function forgeYaml(syncedVersion: string | null): string {
  const forgeSection =
    syncedVersion !== null ? `\nforge:\n  syncedVersion: ${syncedVersion}\n` : "";
  return `schema: "forge/config@1"
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
    sessionsDir: null${forgeSection}
`;
}

async function installForgePackage(version: string): Promise<void> {
  const pkgDir = join(tempDir, "node_modules", "@warpgogol", "forge");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@warpgogol/forge", version }),
  );
}

const input: ForgeCommandInput = { argv: [], flags: {} };

test("forge-version-sync passes when installed version matches syncedVersion", async () => {
  await installForgePackage("1.2.3");
  await writeFile(join(tempDir, "forge.yaml"), forgeYaml("1.2.3"), "utf8");

  const result = await runDoctor(input, makeContext());
  const check = result.data!.checks.find((c) => c.name === "forge-version-sync");
  expect(check).toBeDefined();
  expect(check!.status).toBe("pass");
  expect(check!.message).toContain("1.2.3");
});

test("forge-version-sync warns when installed version diverges from syncedVersion", async () => {
  await installForgePackage("9.9.9");
  await writeFile(join(tempDir, "forge.yaml"), forgeYaml("1.0.0"), "utf8");

  const result = await runDoctor(input, makeContext());
  const check = result.data!.checks.find((c) => c.name === "forge-version-sync");
  expect(check).toBeDefined();
  expect(check!.status).toBe("warn");
  expect(check!.message).toContain("9.9.9");
  expect(check!.message).toContain("1.0.0");
  expect(check!.message).toContain("forge upgrade");
});

test("forge-version-sync passes when no syncedVersion recorded", async () => {
  await installForgePackage("1.2.3");
  await writeFile(join(tempDir, "forge.yaml"), forgeYaml(null), "utf8");

  const result = await runDoctor(input, makeContext());
  const check = result.data!.checks.find((c) => c.name === "forge-version-sync");
  expect(check).toBeDefined();
  expect(check!.status).toBe("pass");
});

test("forge.doctor wraps warn-only results as optional next-steps, fails as required", async () => {
  await installForgePackage("9.9.9");
  await writeFile(join(tempDir, "forge.yaml"), forgeYaml("1.0.0"), "utf8");
  // .agents/skills missing is the only hard fail on a minimal workspace —
  // everything else warns or passes, so the run lands warn-only.
  await mkdir(join(tempDir, ".agents", "skills"), { recursive: true });

  const mod = await createForgeCoreModule();
  const doctor = mod.commands.find((c) => c.name === "forge.doctor")!;
  const ctx: ForgeRuntimeContext = {
    ...makeContext(),
    io: ambientIo,
  } as unknown as ForgeRuntimeContext;
  const result = await doctor.execute(input, ctx);
  expect(result).toBeDefined();
  if (!result) return;

  const data = result.data as { checks?: { status: string }[]; allPass?: boolean } | undefined;
  const checks = data?.checks ?? [];
  const allPass = data?.allPass === true;
  const hasFails = checks.some((c) => c.status === "fail");
  // This workspace should surface warnings (version mismatch at minimum)
  // without hard failures — if the fixture ever drifts, update the scenario.
  expect(allPass).toBe(false);
  expect(hasFails).toBe(false);
  expect(result.nextSteps).toHaveLength(1);
  expect(result.nextSteps![0].kind).toBe("optional");
});
