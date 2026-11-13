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
  await write(
    repo,
    "docs/correctness/reviews/2026-11-13-base.yaml",
    reviewYaml([{ check: `test:${ORACLE_PATH}`, content: oracle }]),
  );
  await gitExec(repo, ["add", "-A"]);
  await gitExec(repo, ["commit", "-m", "product with manifest"]);
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

  it("a primary install that predates correctness.gate degrades to a FLOW-INT-18 warning", async () => {
    const repo = await productRepo("process.exit(0);\n");
    await writeFile(
      join(repo, "node_modules", ".bin", "forge"),
      "#!/bin/sh\necho '  ✖ Unknown command: correctness.gate' >&2\nexit 1\n",
    );
    const session = await sessionWithCommit(repo);
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch,
      dryRun: false,
      now: NOW,
    });
    expect(data.integrated).toBe(true);
    expect(data.diagnostics.find((d) => d.ruleId === "FLOW-INT-18")?.severity).toBe("warning");
  }, 60_000);

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
});
