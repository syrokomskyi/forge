/*
<MODULE_CONTRACT>
<purpose>RFC-1500 step 4 / AC-8 — forge.agents.generate emits a "Branch
model" section for repositories adopted into the fixed branch model, using
the repository's command prefix from forge.yaml bindings. Unadopted
repositories get no section.</purpose>
<non-goals>
  <item>Not a template/behavioral-layer test — those live in agents-generate.test.ts; this file pins only the flow section.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1500: step 4 — branch-model section generation tests</item>
  <item>RFC-1500: step 4 — branch-model AGENTS section and consumer docs</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, beforeEach, afterEach } from "vitest";

import { runAgentsGenerate } from "../onboarding/agents-generate.ts";
import { runFlowInstall } from "../../os/flow/handlers/flow-install.ts";
import type { ForgeRuntimeContext } from "../types.ts";

const silentLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

const FORGE_ROOT = join(import.meta.dirname, "..", "..");

const FORGE_YAML = `schema: forge/config@1
project:
  name: consumer-project
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
`;

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: silentLogger as never,
    dryRun: false,
    outputFormat: "json",
    forgeRoot: FORGE_ROOT,
  };
}

async function initRepo(dir: string): Promise<void> {
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.name", "Flow Test"]);
  git(dir, ["config", "user.email", "flow-test@example.invalid"]);
  await writeFile(join(dir, "forge.yaml"), FORGE_YAML, "utf8");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "consumer-project", version: "0.1.0" }),
    "utf8",
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "chore: consumer scaffold"]);
}

let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "agents-flow-test-"));
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("RFC-1500: agents.generate branch-model section (AC-8)", () => {
  test("adopted repository gains a Branch model section with the bindings prefix", async () => {
    await initRepo(repoDir);
    const install = await runFlowInstall({ argv: [], flags: {} }, makeContext(repoDir));
    expect(install.exitCode).toBe(0);

    const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(repoDir));
    expect(result.exitCode).toBe(0);

    const agentsMd = await readFile(join(repoDir, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("## Branch model");
    expect(agentsMd).toContain("pnpm exec forge flow.open --kind session --slug <slug>");
    expect(agentsMd).toContain("flow.open");
  }, 60000);

  test("unadopted repository gets no Branch model section", async () => {
    await initRepo(repoDir);

    const result = await runAgentsGenerate({ argv: [], flags: {} }, makeContext(repoDir));
    expect(result.exitCode).toBe(0);

    const agentsMd = await readFile(join(repoDir, "AGENTS.md"), "utf8");
    expect(agentsMd).not.toContain("## Branch model");
  }, 60000);
});
