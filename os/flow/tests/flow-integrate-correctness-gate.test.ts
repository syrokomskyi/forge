/*
<MODULE_CONTRACT>
<purpose>RFC-1580 AC-2: flow.integrate spawns the PRIMARY install's
correctness.gate after the integration gate — in enforce mode, an entry
whose only oracle exits non-zero refuses the integration with FLOW-INT-18;
a primary install that predates the command degrades to a FLOW-INT-18
warning; a missing primary binary refuses.</purpose>
<non-goals>
  <item>Not a gate-logic test — os/correctness/gate owns the rules.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: initial suite.</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
  <item>RFC-1580: close review REVIEW-CODE-2026-11-13-04 findings

F1 bootstrap degrade only on an exact unknown-command stderr line with no JSON; F2 review records count only from a verifier-trailer commit naming them; F3 any frozen substrate change or dropped capture is a weakening, declared L3 needs loaded captures; F4 requirement origin needs acceptance before --base; F5 anchor events only for L2+ runs; F6 proof oracles via proof.check only, non-self; F7 bundle naming; F8/F9 limitations; F10 every anchor copy; F11 base entry refs; F12 unreadable base manifest refuses; F13 dirty worktree warning; F14 source/statement diffs; F15 process-group kill; F16 run root cleanup; F20 review dir stripped, blob hashes. Regression tests for spoofing, plain-commit review, L3, requirement origin, rewording, timeout, formal tier, rebind, real-gate pass, accept-weakening. DEV-1..DEV-6 recorded in the RFC.</item>
  <item>RFC-1580: close review REVIEW-CODE-2026-11-13-05 findings

N1 bootstrap degrade only while the base has not adopted the contour (a forge downgrade refuses); N2 L3 on data/lifecycle counts at its attested level; N3 anchor events bound to the attested handle; N4 new support-glob files are frozen additions; N5/N6 isolated sessions may touch anchor files and only frozen forge.yaml keys; N7 RFC body amended; N8 regression tests; N9 run root in finally and grandchildren reaped; N10 every declared capture loaded. DEV-7 recorded; DEV-5 narrowed pending operator confirmation.</item>
</CHANGE_SUMMARY>
*/

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import {
  MIGRATION,
  ORACLE_PATH,
  manifestYaml,
  reviewYaml,
} from "../../correctness/gate/tests/gate-fixture.ts";
import { integrateFlowBranch } from "../handlers/flow-integrate.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-13T12:00:00Z");
const FORGE_CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../bin/cli.ts");
const MARK = "@ai-" + "invariant";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}, 20_000);

async function write(root: string, rel: string, body: string): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), body);
}

/** A primary on develop carrying an enforce-mode manifest whose only oracle fails. */
async function productRepo(oracle: string): Promise<string> {
  const repo = await initRepo({ prefix: "flow-corrgate-" });
  dirs.push(repo);
  await write(
    repo,
    "forge.yaml",
    `schema: forge/config@1\nproject:\n  name: corrgate\npaths: {}\nbindings:\n  schema: forge/bindings@1\n  commands:\n    checkRun: "node {file}"\n  paths:\n    compassDocs: [docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml\ncorrectness:\n  mode: enforce\n`,
  );
  await write(
    repo,
    "docs/requirements.xml",
    '<requirements>\n  <meta><document-id>requirements</document-id></meta>\n  <requirement id="REQ-01">x</requirement>\n</requirements>\n',
  );
  await write(
    repo,
    "apps/api/wrangler.jsonc",
    '{ "d1_databases": [{ "binding": "DB", "database_name": "main", "database_id": "x" }] }\n',
  );
  await write(repo, "apps/api/migrations/0001_init.sql", MIGRATION);
  await write(
    repo,
    "apps/api/src/dispatch.ts",
    `export function dispatch(): void {\n  // ${MARK}[INV-dispatch-01]: dispatch moves an approved candidate to queued exactly once\n  //   (checked-by: test:${ORACLE_PATH})\n}\n`,
  );
  await write(repo, ORACLE_PATH, oracle);
  await write(repo, "docs/correctness.yaml", manifestYaml({}));
  await gitExec(repo, ["add", "-A"]);
  await gitExec(repo, ["commit", "-m", "product with manifest"]);
  const review = "docs/correctness/reviews/2026-11-13-base.yaml";
  await write(repo, review, reviewYaml([{ check: `test:${ORACLE_PATH}`, content: oracle }]));
  await gitExec(repo, ["add", "-A"]);
  await gitExec(repo, [
    "commit",
    "-m",
    `review: oracle review\n\nX-Expectation-Origin: independent-verifier\nX-Verifier-Report: ${review}`,
  ]);
  await gitExec(repo, ["branch", "develop", "HEAD"]);
  await gitExec(repo, ["switch", "develop"]);
  return repo;
}

/** Point the primary's forge binary at the real forge CLI of this checkout. */
async function realPrimaryForge(repo: string): Promise<void> {
  const bin = join(repo, "node_modules", ".bin", "forge");
  await writeFile(bin, `#!/bin/sh\nexec node ${JSON.stringify(FORGE_CLI)} "$@"\n`);
  await chmod(bin, 0o755);
}

async function sessionWithCommit(repo: string): Promise<{ branch: string; worktree: string }> {
  const data = await openFlowBranch(repo, ambientIo, {
    kind: "session",
    slug: "corr",
    brief: null,
    owner: null,
    dryRun: false,
    now: NOW,
  });
  expect(data.diagnostics).toEqual([]);
  dirs.push(data.worktree!);
  await writeFile(join(data.worktree!, "notes.txt"), "unrelated\n");
  await gitExec(data.worktree!, ["add", "notes.txt"]);
  await gitExec(data.worktree!, ["commit", "-m", "add notes"]);
  return { branch: data.branch!, worktree: data.worktree! };
}

describe("flow.integrate — correctness gate (RFC-1580)", () => {
  it("AC-2: an enforce-mode entry whose only oracle exits non-zero refuses with FLOW-INT-18", async () => {
    const repo = await productRepo("process.exit(3);\n");
    await realPrimaryForge(repo);
    const session = await sessionWithCommit(repo);
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch,
      dryRun: false,
      now: NOW,
    });
    expect(data.integrated).toBe(false);
    const refusal = data.diagnostics.find((d) => d.ruleId === "FLOW-INT-18");
    expect(refusal?.severity).toBe("error");
    expect(refusal?.message, "the failing oracle must be named").toMatch(/CORR-GATE-07/);
  }, 120_000);

  it("a primary forge without correctness.gate degrades to a FLOW-INT-18 warning only before adoption", async () => {
    const plain = await initRepo({ prefix: "flow-corrgate-boot-" });
    dirs.push(plain);
    await writeFile(join(plain, "forge.yaml"), 'schema: "forge/workspace@1"\n');
    await gitExec(plain, ["add", "forge.yaml"]);
    await gitExec(plain, ["commit", "-m", "governed"]);
    await gitExec(plain, ["branch", "develop", "HEAD"]);
    await gitExec(plain, ["switch", "develop"]);
    const unknown = "#!/bin/sh\necho '  ✖ Unknown command: correctness.gate' >&2\nexit 1\n";
    await writeFile(join(plain, "node_modules", ".bin", "forge"), unknown);
    const s1 = await sessionWithCommit(plain);
    const boot = await integrateFlowBranch(plain, ambientIo, {
      branch: s1.branch,
      dryRun: false,
      now: NOW,
    });
    expect(boot.integrated).toBe(true);
    expect(boot.diagnostics.find((d) => d.ruleId === "FLOW-INT-18")?.severity).toBe("warning");

    const adopted = await productRepo("process.exit(0);\n");
    await writeFile(join(adopted, "node_modules", ".bin", "forge"), unknown);
    const s2 = await sessionWithCommit(adopted);
    const downgrade = await integrateFlowBranch(adopted, ambientIo, {
      branch: s2.branch,
      dryRun: false,
      now: NOW,
    });
    expect(downgrade.integrated, "a forge downgrade must not drop an adopted gate").toBe(false);
    expect(downgrade.diagnostics.find((d) => d.ruleId === "FLOW-INT-18")?.message).toMatch(
      /already adopted/,
    );
  }, 90_000);

  it("a missing primary forge binary refuses", async () => {
    const repo = await productRepo("process.exit(0);\n");
    await rm(join(repo, "node_modules"), { recursive: true, force: true });
    const session = await sessionWithCommit(repo);
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch,
      dryRun: false,
      now: NOW,
    });
    expect(data.integrated).toBe(false);
    expect(data.diagnostics.find((d) => d.ruleId === "FLOW-INT-18")?.message).toMatch(
      /binary is missing/,
    );
  }, 60_000);

  it("a reviewed, attested oracle lets the integration through the real gate", async () => {
    const { L1_ORACLE } = await import("../../correctness/gate/tests/gate-fixture.ts");
    const repo = await productRepo(L1_ORACLE);
    await realPrimaryForge(repo);
    const session = await sessionWithCommit(repo);
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch,
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(data.correctnessGate?.status).toBe("pass");
  }, 120_000);

  it("--accept-weakening lands an isolated weakening with an X-Correctness-Weakening trailer", async () => {
    const repo = await productRepo("process.exit(0);\n");
    await realPrimaryForge(repo);
    const data0 = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "weak",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    dirs.push(data0.worktree!);
    const wt = data0.worktree!;
    await writeFile(
      join(wt, "docs/correctness.yaml"),
      'schema: forge/correctness-manifest@1\nentries: []\nsupport: []\nexemptions:\n  - ref: REQ-01\n    kind: deferred\n    task: "verbund:T-0001"\n',
    );
    await gitExec(wt, ["add", "-A"]);
    await gitExec(wt, ["commit", "-m", "retire the entry"]);
    const refused = await integrateFlowBranch(repo, ambientIo, {
      branch: data0.branch!,
      dryRun: false,
      now: NOW,
    });
    expect(refused.diagnostics.find((d) => d.ruleId === "FLOW-INT-18")?.message).toMatch(
      /CORR-GATE-02/,
    );
    const accepted = await integrateFlowBranch(repo, ambientIo, {
      branch: data0.branch!,
      dryRun: false,
      now: NOW,
      acceptWeakening: "operator: REQ-01 retired",
    });
    expect(
      accepted.diagnostics.filter((d) => d.severity === "error"),
      JSON.stringify(accepted.diagnostics),
    ).toEqual([]);
    expect(accepted.integrated).toBe(true);
    const log = await gitExec(repo, ["log", "-1", "--format=%B", "develop"]);
    expect(log.stdout).toMatch(/X-Correctness-Weakening: operator: REQ-01 retired/);
  }, 180_000);
});

describe("correctness step output parsing", () => {
  it("the unknown-command phrase inside gate JSON never degrades the refusal (spoof guard)", async () => {
    const { runCorrectnessStep } = await import("../correctness-step.ts");
    const repo = await initRepo({ prefix: "corrstep-" });
    dirs.push(repo);
    const json = JSON.stringify({
      status: "fail",
      bundlePath: null,
      violations: [
        {
          rule: "CORR-GATE-02",
          severity: "error",
          message:
            "weakening (exemption): unverifiable exemption added for Unknown command: correctness.gate",
        },
      ],
    });
    await writeFile(
      join(repo, "node_modules", ".bin", "forge"),
      `#!/bin/sh\necho '${json}'\necho 'Unknown command: correctness.gate' >&2\nexit 1\n`,
    );
    await chmod(join(repo, "node_modules", ".bin", "forge"), 0o755);
    const res = await runCorrectnessStep(ambientIo, {
      primary: repo,
      worktree: repo,
      base: "HEAD",
    });
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/CORR-GATE-02/);
  });
});
