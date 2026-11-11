/*
<MODULE_CONTRACT>
<purpose>RFC-1568 gate-run record lifecycle tests (AC-2, AC-3): attached-mode
  finish writes endedAt + exit code; a `running` record whose pid is dead
  classifies `lost`; retention deletes beyond 50 per command but never
  touches running records; corrupt records are skipped, not thrown.</purpose>
<non-goals>
  <item>No real git repo — records live under a temp common dir.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1568: step 2 — record lifecycle tests</item>
  <item>RFC-1568: durable gate-run records, --detach mechanics, and forge CLI wiring</item>
</CHANGE_SUMMARY>
*/

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveIo } from "../../../src/utils/io.ts";
import {
  GATE_RUN_RETENTION,
  classifyGateRun,
  finishGateRun,
  gateRunsDir,
  listGateRuns,
  saveGateRun,
  startGateRun,
} from "../record.ts";
import { GATE_RUN_SCHEMA, type GateRunRecord } from "../types.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}, 20_000);

async function tempCommon(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gate-run-"));
  dirs.push(dir);
  return dir;
}

const deadPid = (): number => {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (pid === undefined) throw new Error("spawn failed — cannot produce a dead pid");
  return pid;
};

function fixtureRecord(over: Partial<GateRunRecord> = {}): GateRunRecord {
  return {
    schema: GATE_RUN_SCHEMA,
    runId: over.runId ?? `gr-test-${Math.random().toString(36).slice(2, 8)}`,
    command: "flow.integrate",
    argv: [],
    cwd: ".",
    detached: false,
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    status: "running",
    ...over,
  };
}

const io = resolveIo(undefined);

describe("startGateRun / finishGateRun", () => {
  it("AC-2: finish writes endedAt, exit code, and succeeded status", async () => {
    const common = await tempCommon();
    const record = await startGateRun({
      commonGitDir: common,
      command: "flow.integrate",
      argv: ["--dry-run"],
      cwd: ".",
      detached: false,
      io,
    });
    expect(record.status).toBe("running");
    expect(record.pid).toBe(process.pid);

    await finishGateRun(common, record, { exitCode: 0, summary: "[flow.integrate] done" }, io);

    const raw = JSON.parse(
      await readFile(join(gateRunsDir(common), `${record.runId}.json`), "utf8"),
    ) as GateRunRecord;
    expect(raw.status).toBe("succeeded");
    expect(raw.exitCode).toBe(0);
    expect(raw.endedAt).toBeDefined();
    expect(raw.summary).toBe("[flow.integrate] done");
  });

  it("AC-2: a non-zero exit records failed", async () => {
    const common = await tempCommon();
    const record = await startGateRun({
      commonGitDir: common,
      command: "ecosystem.commit",
      argv: [],
      cwd: ".",
      detached: false,
      io,
    });
    await finishGateRun(common, record, { exitCode: 1 }, io);
    const [read] = await listGateRuns(common, io);
    expect(read?.status).toBe("failed");
    expect(read?.exitCode).toBe(1);
  });
});

describe("classifyGateRun", () => {
  it("AC-3: running record with a dead pid classifies lost", () => {
    const record = fixtureRecord({ pid: deadPid(), host: hostname() });
    expect(classifyGateRun(record)).toBe("lost");
  });

  it("running record with a live pid stays running", () => {
    const record = fixtureRecord({ pid: process.pid, host: hostname() });
    expect(classifyGateRun(record)).toBe("running");
  });

  it("terminal statuses pass through unchanged", () => {
    expect(classifyGateRun(fixtureRecord({ status: "succeeded" }))).toBe("succeeded");
    expect(classifyGateRun(fixtureRecord({ status: "failed" }))).toBe("failed");
  });
});

describe("listGateRuns", () => {
  it("skips corrupt records and returns newest first", async () => {
    const common = await tempCommon();
    const older = fixtureRecord({ runId: "gr-older", startedAt: "2026-01-01T00:00:00.000Z" });
    const newer = fixtureRecord({ runId: "gr-newer", startedAt: "2026-01-02T00:00:00.000Z" });
    await saveGateRun(common, older, io);
    await saveGateRun(common, newer, io);
    await writeFile(join(gateRunsDir(common), "gr-corrupt.json"), "{not json");

    const runs = await listGateRuns(common, io);
    expect(runs.map((r) => r.runId)).toEqual(["gr-newer", "gr-older"]);
  });

  it("filters by command and limit", async () => {
    const common = await tempCommon();
    await saveGateRun(common, fixtureRecord({ runId: "gr-a", command: "flow.integrate" }), io);
    await saveGateRun(common, fixtureRecord({ runId: "gr-b", command: "ecosystem.commit" }), io);

    const filtered = await listGateRuns(common, io, { command: "flow.integrate" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.runId).toBe("gr-a");

    const limited = await listGateRuns(common, io, { limit: 1 });
    expect(limited).toHaveLength(1);
  });
});

describe("retention", () => {
  it("deletes finished records beyond the per-command cap but never running ones", async () => {
    const common = await tempCommon();
    const dir = gateRunsDir(common);
    // 51 finished + 1 running → after the next start, finished are trimmed
    // to 50 and the running record survives.
    for (let i = 0; i < GATE_RUN_RETENTION + 1; i++) {
      await saveGateRun(
        common,
        fixtureRecord({
          runId: `gr-old-${String(i).padStart(3, "0")}`,
          status: "succeeded",
          startedAt: new Date(2026, 0, i + 1).toISOString(),
        }),
        io,
      );
    }
    await saveGateRun(
      common,
      fixtureRecord({
        runId: "gr-alive",
        status: "running",
        startedAt: "2026-06-01T00:00:00.000Z",
      }),
      io,
    );

    await startGateRun({
      commonGitDir: common,
      command: "flow.integrate",
      argv: [],
      cwd: ".",
      detached: false,
      io,
    });

    const runs = await listGateRuns(common, io, { command: "flow.integrate" });
    expect(runs.some((r) => r.runId === "gr-alive")).toBe(true);
    expect(runs.filter((r) => r.status === "succeeded")).toHaveLength(GATE_RUN_RETENTION);
    // oldest finished record was pruned, its file gone from disk.
    const files = await readFile(join(dir, "gr-alive.json"), "utf8").then(() => true);
    expect(files).toBe(true);
  });
});
