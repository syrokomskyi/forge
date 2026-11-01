/*
<MODULE_CONTRACT>
<purpose>RFC-1474: per-rule check-execution counters journal — the append-only
JSONL record of every rule evaluation at docs/.index/checks/counters.jsonl
({runId, ruleId, contract, outcome, at} per evaluated rule). The kernel
executor, pipeline scheduler, and ensure-runner write through
recordRuleEvaluations (node:fs appendFile — never the WorkspaceIO adapter,
never read-modify-write); readers (checks.counters.export/validate,
checks.contribution.report) tolerate a crash-truncated tail record via
readCountersJournal.</purpose>
<non-goals>
  <item>Journal rotation/compaction — out of scope for wave 1 (the file is gitignored and reconstructable).</item>
  <item>Diagnostic-signature history — that stays with the session-audit sidecars; the journal carries firing only.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>ruleId is the inventory-namespaced form (contract + "/" + rule id) — the contribution report's join key; contract comes from the command's registered contract, never its name.</item>
  <item>File order is canonical; `at` is informational and non-decreasing within a run (COUNT-02 reads append order).</item>
  <item>Append failures return a warning string, never throw — telemetry must never break the gate it observes.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1474: counters journal — append-only JSONL writer, tolerant reader, per-rule outcome computation</item>
  <item>RFC-1474: per-rule check-execution counters

Append-only counters.jsonl journaled per evaluated rule ({runId, ruleId, contract, outcome, at}; runId = commandInvocationId; outcomes pass|diagnostic|skipped|ensured; dry-run suppressed; append failures warn never fail). checks.counters.validate audits the journal against the validator inventory (COUNT-01/02); checks.counters.export projects deterministic per-rule totals (COUNT-03, generatedAt = max journal at; producer-tail tolerated). checks.contribution.report joins counters as the canonical firing source (CONTRIB-03 on absent/empty journal; coverage none|partial|complete; live effectiveCoverage positive). Validator inventory now includes every rules[]-declaring command — fail-closed gate surfaced 9 contract-declaration defects, fixed with domain contracts.</item>
  <item>RFC-1474: check-execution counters — apply review findings (F-1..F-9)</item>
  <item>RFC-1474: check-execution counters — apply re-review findings (structural skip flag, violations extraction, Date.parse ordering, DEV-5/6)</item>
</CHANGE_SUMMARY>
*/

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

/** Repo-relative journal path (gitignored — inherits the docs/.index/ ignore). */
export const COUNTERS_JOURNAL_PATH = "docs/.index/checks/counters.jsonl";

export const CHECK_COUNTER_OUTCOMES = ["pass", "diagnostic", "skipped", "ensured"] as const;
export type CheckCounterOutcome = (typeof CHECK_COUNTER_OUTCOMES)[number];

export const checkCounterRecordSchema = z
  .object({
    /** Executor commandInvocationId — groups every record one run emitted. */
    runId: z.string().min(1),
    /** Inventory-namespaced rule id: `<contract>/<ruleId>`. */
    ruleId: z.string().min(1),
    /** The command's registered contract (never the command name). */
    contract: z.string().min(1),
    outcome: z.enum(CHECK_COUNTER_OUTCOMES),
    /** ISO-8601 evaluation timestamp — informational; file order is canonical. */
    at: z.string().datetime(),
  })
  .strict();
export type CheckCounterRecord = z.infer<typeof checkCounterRecordSchema>;

/**
 * Appends one JSONL line per record via node:fs appendFile. Returns a warning
 * string on failure and never throws — a broken journal must not break the
 * command it observes. An empty record set is a no-op.
 */
export async function recordRuleEvaluations(
  workspaceRoot: string,
  records: readonly CheckCounterRecord[],
): Promise<string | undefined> {
  if (records.length === 0) return undefined;
  const file = join(workspaceRoot, COUNTERS_JOURNAL_PATH);
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    return undefined;
  } catch (error) {
    return `counters journal append failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface CountersJournalRead {
  records: CheckCounterRecord[];
  /** Lines that failed JSON or schema parsing — COUNT-01 surface. */
  malformedLines: number;
  /** The final line was a partial (crash-truncated) record — dropped, not fatal. */
  truncatedTail: boolean;
}

/**
 * Tolerant reader: absent file → empty; each line parses against the strict
 * record schema; a JSON-parse failure on the FINAL line counts as a
 * crash-truncated tail (dropped silently), everything else unparseable —
 * including a schema-invalid tail — counts as malformed. Read errors other
 * than ENOENT propagate: an integrity gate must not green on a journal it
 * could not read.
 */
export async function readCountersJournal(workspaceRoot: string): Promise<CountersJournalRead> {
  let src: string;
  try {
    src = await readFile(join(workspaceRoot, COUNTERS_JOURNAL_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], malformedLines: 0, truncatedTail: false };
    }
    throw error;
  }
  if (src === "") return { records: [], malformedLines: 0, truncatedTail: false };
  const lines = src.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const records: CheckCounterRecord[] = [];
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
    const validated = jsonFailed ? undefined : checkCounterRecordSchema.safeParse(parsed);
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
 * RFC-1474: artifact-freshness projection scope. A metrics artifact derived
 * from the journal can never contain its own producing run's records — they
 * land after the artifact is written — so a `--check` recompute must exclude
 * tail records belonging to the producing command's run family. Earlier
 * producer records at-or-before `generatedAt` and ALL non-producer growth
 * stay in the diff, so real journal drift still gates staleness while the
 * structurally unavoidable self-tail does not pin the check red forever.
 */
export function recordsCoveredByArtifact(
  records: readonly CheckCounterRecord[],
  generatedAt: string,
  producerRunIdPrefix: string,
): CheckCounterRecord[] {
  const generatedAtMs = Date.parse(generatedAt);
  // Numeric comparison — a "no-data"/absent stamp parses to NaN, so every
  // record counts uncovered (real journal growth flags stale), never the
  // accidental lexical pass `"2026-…" <= "no-data"`.
  return records.filter(
    (r) => Date.parse(r.at) <= generatedAtMs || !r.runId.startsWith(producerRunIdPrefix),
  );
}

/**
 * Maps a command's declared rules[] to one journal record each: `diagnostic`
 * when a result diagnostic carries that rule id (bare or namespaced), `pass`
 * otherwise. `outcome` forces a single outcome across the set — the ensure
 * runner (`ensured`) and scheduler (`skipped`) producers.
 */
export function computeRunOutcomes(options: {
  runId: string;
  contract: string;
  rules: readonly ({ id?: string } | string)[] | undefined;
  diagnosticRuleIds: ReadonlySet<string>;
  outcome?: CheckCounterOutcome;
  at: string;
}): CheckCounterRecord[] {
  const { runId, contract, rules, diagnosticRuleIds, outcome, at } = options;
  return (rules ?? []).flatMap((rule) => {
    const id = typeof rule === "string" ? rule : rule.id;
    if (!id) return [];
    const namespaced = `${contract}/${id}`;
    const resolved =
      outcome ?? (diagnosticRuleIds.has(id) || diagnosticRuleIds.has(namespaced) ? "diagnostic" : "pass");
    return [{ runId, ruleId: namespaced, contract, outcome: resolved, at }];
  });
}
