/*
<MODULE_CONTRACT>
<purpose>RFC-1500 step 3 — forge.upgrade reports fixed-branch-model state:
not-adopted with a flow.install --dry-run next step (AC-5), guard-drift when
the committed guard block differs from the shipped asset (AC-6), and never
creates or moves a branch (AC-7).</purpose>
<non-goals>
  <item>Not a flow.install/flow.check contract test — their fixtures live in os/flow tests; this file pins the upgrade report surface only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1500: step 3 — upgrade flow-state report tests</item>
  <item>RFC-1500: step 3 — forge.upgrade reports flow state</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, beforeEach, afterEach } from "vitest";

import { runUpgrade } from "../onboarding/upgrade.ts";
import { runFlowInstall } from "../../os/flow/handlers/flow-install.ts";
import type { ForgeRuntimeContext } from "../types.ts";

const silentLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

let repoDir: string;
let forgeSrcDir: string;

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: silentLogger as never,
    dryRun: false,
    outputFormat: "json",
    forgeRoot: join(forgeSrcDir, "packages", "forge"),
  };
}

/** Minimal fake installed forge — readForgePackageVersion + skill sync source. */
async function setupForgeSource(dir: string): Promise<void> {
  await mkdir(join(dir, "packages", "forge", "skills", "fo", "fo-idea"), { recursive: true });
  await writeFile(
    join(dir, "packages", "forge", "skills", "fo", "fo-idea", "SKILL.md"),
    "---\nname: fo-idea\n---\n# fo-idea\n",
    "utf8",
  );
  await writeFile(
    join(dir, "packages", "forge", "package.json"),
    JSON.stringify({ name: "@warpgogol/forge", version: "0.2.0" }),
    "utf8",
  );
}

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
`;

async function initConsumerRepo(dir: string): Promise<void> {
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.name", "Flow Test"]);
  git(dir, ["config", "user.email", "flow-test@example.invalid"]);
  await writeFile(join(dir, "forge.yaml"), FORGE_YAML, "utf8");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "consumer-project", version: "0.1.0" }), "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "chore: consumer scaffold"]);
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "upgrade-flow-repo-"));
  forgeSrcDir = await mkdtemp(join(tmpdir(), "upgrade-flow-forge-"));
  await setupForgeSource(forgeSrcDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
  await rm(forgeSrcDir, { recursive: true, force: true });
});

describe("RFC-1500: forge.upgrade reports flow state without adopting", () => {
  test("AC-5: unadopted repository reports flow.state not-adopted naming flow.install --dry-run", async () => {
    await initConsumerRepo(repoDir);

    const result = await runUpgrade({ argv: [], flags: {} }, makeContext(repoDir));

    expect(result.data?.flow?.state).toBe("not-adopted");
    expect(
      result.data?.flow?.nextSteps.some((s) => s.includes("flow.install --dry-run")),
    ).toBe(true);
  }, 60000);

  test("AC-6: adopted repository with modified committed guard block reports guard-drift", async () => {
    await initConsumerRepo(repoDir);
    const install = await runFlowInstall(
      { argv: [], flags: {} },
      { ...makeContext(repoDir) },
    );
    expect(install.exitCode).toBe(0);

    // Drift: insert a line inside the managed block so the committed block
    // differs from the canonical one while markers and invoke line stay
    // intact (the repo still counts as adopted). --no-verify bypasses the
    // freshly installed guard — the drift models a hand-edited block.
    const hookPath = join(repoDir, "hooks", "pre-commit");
    const tampered = (await readFile(hookPath, "utf8")).replace(
      "# >>> forge flow guard (managed by flow.install) >>>\n",
      "# >>> forge flow guard (managed by flow.install) >>>\n# operator edit\n",
    );
    await writeFile(hookPath, tampered, "utf8");
    git(repoDir, ["add", "hooks/pre-commit"]);
    git(repoDir, ["commit", "--no-verify", "-m", "chore: hand-edit guard block"]);

    const result = await runUpgrade({ argv: [], flags: {} }, makeContext(repoDir));

    expect(result.data?.flow?.state).toBe("guard-drift");
    expect(result.data?.flow?.nextSteps.some((s) => s.includes("flow.install"))).toBe(true);
  }, 60000);

  test("AC-7: upgrade never creates develop in an unadopted repository", async () => {
    await initConsumerRepo(repoDir);

    const result = await runUpgrade({ argv: [], flags: {} }, makeContext(repoDir));
    expect(result.data?.flow?.state).toBe("not-adopted");

    let developExists = true;
    try {
      git(repoDir, ["rev-parse", "--verify", "-q", "refs/heads/develop"]);
    } catch {
      developExists = false;
    }
    expect(developExists).toBe(false);
  }, 60000);
});
