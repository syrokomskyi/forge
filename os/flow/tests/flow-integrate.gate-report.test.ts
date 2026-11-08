/*
<MODULE_CONTRACT>
<purpose>
RFC-1532 AC-3/AC-4 probe — a successful flow.integrate journals the
gate-report link on its integrate event, a FLOW-INT-05 refusal carries
reportPath in the diagnostic data (and on the integrate-refusal journal
event), and an older gate that prints no marker leaves both absent.
</purpose>
<non-goals>
  <item>No report-writer coverage — that lives in werkstatt-site's worktree-gate.report.test.ts; here only the stdout-marker transport and journal/diagnostic linkage.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1532: persist integration-gate reports per attempt and link them from the flow journal</item>
<history></history>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { integrateFlowBranch } from "../handlers/flow-integrate.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { commonGitDir, readJournal } from "../registry.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-02T12:00:00Z");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function governedRepo(): Promise<string> {
  const dir = await initRepo({ prefix: "flow-gatereport-" });
  dirs.push(dir);
  await writeFile(join(dir, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await gitExec(dir, ["branch", "develop", "HEAD"]);
  await gitExec(dir, ["switch", "develop"]);
  return dir;
}

async function openSession(repo: string, slug: string) {
  const data = await openFlowBranch(repo, ambientIo, {
    kind: "session",
    slug,
    brief: null,
    owner: null,
    dryRun: false,
    now: NOW,
  });
  expect(data.diagnostics).toEqual([]);
  dirs.push(data.worktree!);
  return data;
}

async function commitIn(worktree: string, file: string, content: string): Promise<void> {
  await writeFile(join(worktree, file), content);
  await gitExec(worktree, ["add", file]);
  const r = await gitExec(worktree, ["commit", "-m", `add ${file}`]);
  if (r.exitCode !== 0) throw new Error(`commit in ${worktree} failed: ${r.stderr}`);
}

async function writeGate(repo: string, script: string): Promise<void> {
  await mkdir(join(repo, "hooks"), { recursive: true });
  await writeFile(join(repo, "hooks", "integration-gate.sh"), script);
}

const REPORT_REL = "gate-reports/auto-session-x-20261102T120000.json";

describe("flow.integrate — gate report linkage (RFC-1532)", () => {
  it("AC-3: journals gateReport on the integrate event when the gate wrote a report", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "linked");
    await commitIn(session.worktree!, "a.txt", "a");
    await writeGate(repo, `#!/bin/sh\necho "gate-report: ${REPORT_REL}"\nexit 0\n`);

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(data.gate?.reportPath).toBe(REPORT_REL);
    const common = await commonGitDir(ambientIo, repo);
    const events = await readJournal(ambientIo, common);
    const integrate = events.find((e) => e.event === "integrate" && e.branch === session.branch);
    expect(integrate?.gateReport).toBe(REPORT_REL);
  }, 30_000);

  it("AC-4: FLOW-INT-05 carries reportPath in diagnostic data and on the refusal journal event", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "refused");
    await commitIn(session.worktree!, "a.txt", "a");
    await writeGate(
      repo,
      `#!/bin/sh\necho "gate-report: ${REPORT_REL}"\necho gated >&2\nexit 1\n`,
    );

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.integrated).toBe(false);
    const diag = data.diagnostics.find((d) => d.ruleId === "FLOW-INT-05");
    expect(diag).toBeDefined();
    expect((diag as { data?: Record<string, unknown> }).data?.reportPath).toBe(REPORT_REL);
    const common = await commonGitDir(ambientIo, repo);
    const events = await readJournal(ambientIo, common);
    const refusal = events.find(
      (e) => e.event === "integrate-refusal" && e.branch === session.branch,
    );
    expect(refusal?.gateReport).toBe(REPORT_REL);
  }, 30_000);

  it("older gates without the marker integrate fine — journal carries no gateReport", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "oldgate");
    await commitIn(session.worktree!, "a.txt", "a");
    await writeGate(repo, "#!/bin/sh\nexit 0\n");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(data.gate?.reportPath).toBeNull();
    const common = await commonGitDir(ambientIo, repo);
    const events = await readJournal(ambientIo, common);
    const integrate = events.find((e) => e.event === "integrate" && e.branch === session.branch);
    expect(integrate?.gateReport).toBeUndefined();
  }, 30_000);
});
