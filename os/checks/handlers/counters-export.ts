/*
<MODULE_CONTRACT>
<purpose>RFC-1474: checks.counters.export — projects the append-only counters
journal (docs/.index/checks/counters.jsonl) into the deterministic committed
artifact docs/metrics/check-counters.generated.yaml. Per-rule totals:
evaluated (pass|diagnostic|ensured — skipped never counts), diagnostic,
lastRunId, lastAt. generatedAt derives from the max journal `at`, never
wall-clock. F-0290: writes UNION with the existing committed artifact as a
per-rule high-water mark (evaluated/diagnostic/runCount take the max,
lastRunId/lastAt track the latest `at`) — the committed file is the
cross-worktree union of every session's exports, so a thin worktree journal
never shrinks committed diagnostic evidence. --check diffs
merge(committed, covered-projection) against the committed file (COUNT-03
staleness, same freshness contract as other generated artifacts).
</purpose>
<non-goals>
  <item>Never mutate the counters journal — export is a read-only projection into the committed artifact.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1474: checks.counters.export — deterministic journal projection + COUNT-03 --check gate</item>
  <item>RFC-1474: per-rule check-execution counters

Append-only counters.jsonl journaled per evaluated rule ({runId, ruleId, contract, outcome, at}; runId = commandInvocationId; outcomes pass|diagnostic|skipped|ensured; dry-run suppressed; append failures warn never fail). checks.counters.validate audits the journal against the validator inventory (COUNT-01/02); checks.counters.export projects deterministic per-rule totals (COUNT-03, generatedAt = max journal at; producer-tail tolerated). checks.contribution.report joins counters as the canonical firing source (CONTRIB-03 on absent/empty journal; coverage none|partial|complete; live effectiveCoverage positive). Validator inventory now includes every rules[]-declaring command — fail-closed gate surfaced 9 contract-declaration defects, fixed with domain contracts.</item>
  <item>RFC-1474: check-execution counters — apply re-review findings (structural skip flag, violations extraction, Date.parse ordering, DEV-5/6)</item>
  <item>RFC-1485: sweep compass headers — forge-os-checks</item>
  <item>RFC-1474: union-merge counters export over the committed artifact (F-0290)</item>
  <history>F-0290</history>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import {
  readCountersJournal,
  recordsCoveredByArtifact,
  type CheckCounterRecord,
} from "./counters-journal.ts";

const DEFAULT_OUT = "docs/metrics/check-counters.generated.yaml";
/** Producer run family — own-invocation tail records are excluded on --check. */
const PRODUCER_RUN_PREFIX = "checks.counters.export-";

export interface CounterRuleTotal {
  ruleId: string;
  contract: string;
  evaluated: number;
  diagnostic: number;
  lastRunId: string;
  lastAt: string;
}

export interface CountersExportData {
  command: "checks.counters.export";
  status: "ok";
  rules: CounterRuleTotal[];
  runCount: number;
  out: string;
  diagnostics?: Diagnostic[];
}

const countsAsEvaluated = (r: CheckCounterRecord) => r.outcome !== "skipped";

interface CountersArtifact {
  schema: "forge/check-counters@1";
  generatedAt: string;
  runCount: number;
  rules: CounterRuleTotal[];
}

function computeArtifact(records: readonly CheckCounterRecord[]): CountersArtifact {
  const runIds = new Set<string>();
  let generatedAt = "";
  let generatedAtMs = Number.NEGATIVE_INFINITY;
  const totals = new Map<string, CounterRuleTotal & { lastSeq: number }>();
  records.forEach((r, seq) => {
    runIds.add(r.runId);
    const atMs = Date.parse(r.at);
    if (atMs > generatedAtMs) {
      generatedAtMs = atMs;
      generatedAt = r.at;
    }
    const t = totals.get(r.ruleId) ?? {
      ruleId: r.ruleId,
      contract: r.contract,
      evaluated: 0,
      diagnostic: 0,
      lastRunId: "",
      lastAt: "",
      lastSeq: -1,
    };
    if (countsAsEvaluated(r)) {
      t.evaluated++;
      if (r.outcome === "diagnostic") t.diagnostic++;
    }
    if (seq > t.lastSeq) {
      t.lastSeq = seq;
      t.lastRunId = r.runId;
      t.lastAt = r.at;
    }
    totals.set(r.ruleId, t);
  });

  const rules = [...totals.values()]
    .map(({ lastSeq: _lastSeq, ...t }) => t)
    .sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));

  return {
    schema: "forge/check-counters@1",
    generatedAt: generatedAt || "no-data",
    runCount: runIds.size,
    rules,
  };
}

function parseCommittedArtifact(src: string | null): CountersArtifact | null {
  if (src === null) return null;
  const parsed = yamlParse(src) as CountersArtifact | null;
  if (parsed?.schema !== "forge/check-counters@1" || !Array.isArray(parsed.rules)) return null;
  return parsed;
}

function isoMax(a: string, b: string): string {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isNaN(aMs)) return b;
  if (Number.isNaN(bMs)) return a;
  return aMs >= bMs ? a : b;
}

/**
 * F-0290: high-water-mark union of a previously committed artifact with the
 * local journal projection. Per rule: evaluated/diagnostic take the per-rule
 * maximum, lastRunId/lastAt track the latest `at`; runCount and generatedAt
 * take the maximum too. The committed artifact is the cross-worktree union of
 * every session's exports — a thin worktree-local journal must never shrink
 * it (evidence loss regresses probe-ratchet liveness repo-wide). Max-union
 * keeps re-export idempotent: re-running over the same journal merges to the
 * same artifact instead of double-counting.
 */
function mergeArtifacts(base: CountersArtifact | null, delta: CountersArtifact): CountersArtifact {
  if (base === null) return delta;
  const merged = new Map<string, CounterRuleTotal>();
  for (const t of base.rules) merged.set(t.ruleId, { ...t });
  for (const t of delta.rules) {
    const cur = merged.get(t.ruleId);
    if (cur === undefined) {
      merged.set(t.ruleId, { ...t });
      continue;
    }
    cur.evaluated = Math.max(cur.evaluated, t.evaluated);
    cur.diagnostic = Math.max(cur.diagnostic, t.diagnostic);
    if (t.lastAt >= cur.lastAt) {
      cur.lastRunId = t.lastRunId;
      cur.lastAt = t.lastAt;
    }
  }
  return {
    schema: "forge/check-counters@1",
    generatedAt: isoMax(base.generatedAt, delta.generatedAt),
    runCount: Math.max(base.runCount, delta.runCount),
    rules: [...merged.values()].sort((a, b) =>
      a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0,
    ),
  };
}

export async function runCountersExport(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<CountersExportData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const check = input.flags["check"] === true;
  const outRel = (input.flags["out"] as string | undefined) ?? DEFAULT_OUT;

  const { records } = await readCountersJournal(root);
  const artifact = computeArtifact(records);
  const serialized = yamlStringify(artifact) + "\n";

  const data: CountersExportData = {
    command: "checks.counters.export",
    status: "ok",
    rules: artifact.rules,
    runCount: artifact.runCount,
    out: outRel,
  };

  if (check) {
    const committed = await io.readFile(path.join(root, outRel)).catch(() => null);
    // Recompute over the record set the committed artifact could have seen —
    // the producing run's own tail records are structurally unreachable.
    const committedAt = parseCommittedArtifact(committed)?.generatedAt ?? "";
    const covered = recordsCoveredByArtifact(records, committedAt, PRODUCER_RUN_PREFIX);
    // F-0290 merge semantics: fresh means the committed artifact already
    // covers the covered-projection — merge(committed, covered) === committed.
    // A committed file that never shrinks under re-export stays byte-stable;
    // genuine journal growth past it still diffs and flags COUNT-03.
    const parsed = parseCommittedArtifact(committed);
    const expected =
      parsed === null
        ? yamlStringify(computeArtifact(covered)) + "\n"
        : yamlStringify(mergeArtifacts(parsed, computeArtifact(covered))) + "\n";
    const stale = committed !== expected;
    data.diagnostics = stale
      ? [
          {
            ruleId: "COUNT-03",
            severity: "warning",
            message: `committed counters artifact is stale vs the journal tail — run checks.counters.export`,
            file: outRel,
          },
        ]
      : [];
    return {
      data,
      summary: stale
        ? `COUNT-03 ${outRel} is stale — run checks.counters.export`
        : "counters artifact fresh",
      exitCode: stale ? 1 : 0,
    };
  }

  const prior = parseCommittedArtifact(
    await io.readFile(path.join(root, outRel)).catch(() => null),
  );
  const out = prior === null ? serialized : yamlStringify(mergeArtifacts(prior, artifact)) + "\n";
  await io.mkdir(path.dirname(path.join(root, outRel))).catch(() => {});
  await io.writeFile(path.join(root, outRel), out);
  return {
    data,
    summary: `${artifact.rules.length} rule(s) across ${artifact.runCount} run(s) → ${outRel}`,
    exitCode: 0,
  };
}
