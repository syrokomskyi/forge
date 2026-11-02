/*
<MODULE_CONTRACT>
<purpose>RFC-1489: planner + executor for batched `test` acceptance probes — groups same-bound test probes between run/page/proof barriers into one instrumented Vitest run and attributes per declared (file, testName).</purpose>
<non-goals>
  <item>Does not execute non-test probes — callers route those through runProbe individually.</item>
  <item>Does not write artifacts — the JSON report lands in an OS temp dir, consumed and deleted.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1489: probe-execution planning layer — bound-grouped Vitest batching with per-entry attribution and unverified-on-missing-slice.</item>
</CHANGE_SUMMARY>
*/

import { spawn } from "../../src/utils/sync-fs.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ambientIo as io } from "../../src/utils/io.ts";
import type { AcceptanceProbe, ProbeResult } from "./types.ts";

/**
 * A group of `test` probes sharing one effective timeout bound between
 * `run`/`page`/`proof` barriers executes in ONE instrumented Vitest process
 * (`--reporter=json --outputFile`), with each declared probe attributed only
 * to its own (file, testName) slice of the JSON report. Non-barrier probes
 * of other kinds keep their declared positions inside a segment's span.
 * A missing file or an unavailable report yields `unverified`, never a pass.
 */

export interface TestProbeLike {
  probe: "test";
  file: string;
  testName?: string;
  timeoutMs?: number;
  expect: { exitCode: number };
}

const isBatchableTest = (p: AcceptanceProbe): p is AcceptanceProbe & TestProbeLike =>
  p.probe === "test";

/** Only `run`/`page`/`proof` are barriers — every other kind keeps its own
 * declared position inside a segment's span without splitting the group. */
const isBarrierProbe = (p: AcceptanceProbe): boolean =>
  p.probe === "run" || p.probe === "page" || p.probe === "proof";

export interface ProbeSegment {
  /** Index of the segment's earliest member — its execution position. */
  start: number;
  /** Declared indices of the segment's test-probe members, ascending. */
  members: number[];
  /** Shared effective timeout bound for the segment. */
  boundMs: number;
}

/**
 * Groups declared probes into segments of `test` probes sharing one
 * effective bound, broken only by `run`/`page`/`proof` barriers. A segment
 * may span non-barrier probes of other kinds — those keep their own
 * declared position while the group executes at its earliest member.
 */
export function planProbeSegments(
  probes: AcceptanceProbe[],
  defaultBoundMs: number,
): ProbeSegment[] {
  const segments: ProbeSegment[] = [];
  let open: ProbeSegment | undefined;
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i]!;
    if (isBarrierProbe(p)) {
      open = undefined;
      continue;
    }
    if (!isBatchableTest(p)) continue; // non-barrier non-test — span, no split
    const bound = p.timeoutMs ?? defaultBoundMs;
    if (open && open.boundMs === bound) {
      open.members.push(i);
    } else {
      open = { start: i, members: [i], boundMs: bound };
      segments.push(open);
    }
  }
  return segments;
}

interface VitestAssertionResult {
  title?: string;
  fullName?: string;
  ancestorTitles?: string[];
  status?: string;
}

interface VitestFileResult {
  name?: string;
  status?: string;
  assertionResults?: VitestAssertionResult[];
}

interface VitestJsonReport {
  testResults?: VitestFileResult[];
}

export interface BatchSpawnOutcome {
  exitCode: number | null;
  timedOut: boolean;
  report?: VitestJsonReport;
  reportError?: string;
}

/** Spawns one instrumented Vitest process for a barrier-free segment. */
export async function spawnBatchedVitest(
  workspaceRoot: string,
  files: string[],
  boundMs: number,
  outputFile: string,
): Promise<BatchSpawnOutcome> {
  const args = [
    "exec",
    "vitest",
    "run",
    ...files,
    "--reporter=json",
    `--outputFile=${outputFile}`,
    // Serial file execution inside the batch spawn — per-file resource
    // footprints stack, and parallel files inside one run re-create the
    // memory pressure batching exists to remove (F-0029 evidence).
    "--fileParallelism=false",
  ];

  let stderrTail = "";
  const exit = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve) => {
    const child = spawn("pnpm", args, {
      cwd: workspaceRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ exitCode: null, timedOut: true });
    }, boundMs);
    timer.unref?.();
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut: false });
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut: false });
    });
  });

  if (exit.timedOut) return { ...exit, reportError: stderrTail || undefined };

  let raw: string;
  try {
    raw = await io.readFile(outputFile);
  } catch {
    return {
      ...exit,
      reportError: `Vitest JSON report not produced at ${outputFile}${stderrTail ? ` — stderr: ${stderrTail.trim().slice(-400)}` : ""}`,
    };
  }
  try {
    return { ...exit, report: JSON.parse(raw) as VitestJsonReport };
  } catch (e) {
    return {
      ...exit,
      reportError: `Vitest JSON report unparseable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

const normalizeReportPath = (p: string): string => path.resolve(p).split(path.sep).join("/");

/**
 * Attributes one declared test probe to its own (file, testName) slice of
 * the Vitest JSON report. Never derives a pass from another probe's slice;
 * absent slices yield `unverified` (RFC-1489 AC-3).
 */
export function attributeProbeResult(
  probe: TestProbeLike,
  workspaceRoot: string,
  report: VitestJsonReport,
): ProbeResult {
  const wantedFile = normalizeReportPath(path.join(workspaceRoot, probe.file));
  const entry = (report.testResults ?? []).find(
    (t) => typeof t.name === "string" && normalizeReportPath(t.name) === wantedFile,
  );
  const unverified = (detail: string): ProbeResult => ({
    probe: probe as AcceptanceProbe,
    ok: false,
    verdict: "unverified",
    detail,
  });
  if (!entry) {
    return unverified(`file ${probe.file} absent from Vitest JSON report`);
  }

  const assertions = entry.assertionResults ?? [];
  let matched: VitestAssertionResult[];
  let slicePassed: boolean;
  if (probe.testName !== undefined) {
    matched = assertions.filter((a) => (a.fullName ?? "").includes(probe.testName!));
    if (matched.length === 0) {
      // Spec §4: zero matches is a base `fail` — invertible by expect, and
      // parity with `vitest -t` exiting nonzero on a no-match run.
      return {
        probe: probe as AcceptanceProbe,
        ok: false,
        verdict: "fail",
        detail: `no testName match in report for "${probe.testName}" in ${probe.file}`,
      };
    }
    slicePassed = matched.every((a) => a.status === "passed");
  } else {
    matched = assertions;
    // File-level: base ok iff the file's report entry exists and status is
    // `passed` — a skipped/pending file cannot prove its tests executed.
    slicePassed = entry.status === "passed";
    if (matched.length === 0 && !slicePassed && entry.status !== "failed") {
      return unverified(`file ${probe.file} produced no assertions in Vitest report`);
    }
  }

  const derivedExitCode = slicePassed ? 0 : 1;
  const ok = derivedExitCode === probe.expect.exitCode;
  return {
    probe: probe as AcceptanceProbe,
    ok,
    verdict: ok ? "pass" : "fail",
    detail: `batched: ${matched.length} assertion(s) in ${probe.file}${
      probe.testName ? ` matching "${probe.testName}"` : ""
    }, derived exitCode=${derivedExitCode} (expected ${probe.expect.exitCode})`,
  };
}

/**
 * Executes one segment of `test` probes in a single Vitest process and
 * returns per-index results keyed into the declared probe list. Identical
 * probes collapse on a canonical key and fan the computed verdict out per
 * declared position (spec §5). Spawn/report failures mark every segment
 * probe `unverified`; a spawn timeout mirrors the legacy `timedOut` fail.
 */
export async function runBatchedTestSegment(
  probes: AcceptanceProbe[],
  segment: ProbeSegment,
  workspaceRoot: string,
  spawnFn: typeof spawnBatchedVitest = spawnBatchedVitest,
): Promise<Map<number, ProbeResult>> {
  const results = new Map<number, ProbeResult>();
  const runnable: Array<{ index: number; probe: TestProbeLike; file: string }> = [];

  for (const i of segment.members) {
    const probe = probes[i] as TestProbeLike;
    const absFile = path.join(workspaceRoot, probe.file);
    try {
      const st = await io.stat(absFile);
      if (!st.isFile) throw new Error("not a file");
      runnable.push({ index: i, probe, file: probe.file });
    } catch {
      results.set(i, {
        probe: probe as AcceptanceProbe,
        ok: false,
        verdict: "unverified",
        detail: `test file ${probe.file} does not exist`,
      });
    }
  }
  if (runnable.length === 0) return results;

  // Spec §5: a canonical key collapses identical probes — attribute once and
  // fan the verdict out per declared position.
  const canonicalKey = (p: TestProbeLike): string =>
    JSON.stringify([p.file, p.testName ?? null, p.timeoutMs ?? null, p.expect.exitCode]);
  const byKey = new Map<string, { index: number; probe: TestProbeLike }>();
  for (const r of runnable) {
    const key = canonicalKey(r.probe);
    if (!byKey.has(key)) byKey.set(key, r);
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), "forge-probe-batch-"));
  const outputFile = path.join(tmpDir, "vitest-report.json");
  try {
    const files = [...new Set(runnable.map((r) => r.file))];
    const outcome = await spawnFn(workspaceRoot, files, segment.boundMs, outputFile);

    if (outcome.timedOut) {
      for (const r of runnable) {
        results.set(r.index, {
          probe: r.probe as AcceptanceProbe,
          ok: false,
          detail: `timed out after ${segment.boundMs}ms`,
        });
      }
      return results;
    }
    if (!outcome.report) {
      for (const r of runnable) {
        results.set(r.index, {
          probe: r.probe as AcceptanceProbe,
          ok: false,
          verdict: "unverified",
          detail: `batched report unavailable — ${outcome.reportError ?? `vitest exited ${outcome.exitCode}`}`,
        });
      }
      return results;
    }
    const computed = new Map<string, ProbeResult>();
    for (const [key, r] of byKey) {
      computed.set(key, attributeProbeResult(r.probe, workspaceRoot, outcome.report));
    }
    for (const r of runnable) {
      const base = computed.get(canonicalKey(r.probe))!;
      results.set(r.index, { ...base, probe: r.probe as AcceptanceProbe });
    }
    return results;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
