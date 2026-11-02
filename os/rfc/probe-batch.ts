import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ambientIo as io } from "../../src/utils/io.ts";
import type { AcceptanceProbe, ProbeResult } from "./types.ts";

/**
 * RFC-1489: planner + executor for batched `test` acceptance probes.
 * A maximal contiguous run of `test` probes sharing one effective timeout
 * bound (a "barrier-free segment") executes in ONE instrumented Vitest
 * process (`--reporter=json --outputFile`), with each declared probe
 * attributed only to its own (file, testName) slice of the JSON report.
 * Non-test probes and bound changes are barriers; `run`/`page`/`proof`
 * kinds are never batched. A missing file or an unavailable report yields
 * `unverified`, never a pass.
 */

export interface TestProbeLike {
  probe: "test";
  file: string;
  testName?: string;
  timeoutMs?: number;
  expect: { exitCode: number };
}

export interface ProbeSegment {
  /** Inclusive start index into the declared probe list. */
  start: number;
  /** Exclusive end index into the declared probe list. */
  end: number;
  /** Shared effective timeout bound for the segment. */
  boundMs: number;
}

const isBatchableTest = (p: AcceptanceProbe): p is AcceptanceProbe & TestProbeLike =>
  p.probe === "test";

/**
 * Groups declared probes into maximal contiguous segments of `test` probes
 * sharing the same effective bound. Every other probe kind is a barrier:
 * it appears in no segment and is executed individually by the caller.
 */
export function planProbeSegments(
  probes: AcceptanceProbe[],
  defaultBoundMs: number,
): ProbeSegment[] {
  const segments: ProbeSegment[] = [];
  let open: ProbeSegment | undefined;
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i]!;
    if (isBatchableTest(p)) {
      const bound = p.timeoutMs ?? defaultBoundMs;
      if (open && open.boundMs === bound && open.end === i) {
        open.end = i + 1;
      } else {
        open = { start: i, end: i + 1, boundMs: bound };
        segments.push(open);
      }
    } else {
      open = undefined;
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
  ];

  const exit = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve) => {
    const child = spawn("pnpm", args, { cwd: workspaceRoot, stdio: "ignore" });
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

  if (exit.timedOut) return { ...exit };

  let raw: string;
  try {
    raw = await io.readFile(outputFile);
  } catch {
    return { ...exit, reportError: `Vitest JSON report not produced at ${outputFile}` };
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
  if (probe.testName !== undefined) {
    matched = assertions.filter((a) => (a.fullName ?? "").includes(probe.testName!));
    if (matched.length === 0) {
      return unverified(
        `no assertion in ${probe.file} matches testName "${probe.testName}"`,
      );
    }
  } else {
    matched = assertions;
    if (matched.length === 0 && entry.status !== "failed") {
      // A file entry with zero assertions mirrors `vitest run <file>` exiting
      // non-zero only when the file itself failed; treat as failed slice.
      return unverified(`file ${probe.file} produced no assertions in Vitest report`);
    }
  }

  const anyFailed =
    entry.status === "failed" && probe.testName === undefined
      ? true
      : matched.some((a) => a.status === "failed");
  const derivedExitCode = anyFailed ? 1 : 0;
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

export interface BatchedSegmentResult {
  results: Map<number, ProbeResult>;
}

/**
 * Executes one barrier-free segment of `test` probes in a single Vitest
 * process and returns per-index results keyed into the declared probe list.
 * Spawn/report failures mark every segment probe `unverified`.
 */
export async function runBatchedTestSegment(
  probes: AcceptanceProbe[],
  segment: ProbeSegment,
  workspaceRoot: string,
): Promise<Map<number, ProbeResult>> {
  const results = new Map<number, ProbeResult>();
  const runnable: Array<{ index: number; probe: TestProbeLike; file: string }> = [];

  for (let i = segment.start; i < segment.end; i++) {
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

  const tmpDir = mkdtempSync(path.join(tmpdir(), "forge-probe-batch-"));
  const outputFile = path.join(tmpDir, "vitest-report.json");
  try {
    const files = [...new Set(runnable.map((r) => r.file))];
    const outcome = await spawnBatchedVitest(
      workspaceRoot,
      files,
      segment.boundMs,
      outputFile,
    );

    if (outcome.timedOut) {
      for (const r of runnable) {
        results.set(r.index, {
          probe: r.probe as AcceptanceProbe,
          ok: false,
          verdict: "unverified",
          detail: `batched run timed out after ${segment.boundMs}ms`,
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
    for (const r of runnable) {
      results.set(r.index, attributeProbeResult(r.probe, workspaceRoot, outcome.report));
    }
    return results;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
