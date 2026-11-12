/*
<MODULE_CONTRACT>
<purpose>RFC-1573 AC-8 — forge.agents.generate emits the detach line in the
"Branch model" section of flow-adopted repositories, listing the detachable
forge commands from their declarations; unadopted repositories get none.</purpose>
<non-goals>
  <item>Not the branch-model section itself — agents-generate-flow.test.ts pins that.</item>
</non-goals>
</MODULE_CONTRACT>
*/
// Test-Reason: requirement AC-8 (RFC-1573)
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
  repoDir = await mkdtemp(join(tmpdir(), "agents-detach-test-"));
});
afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("RFC-1573: agents.generate detach line (AC-8)", () => {
  test("adopted repository lists detachable commands and gate.run.status", async () => {
    await initRepo(repoDir);
    expect((await runFlowInstall({ argv: [], flags: {} }, makeContext(repoDir))).exitCode).toBe(0);
    expect((await runAgentsGenerate({ argv: [], flags: {} }, makeContext(repoDir))).exitCode).toBe(
      0,
    );

    const agentsMd = await readFile(join(repoDir, "AGENTS.md"), "utf8");
    const line = agentsMd.split("\n").find((l) => l.startsWith("- Multi-minute commands ("));
    expect(line, "Branch model section must carry the RFC-1573 detach line").toBeDefined();
    for (const name of ["flow.cut", "flow.backmerge", "flow.integrate", "rfc.implement.stamp"]) {
      expect(line, `detach list must include ${name} (declared detachable)`).toContain(
        `\`${name}\``,
      );
    }
    expect(line).not.toContain("`flow.open`");
    expect(line).toContain("pnpm exec forge gate.run.status --id <runId> --wait 600");
    expect(line).toContain("Never a background shell or `timeout`.");
  }, 60000);

  test("unadopted repository gets no detach line", async () => {
    await initRepo(repoDir);
    expect((await runAgentsGenerate({ argv: [], flags: {} }, makeContext(repoDir))).exitCode).toBe(
      0,
    );
    const agentsMd = await readFile(join(repoDir, "AGENTS.md"), "utf8");
    expect(agentsMd).not.toContain("- Multi-minute commands (");
  }, 60000);
});
