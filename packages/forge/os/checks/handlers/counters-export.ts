/*
<MODULE_CONTRACT>
<purpose>RFC-1474: checks.counters.export — projects the append-only counters
journal (docs/.index/checks/counters.jsonl) into the deterministic committed
artifact docs/metrics/check-counters.generated.yaml. Per-rule totals:
evaluated (pass|diagnostic|ensured — skipped never counts), diagnostic,
lastRunId, lastAt. generatedAt derives from the max journal `at`, never
wall-clock. --check diffs the computed artifact against the committed file
(COUNT-03 staleness, same freshness contract as other generated artifacts).
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1474: checks.counters.export — deterministic journal projection + COUNT-03 --check gate</item>
  <item>RFC-1474: per-rule check-execution counters

Append-only counters.jsonl journaled per evaluated rule ({runId, ruleId, contract, outcome, at}; runId = commandInvocationId; outcomes pass|diagnostic|skipped|ensured; dry-run suppressed; append failures warn never fail). checks.counters.validate audits the journal against the validator inventory (COUNT-01/02); checks.counters.export projects deterministic per-rule totals (COUNT-03, generatedAt = max journal at; producer-tail tolerated). checks.contribution.report joins counters as the canonical firing source (CONTRIB-03 on absent/empty journal; coverage none|partial|complete; live effectiveCoverage positive). Validator inventory now includes every rules[]-declaring command — fail-closed gate surfaced 9 contract-declaration defects, fixed with domain contracts.</item>
  <item>RFC-1474: check-execution counters — apply re-review findings (structural skip flag, violations extraction, Date.parse ordering, DEV-5/6)</item>
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
    const committedAt =
      committed === null
        ? ""
        : ((yamlParse(committed) as { generatedAt?: string } | null)?.generatedAt ?? "");
    const covered = recordsCoveredByArtifact(records, committedAt, PRODUCER_RUN_PREFIX);
    const expected = yamlStringify(computeArtifact(covered)) + "\n";
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

  await io.mkdir(path.dirname(path.join(root, outRel))).catch(() => {});
  await io.writeFile(path.join(root, outRel), serialized);
  return {
    data,
    summary: `${artifact.rules.length} rule(s) across ${artifact.runCount} run(s) → ${outRel}`,
    exitCode: 0,
  };
}
