/*
<MODULE_CONTRACT>
<purpose>RFC-1575 AC-1..AC-3 — gate.run.status is excluded from the kernel result cache, and `--id --wait` ends with a verdict: `completed` when the run leaves `running`, `budget-expired` when the deadline passes first.</purpose>
<non-goals>
  <item>No detached child — records are written by hand under a temp repo's common dir.</item>
</non-goals>
</MODULE_CONTRACT>
*/
// Test-Reason: requirement AC-1, AC-2, AC-3 (RFC-1575)
import { spawnSync } from "node:child_process";

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveIo } from "../../../src/utils/io.ts";
import { saveGateRun } from "../record.ts";
import { WAIT_EXPIRED_SUFFIX, gateRunStatusCommand, runGateRunStatus } from "../status.ts";
import { GATE_RUN_SCHEMA, type GateRunRecord } from "../types.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "gate-run-status-")));
  dirs.push(dir);
  const init = spawnSync("git", ["init", "-q", dir]);
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  return dir;
}

function record(runId: string, over: Partial<GateRunRecord> = {}): GateRunRecord {
  return {
    schema: GATE_RUN_SCHEMA,
    runId,
    command: "flow.integrate",
    argv: [],
    cwd: ".",
    detached: true,
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    status: "running",
    ...over,
  };
}

const silent = { section() {}, info() {}, warn() {}, error() {}, success() {} };
const ctx = (root: string) =>
  ({ workspaceRoot: root, logger: silent, dryRun: false, outputFormat: "json" }) as never;

describe("gate.run.status (RFC-1575)", () => {
  it("AC-1: declares cacheable: false", () => {
    expect(gateRunStatusCommand.cacheable, "live state must never come from the result cache").toBe(
      false,
    );
  });

  it("AC-2: --wait reports completed when the run leaves running", async () => {
    const root = await repo();
    const io = resolveIo(undefined);
    const common = join(root, ".git");
    await saveGateRun(common, record("gr-a"), io);
    setTimeout(() => {
      void saveGateRun(
        common,
        record("gr-a", { status: "succeeded", exitCode: 0, endedAt: new Date().toISOString() }),
        io,
      );
    }, 300);
    const result = await runGateRunStatus(
      { argv: [], flags: { id: "gr-a", wait: "10" } },
      ctx(root),
    );
    expect(result.data?.runs[0]?.status).toBe("succeeded");
    expect(result.data?.wait?.outcome).toBe("completed");
    expect(result.summary).toContain("left running after");
  }, 20_000);

  it("AC-3: --wait reports budget-expired when the run is still running at the deadline", async () => {
    const root = await repo();
    const io = resolveIo(undefined);
    await saveGateRun(join(root, ".git"), record("gr-b"), io);
    const result = await runGateRunStatus(
      { argv: [], flags: { id: "gr-b", wait: "1" } },
      ctx(root),
    );
    expect(result.data?.runs[0]?.status).toBe("running");
    expect(result.data?.wait?.outcome).toBe("budget-expired");
    expect(result.summary).toContain(WAIT_EXPIRED_SUFFIX);
  }, 20_000);

  it("no --wait means no verdict field", async () => {
    const root = await repo();
    await saveGateRun(join(root, ".git"), record("gr-c"), resolveIo(undefined));
    const result = await runGateRunStatus({ argv: [], flags: { id: "gr-c" } }, ctx(root));
    expect(result.data?.wait).toBeUndefined();
  });

  // Test-Reason: regression lost-run wait mapping (REVIEW-CODE-2026-11-12-05 E-2)
  it("a dead-holder (lost) run ends the wait as completed — it left running", async () => {
    const root = await repo();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    await saveGateRun(join(root, ".git"), record("gr-d", { pid: dead }), resolveIo(undefined));
    const result = await runGateRunStatus(
      { argv: [], flags: { id: "gr-d", wait: "5" } },
      ctx(root),
    );
    expect(result.data?.runs[0]?.status).toBe("lost");
    expect(result.data?.wait?.outcome).toBe("completed");
  }, 20_000);
});
