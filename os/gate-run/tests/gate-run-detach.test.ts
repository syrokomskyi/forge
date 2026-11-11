/*
<MODULE_CONTRACT>
<purpose>RFC-1568 detach mechanics tests (AC-4, AC-5): detachSelf passes the
  entry/argv/env contract to an injected spawner and returns the child's pid
  + log path; the detached child adopts the parent's record via
  WERKSTATT_GATE_RUN_ID (startGateRun with runId) so a detached run leaves
  exactly one record carrying the child's pid.</purpose>
<non-goals>
  <item>No real spawned gates — SpawnLike is faked; one integration case may
    spawn `node -e`.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1568: step 3 — detach tests</item>
  <item>RFC-1568: durable gate-run records, --detach mechanics, and forge CLI wiring</item>
</CHANGE_SUMMARY>
*/

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveIo } from "../../../src/utils/io.ts";
import { GATE_RUN_ID_ENV, detachPointerLines, detachSelf } from "../detach.ts";
import { gateRunsDir, listGateRuns, saveGateRun, startGateRun } from "../record.ts";
import type { GateRunRecord, SpawnLike } from "../types.ts";
import { GATE_RUN_SCHEMA } from "../types.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}, 20_000);

async function tempCommon(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gate-run-detach-"));
  dirs.push(dir);
  return dir;
}

const io = resolveIo(undefined);

function recordFixture(common: string): Promise<GateRunRecord> {
  return startGateRun({
    commonGitDir: common,
    command: "flow.integrate",
    argv: ["--files", "a.md"],
    cwd: ".",
    detached: true,
    io,
  });
}

describe("detachSelf", () => {
  it("AC-4: spawns the CLI detached with the run id env and returns the child pid", async () => {
    const common = await tempCommon();
    const record = await recordFixture(common);
    const seen: {
      file?: string;
      args?: string[];
      opts?: { env?: Record<string, string | undefined>; stdio?: unknown[]; detached?: boolean };
    } = {};
    const fakeSpawn: SpawnLike = (file, args, opts) => {
      seen.file = file;
      seen.args = args;
      seen.opts = opts;
      return { pid: 424_242, unref() {} };
    };

    const result = await detachSelf({
      entry: "/repo/packages/forge/bin/cli.ts",
      argv: ["flow.integrate", "--files", "a.md"],
      record,
      commonGitDir: common,
      spawn: fakeSpawn,
    });

    expect(result.pid).toBe(424_242);
    expect(result.runId).toBe(record.runId);
    expect(seen.file).toBe(process.execPath);
    // execArgv forwards the host's loader flags (tsx) so the child re-enters
    // through the same module pipeline as the parent.
    expect(seen.args).toEqual([
      ...process.execArgv,
      "/repo/packages/forge/bin/cli.ts",
      "flow.integrate",
      "--files",
      "a.md",
    ]);
    expect(seen.opts?.detached).toBe(true);
    expect(seen.opts?.env?.[GATE_RUN_ID_ENV]).toBe(record.runId);
    // stdio: stdin ignored, stdout+stderr routed into the log fd.
    expect(seen.opts?.stdio?.[0]).toBe("ignore");
    expect(existsSync(result.logPath)).toBe(true);
    expect(result.logPath).toBe(join(gateRunsDir(common), `${record.runId}.log`));
  });

  it("pointer lines name the run, the log, and the status command", async () => {
    const common = await tempCommon();
    const lines = detachPointerLines(
      { pid: 1, runId: "gr-x", logPath: join(gateRunsDir(common), "gr-x.log") },
      common,
      "pnpm exec werkstatt run gate.run.status",
    );
    expect(lines[0]).toContain("gr-x");
    expect(lines[1]).toContain(".git/forge/gate-runs/gr-x.log");
    expect(lines[2]).toContain("gate.run.status --id gr-x");
  });
});

describe("detached child adoption", () => {
  it("AC-5: the child rewrites the parent's record — one record, child pid", async () => {
    const common = await tempCommon();
    // Parent writes the record before spawning.
    const parent = await recordFixture(common);
    const childPid = 515_151;

    // Child side: WERKSTATT_GATE_RUN_ID set → startGateRun adopts the id.
    const adopted = await startGateRun({
      commonGitDir: common,
      command: parent.command,
      argv: parent.argv,
      cwd: parent.cwd,
      detached: true,
      io,
      runId: parent.runId,
    });
    adopted.pid = childPid;
    await saveGateRun(common, adopted, io);

    const runs = await listGateRuns(common, io);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe(parent.runId);

    const raw = JSON.parse(
      await readFile(join(gateRunsDir(common), `${parent.runId}.json`), "utf8"),
    ) as GateRunRecord;
    expect(raw.pid).toBe(childPid);
    expect(raw.schema).toBe(GATE_RUN_SCHEMA);
    expect(raw.status).toBe("running");
  });
});
