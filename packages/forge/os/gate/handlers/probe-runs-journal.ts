/*
<MODULE_CONTRACT>
<purpose>RFC-1592: per-fixture probe-runs journal — the append-only JSONL
record of every gate.probe execution at docs/.index/gate-probes/runs.jsonl
({runId, fixture, contract, rule, status, diagnostics, at} per probed fixture).
The liveness surface gate.probe.catalog and checks.contribution.report read
"fixture" evidence from — a bound fixture counts only when its last recorded
run fired (status pass).</purpose>
<non-goals>
  <item>Runs are recorded, never evaluated here — pass/fail semantics stay
  inside gate.probe's report construction.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>File order is canonical; `at` is informational — "last run" = the last
  record for the rule in file order.</item>
  <item>Append failures return a warning string, never throw — telemetry must
  never break the gate it observes.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1592: probe-runs journal — append-only JSONL writer + tolerant reader + last-run-by-rule projection</item>
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
</CHANGE_SUMMARY>
*/

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

/** Repo-relative journal path (gitignored — inherits the docs/.index/ ignore). */
export const PROBE_RUNS_JOURNAL_PATH = "docs/.index/gate-probes/runs.jsonl";

export const PROBE_RUN_STATUSES = ["pass", "fail", "error"] as const;
export type ProbeRunStatus = (typeof PROBE_RUN_STATUSES)[number];

export const probeRunRecordSchema = z
  .object({
    /** Groups every record one gate.probe invocation emitted. */
    runId: z.string().min(1),
    /** Workspace-relative fixture.yaml path. */
    fixture: z.string().min(1),
    /** The fixture's bound contract directory name. */
    contract: z.string().min(1),
    /** The rule the fixture binds. */
    rule: z.string().min(1),
    /** pass = the check fired the bound rule on the seeded violation. */
    status: z.enum(PROBE_RUN_STATUSES),
    diagnostics: z.number().int().nonnegative(),
    /** ISO-8601 timestamp — informational; file order is canonical. */
    at: z.string().datetime(),
  })
  .strict();
export type ProbeRunRecord = z.infer<typeof probeRunRecordSchema>;

/**
 * Appends one JSONL line per record via node:fs appendFile. Returns a warning
 * string on failure and never throws — a broken journal must not break the
 * gate it observes. An empty record set is a no-op.
 */
export async function recordProbeRuns(
  workspaceRoot: string,
  records: readonly ProbeRunRecord[],
): Promise<string | undefined> {
  if (records.length === 0) return undefined;
  const file = join(workspaceRoot, PROBE_RUNS_JOURNAL_PATH);
  // A command can remove its own workspace root (flow.integrate tears down the
  // session worktree); mkdir -p below would recreate it as an orphan directory.
  try {
    await stat(workspaceRoot);
  } catch {
    return `probe-runs journal skipped: workspace root ${workspaceRoot} no longer exists`;
  }
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    return undefined;
  } catch (error) {
    return `probe-runs journal append failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface ProbeRunsJournalRead {
  records: ProbeRunRecord[];
  malformedLines: number;
  /** The final line was a partial (crash-truncated) record — dropped, not fatal. */
  truncatedTail: boolean;
}

/**
 * Tolerant reader: absent file → empty; each line parses against the strict
 * record schema; a JSON-parse failure on the FINAL line counts as a
 * crash-truncated tail (dropped silently), everything else unparseable counts
 * as malformed.
 */
export async function readProbeRunsJournal(workspaceRoot: string): Promise<ProbeRunsJournalRead> {
  let src: string;
  try {
    src = await readFile(join(workspaceRoot, PROBE_RUNS_JOURNAL_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], malformedLines: 0, truncatedTail: false };
    }
    throw error;
  }
  if (src === "") return { records: [], malformedLines: 0, truncatedTail: false };
  const lines = src.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const records: ProbeRunRecord[] = [];
  let malformedLines = 0;
  let truncatedTail = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") {
      malformedLines++;
      continue;
    }
    let parsed: unknown;
    let jsonFailed = false;
    try {
      parsed = JSON.parse(line);
    } catch {
      jsonFailed = true;
    }
    const validated = jsonFailed ? undefined : probeRunRecordSchema.safeParse(parsed);
    if (validated?.success) {
      records.push(validated.data);
    } else if (i === lines.length - 1 && jsonFailed) {
      truncatedTail = true;
    } else {
      malformedLines++;
    }
  }
  return { records, malformedLines, truncatedTail };
}

/**
 * Projects the journal into the last recorded status per bound rule. File
 * order is canonical — the last record for a rule wins.
 */
export function lastRunStatusByRule(
  records: readonly ProbeRunRecord[],
): Map<string, ProbeRunStatus> {
  const last = new Map<string, ProbeRunStatus>();
  for (const r of records) last.set(r.rule, r.status);
  return last;
}
