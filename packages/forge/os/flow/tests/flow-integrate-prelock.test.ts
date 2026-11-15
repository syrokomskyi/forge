/*
<MODULE_CONTRACT>
<purpose>RFC-1589 pre-lock integration gate tests (AC-1..AC-5): with
preLock enabled the expensive gate phase runs while integrate.lock is
absent, an unmoved develop lands without any under-lock gate, a moved
develop runs the locked-delta gate under the lock, a failing delta
preserves the develop tip, and two discarded attempts force locked-full.
The gate is a fake hooks/integration-gate.sh recording lock state and env
— never the real gate.</purpose>
<non-goals>
  <item>No legacy under-lock sequence coverage — flow-integrate.test.ts owns it.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1589: pre-lock integration gate — Phase A/B, locked-delta selection, progress guarantee</item>
  <item>RFC-1589: run the integration gate outside the integration lock</item>
  <item>RFC-1592: probe-or-retire ratchet for blocking check rules

Every error-severity check rule now needs liveness evidence — a bound
gate-probe fixture that has actually run — or an explicit entry in the
shrink-only unprobed baseline, enforced by gate.probe.catalog --check
(PROBE-06/07) and wired into the worktree gate as probe-ratchet.

- probe-runs journal (docs/.index/gate-probes/runs.jsonl) records each
  gate.probe fixture execution; shared liveness.ts joins fixtures x
  journal for catalog + contribution report (liveness: none|fixture|fired)
- gate.probe.catalog --check/--write-baseline: PROBE-06 unprobed error
  rule, PROBE-07 stale baseline entry, PROBE-08 baseline growth refusal
  (shrink-only, no file modification), PROBE-09 expired/undeclared
  warnOnly provisional step
- checks.contribution.report adds liveness to every rule record
- KernelPipelineStep/RuleDescriptor gain provisionalUntil; the two
  warnOnly pipeline steps carry future dates
- worktree gate adds probe-ratchet step; gate-domains + forge pre-lock
  DELTA_STEP_SPECS mirror updated
- build-verification policy states blocking rules are probed or retired;
  fo-session-retro preserves probe/retire evidence for escape frictions
- baseline adopted at 1678 entries (forge/unprobed-baseline@1)</item>
  <item>RFC-1599: sweep primary dirt into opened worktrees + bind session writes to the owning checkout (RFC-1599)</item>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { integrateFlowBranch } from "../handlers/flow-integrate.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { readJournal, commonGitDir } from "../registry.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-02T12:00:00Z");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function governedRepo(): Promise<string> {
  const dir = await initRepo({ prefix: "flow-prelock-" });
  dirs.push(dir);
  await writeFile(join(dir, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  // Minimal manifest so the forge-side delta selector resolves real
  // domains (unresolvable command-mapped steps anchor to full-domain).
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(
    join(dir, "docs", "command-manifest.generated.yaml"),
    [
      "commands:",
      "  - name: command.manifest.validate",
      '    reads: ["docs/command-manifest.generated.yaml"]',
      "    writes: []",
      "  - name: ecosystem.manifest.validate",
      '    reads: ["docs/ecosystem.generated.yaml"]',
      "    writes: []",
      "  - name: test.depth.lint",
      '    reads: ["packages/**/tests/**"]',
      "    writes: []",
      "  - name: rfc.validate",
      '    reads: ["docs/rfcs/**"]',
      "    writes: []",
      "  - name: gate.probe.catalog",
      '    reads: ["docs/gate-probes/**", "packages/**/*.ts"]',
      "    writes: []",
      "",
    ].join("\n"),
  );
  await gitExec(dir, ["add", "-A"]);
  await gitExec(dir, ["commit", "-m", "manifest"]);
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
  // A session engine build → the gate runs from the branch worktree and no
  // FLOW-INT-16 primary-engine warning lands in the diagnostics.
  await mkdir(join(data.worktree!, "node_modules"), { recursive: true });
  return data;
}

async function commitIn(worktree: string, file: string, content: string): Promise<void> {
  await mkdir(join(worktree, file, ".."), { recursive: true });
  await writeFile(join(worktree, file), content);
  await gitExec(worktree, ["add", file]);
  const r = await gitExec(worktree, ["commit", "-m", `add ${file}`]);
  if (r.exitCode !== 0) throw new Error(`commit in ${worktree} failed: ${r.stderr}`);
}

async function sha(repo: string, ref: string): Promise<string> {
  return (await gitExec(repo, ["rev-parse", ref])).stdout.trim();
}

/** Fake integration gate — records FORGE_GATE_MODE + integrate.lock
 * presence + FLOW_BASE_SHA to `log`. When `moveMarker` exists in the
 * primary during a pre-lock run it commits the named file to develop
 * (simulating a racing integrate landing between Phase A and the lock). */
async function installFakeGate(
  repo: string,
  log: string,
  opts?: {
    failOnMode?: string;
    moveOnPreLock?: { marker: string; file: string; keepMarker?: boolean };
  },
): Promise<void> {
  const lines = [
    "#!/bin/sh",
    `if [ -f "$FLOW_PRIMARY/.git/forge/integrate.lock" ]; then st=locked; else st=unlocked; fi`,
    `echo "mode=\${FORGE_GATE_MODE:-legacy} state=$st base=$FLOW_BASE_SHA" >> ${JSON.stringify(log)}`,
  ];
  if (opts?.moveOnPreLock !== undefined) {
    const mv = opts.moveOnPreLock;
    lines.push(
      `if [ "\${FORGE_GATE_MODE:-}" = "pre-lock" ] && [ -f "$FLOW_PRIMARY/${mv.marker}" ]; then`,
      ...(mv.keepMarker === true ? [] : [`  rm "$FLOW_PRIMARY/${mv.marker}"`]),
      `  mkdir -p "$(dirname "$FLOW_PRIMARY/${mv.file}")"`,
      `  echo "moved $$" > "$FLOW_PRIMARY/${mv.file}"`,
      `  git -C "$FLOW_PRIMARY" add "${mv.file}"`,
      `  git -C "$FLOW_PRIMARY" commit -q -m "develop moved"`,
      "fi",
    );
  }
  if (opts?.failOnMode !== undefined) {
    lines.push(
      `if [ "\${FORGE_GATE_MODE:-}" = "${opts.failOnMode}" ]; then echo "gate refused" >&2; exit 1; fi`,
    );
  }
  lines.push("exit 0", "");
  await mkdir(join(repo, "hooks"), { recursive: true });
  await writeFile(join(repo, "hooks", "integration-gate.sh"), lines.join("\n"));
  // Committed so the RFC-1599 flow.open sweep leaves the gate in the primary —
  // an uncommitted hook would legitimately move into the session worktree.
  await gitExec(repo, ["add", "hooks/integration-gate.sh"]);
  await gitExec(repo, ["commit", "-m", "install fake gate"]);
}

async function logLines(log: string): Promise<string[]> {
  const text = await ambientIo.readFile(log);
  return text.split("\n").filter((l) => l.length > 0);
}

describe("flow.integrate pre-lock gate (RFC-1589)", () => {
  it("runs the gate while integrate.lock is absent and lands without an under-lock gate (AC-1, AC-2)", async () => {
    const repo = await governedRepo();
    const log = join(repo, "gate.log");
    await installFakeGate(repo, log);
    const session = await openSession(repo, "prelock");
    await commitIn(session.worktree!, "a.txt", "a");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      preLock: true,
    });

    expect(data.diagnostics).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(data.gateMode).toBe("pre-lock");
    expect(data.preLockAttempts).toBe(1);
    expect(typeof data.lockHeldMs).toBe("number");
    const lines = await logLines(log);
    // Exactly one gate run — the pre-lock Phase A — and the lock file was
    // absent while it ran. Nothing ran under the lock afterwards.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("mode=pre-lock");
    expect(lines[0]).toContain("state=unlocked");
    // Journal carries the comparison fields.
    const common = await commonGitDir(ambientIo, repo);
    const journal = await readJournal(ambientIo, common);
    const integrateEvent = journal.find((e) => e.event === "integrate");
    expect(integrateEvent?.gateMode).toBe("pre-lock");
    expect(typeof integrateEvent?.lockHeldMs).toBe("number");
    expect(integrateEvent?.preLockAttempts).toBe(1);
  }, 30_000);

  it("runs locked-delta under the lock when develop moved, selecting the delta's domain steps plus anchors (AC-3)", async () => {
    const repo = await governedRepo();
    const log = join(repo, "gate.log");
    await installFakeGate(repo, log, {
      moveOnPreLock: { marker: ".move-develop", file: "docs/rfcs/rfc-9999.md" },
    });
    const session = await openSession(repo, "delta");
    await commitIn(session.worktree!, "a.txt", "a");
    await writeFile(join(repo, ".move-develop"), "go");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      preLock: true,
    });

    expect(data.diagnostics).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(data.gateMode).toBe("locked-delta");
    // The delta touched only docs/rfcs/** → rfc-validate's domain + the two
    // anchors — exactly what the RFC-1582 selection names.
    expect(data.deltaSelection?.selected).toEqual([
      "changed-range",
      "open-missions",
      "rfc-validate",
    ]);
    expect(data.deltaSelection?.total).toBe(10);
    const lines = await logLines(log);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("mode=pre-lock");
    expect(lines[0]).toContain("state=unlocked");
    expect(lines[1]).toContain("mode=locked-delta");
    expect(lines[1]).toContain("state=locked");
    // The base passed under the lock is the recorded B0.
    const b0 = lines[0]!.split("base=")[1];
    expect(lines[1]).toContain(`base=${b0}`);
    // Both the delta commit and the session work landed.
    expect(
      (await gitExec(repo, ["cat-file", "-e", "develop:docs/rfcs/rfc-9999.md"])).exitCode,
    ).toBe(0);
    expect((await gitExec(repo, ["cat-file", "-e", "develop:a.txt"])).exitCode).toBe(0);
  }, 30_000);

  it("refuses FLOW-INT-05 on a locked-delta failure and preserves the develop tip (AC-4)", async () => {
    const repo = await governedRepo();
    const log = join(repo, "gate.log");
    await installFakeGate(repo, log, {
      failOnMode: "locked-delta",
      moveOnPreLock: { marker: ".move-develop", file: "docs/rfcs/rfc-9999.md" },
    });
    const session = await openSession(repo, "deltafail");
    await commitIn(session.worktree!, "a.txt", "a");
    await writeFile(join(repo, ".move-develop"), "go");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      preLock: true,
    });

    expect(data.integrated).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-05");
    // develop keeps only the racing delta commit — the session branch's tip
    // was never merged.
    const developTip = await sha(repo, "develop");
    expect(
      (await gitExec(repo, ["cat-file", "-e", "develop:docs/rfcs/rfc-9999.md"])).exitCode,
    ).toBe(0);
    expect((await gitExec(repo, ["cat-file", "-e", "develop:a.txt"])).exitCode).not.toBe(0);
    expect(
      (await gitExec(repo, ["rev-parse", "--verify", `refs/heads/${session.branch}`])).exitCode,
    ).toBe(0);
    expect(
      (await gitExec(repo, ["merge-base", "--is-ancestor", developTip, session.branch!])).exitCode,
    ).toBe(0);
  }, 30_000);

  it("discards two oversized-delta attempts then runs locked-full (AC-5)", async () => {
    const repo = await governedRepo();
    const log = join(repo, "gate.log");
    await installFakeGate(repo, log, {
      // Persistent marker — every Phase-A run moves develop again, so B1 != B0 on every attempt.
      moveOnPreLock: { marker: ".move-develop", file: "docs/rfcs/rfc-moved.md", keepMarker: true },
    });
    const session = await openSession(repo, "oversized");
    await commitIn(session.worktree!, "a.txt", "a");
    await writeFile(join(repo, ".move-develop"), "go");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      preLock: true,
      // Every delta looks oversized — forces the progress-guarantee discards.
      deltaGateSelector: async () => ({
        selected: ["a", "b", "c", "d", "e"],
        total: 9,
      }),
    });

    expect(data.diagnostics).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(data.gateMode).toBe("locked-full");
    expect(data.preLockAttempts).toBe(3);
    const lines = await logLines(log);
    // Three unlocked Phase-A gates, then a single locked full run.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("mode=pre-lock");
    expect(lines[0]).toContain("state=unlocked");
    expect(lines[1]).toContain("mode=pre-lock");
    expect(lines[1]).toContain("state=unlocked");
    expect(lines[2]).toContain("mode=pre-lock");
    expect(lines[2]).toContain("state=unlocked");
    expect(lines[3]).toContain("mode=locked-full");
    expect(lines[3]).toContain("state=locked");
  }, 40_000);
});
