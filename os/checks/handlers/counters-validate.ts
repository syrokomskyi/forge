/*
<MODULE_CONTRACT>
<purpose>RFC-1474: checks.counters.validate — counters-journal integrity gate.
COUNT-01 (error): a record's ruleId resolves to no inventory rule — journal
drifted from the rule universe; malformed middle lines are the same
unresolvable class. COUNT-02 (error): `at` append order is non-monotonic —
readers can no longer take the tail as latest. A crash-truncated final
record is tolerated (dropped, still surfaced as truncatedTail in data).
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1474: checks.counters.validate — COUNT-01 unknown-rule/malformed + COUNT-02 non-monotonic gates</item>
  <item>RFC-1474: per-rule check-execution counters

Append-only counters.jsonl journaled per evaluated rule ({runId, ruleId, contract, outcome, at}; runId = commandInvocationId; outcomes pass|diagnostic|skipped|ensured; dry-run suppressed; append failures warn never fail). checks.counters.validate audits the journal against the validator inventory (COUNT-01/02); checks.counters.export projects deterministic per-rule totals (COUNT-03, generatedAt = max journal at; producer-tail tolerated). checks.contribution.report joins counters as the canonical firing source (CONTRIB-03 on absent/empty journal; coverage none|partial|complete; live effectiveCoverage positive). Validator inventory now includes every rules[]-declaring command — fail-closed gate surfaced 9 contract-declaration defects, fixed with domain contracts.</item>
  <item>RFC-1474: check-execution counters — apply re-review findings (structural skip flag, violations extraction, Date.parse ordering, DEV-5/6)</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { readCountersJournal } from "./counters-journal.ts";

const INVENTORY_PATH = "docs/validator-inventory.generated.yaml";

export interface CountersValidateData {
  command: "checks.counters.validate";
  status: "ok";
  records: number;
  malformedLines: number;
  truncatedTail: boolean;
  diagnostics: Diagnostic[];
}

export async function runCountersValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<CountersValidateData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const diagnostics: Diagnostic[] = [];

  const { records, malformedLines, truncatedTail } = await readCountersJournal(root);

  for (let i = 0; i < malformedLines; i++) {
    diagnostics.push({
      ruleId: "COUNT-01",
      severity: "error",
      message: `malformed journal record (unparseable non-tail line) — counters journal drifted from the record schema`,
      file: "docs/.index/checks/counters.jsonl",
    });
  }

  const invSrc = await io.readFile(path.join(root, INVENTORY_PATH)).catch(() => null);
  let inventoryIds: Set<string> | undefined;
  if (invSrc === null) {
    if (records.length > 0) {
      diagnostics.push({
        ruleId: "COUNT-01",
        severity: "error",
        message: `${INVENTORY_PATH} missing — rule universe unavailable, ${records.length} journal record(s) cannot resolve`,
      });
    }
  } else {
    const parsed = yamlParse(invSrc) as {
      contracts?: { contract?: string; validators?: { rules?: { id?: string }[] }[] }[];
    } | null;
    inventoryIds = new Set(
      (parsed?.contracts ?? []).flatMap((c) =>
        (c.validators ?? []).flatMap((v) => (v.rules ?? []).map((r) => `${c.contract}/${r.id}`)),
      ),
    );
    records.forEach((r, i) => {
      if (!inventoryIds!.has(r.ruleId)) {
        diagnostics.push({
          ruleId: "COUNT-01",
          severity: "error",
          message: `journal record ${i} ruleId "${r.ruleId}" resolves to no inventory rule — journal drifted from the rule universe`,
          file: "docs/.index/checks/counters.jsonl",
        });
      } else if (!r.ruleId.startsWith(`${r.contract}/`)) {
        diagnostics.push({
          ruleId: "COUNT-01",
          severity: "error",
          message: `journal record ${i} ruleId "${r.ruleId}" disagrees with its contract "${r.contract}"`,
          file: "docs/.index/checks/counters.jsonl",
        });
      }
    });
  }

  let prevAt = "";
  let prevAtMs = Number.NEGATIVE_INFINITY;
  records.forEach((r, i) => {
    const atMs = Date.parse(r.at);
    // Numeric ordering, not lexical — z.datetime() admits second-precision
    // ISO whose string sort would misorder against millisecond stamps.
    if (prevAt !== "" && atMs < prevAtMs) {
      diagnostics.push({
        ruleId: "COUNT-02",
        severity: "error",
        message: `journal record ${i} at "${r.at}" precedes record ${i - 1} at "${prevAt}" — append order is non-monotonic`,
        file: "docs/.index/checks/counters.jsonl",
      });
    }
    if (atMs > prevAtMs) {
      prevAtMs = atMs;
      prevAt = r.at;
    }
  });

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return {
    data: {
      command: "checks.counters.validate",
      status: "ok",
      records: records.length,
      malformedLines,
      truncatedTail,
      diagnostics,
    },
    summary:
      diagnostics.length === 0
        ? `${records.length} journal record(s) — integrity clean`
        : `${diagnostics.length} counter(s) violation(s): ${errors} error`,
    exitCode: errors > 0 ? 1 : 0,
  };
}
