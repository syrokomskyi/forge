/*
<MODULE_CONTRACT>
<purpose>friction.validate command handler (RFC-1433, RFC-1590) — validates
the friction registry loaded through os/friction/store.ts: per-record
files under docs/frictions/ plus the legacy single-file registry while it
exists. FRICTION-01 entry shape + id format/uniqueness + filename-id
mismatch (fail), FRICTION-02 closed category catalog (fail), FRICTION-03
status enum + addressed-requires-artifacts (fail), FRICTION-04
lastSeen >= created + recurrences >= 0 (fail), FRICTION-05 signature
non-empty/lowercase-normalized + artifact path existence (warn),
FRICTION-06 docs-only recurrence blocks (fail), FRICTION-07 measureKind
classification debt (warn), FRICTION-08 escalated needs an obligation
token (fail), FRICTION-09 id in both the directory and the legacy file
(fail), FRICTION-10 unmigrated legacy file with records (warn, names
friction.migrate), FRICTION-11 any field value outside its declared
vocabulary (fail, names field+value+closed set — RFC-1601). An absent
registry is not an error — records are created by friction.add.</purpose>
<non-goals>
  <item>Do not mutate the registry — read-only validation.</item>
  <item>Do not match frictions or compute recurrences — that is the retro
  skill's job; this command only checks registry integrity.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1433: r3 polish — measure min(1), consistent entries reporting

F3-1: measure empty-string hole closed at shape level — absent or empty
measure both fail FRICTION-01, matching the session/friction siblings.
F3-2: pretty output reports reportedEntries (raw count on schema failure),
consistent with the JSON payload. r3 review verdict: pass.</item>
  <item>RFC-1460: recurring frictions escalate to mechanical measures — FRICTION-06/07/08, registry flips, session-retro escalation</item>
  <item>RFC-1460: address review r1 findings — F-0007 obligation token, escalated-match autopsy branch, FRICTION-08 path-shape + governance-doc inference</item>
  <item>RFC-1590: per-record store — loadFrictionSources replaces the
  single-file read; FRICTION-09 cross-store duplicate ids, FRICTION-10
  unmigrated-legacy warning, filename/id mismatch under FRICTION-01.</item>
  <item>RFC-1601: ledger writers assign + refusals teach the violated rule (RFC-1601)

FRICTION-11 flags any out-of-vocabulary friction field value at validate, naming field+value+closed set — the mechanical detector for hand-edit corruption (F-0206/F-0244). queue.decision is the new decision-ledger writer: schema-gated append stamping createdAt/answeredAt, next-free Q-id default, QUEUE-05/QUEUE-DEC-01 refusals carrying the minimal shape. ecosystem.commit --rfc/--adr normalize bare digits or refuse EC-35 with the format statement — the F-0248 silent-injection-skip class is closed, and a summary-record failure now names the id + skipped injection. RFC-IMP-10 refusal leads with the rule statement; pipeline conventions and guides point at the command write path.</item>
  <history>RFC-1433</history>
</CHANGE_SUMMARY>
*/

import path from "node:path";

import { ambientIo as fs } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { frictionEntrySchema } from "../types.ts";
import { FRICTION_CATEGORIES, FRICTION_MEASURE_KINDS, FRICTION_STATUSES } from "../types.ts";
import { FRICTION_DIR, crossStoreDuplicates, loadFrictionSources } from "../store.ts";
import type { FrictionSourceRecord } from "../store.ts";
import type {
  FrictionEntry,
  FrictionRuleId,
  FrictionValidateResult,
  FrictionViolation,
} from "../types.ts";

function violation(
  rule: FrictionRuleId,
  severity: "error" | "warning",
  message: string,
  entry?: string,
): FrictionViolation {
  return { rule, severity, message, ...(entry ? { entry } : {}) };
}

/** Map a single-record zod issue's field path to the spec's rule. */
function schemaIssueRule(issue: { path: PropertyKey[]; code: string }): FrictionRuleId {
  const field = issue.path[0];
  if (field === "category") return "FRICTION-02";
  if (field === "status") return "FRICTION-03";
  // recurrences < 0 is the spec's FRICTION-04 check surfacing through the
  // schema's min(0); other recurrences type issues are entry-shape (01).
  if (field === "recurrences" && issue.code === "too_small") return "FRICTION-04";
  return "FRICTION-01";
}

/** Best-effort entry id for a schema issue — the record's own id field. */
function schemaIssueEntry(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const id = (raw as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/** Artifact refs that name files (contain a path separator) must resolve. */
function isPathLikeArtifact(ref: string): boolean {
  return ref.includes("/");
}

// RFC-1460: measure classes whose effect a recurrence counter can disprove.
const DOCS_ONLY_KINDS = new Set(["docs-rule", "skill-step"]);
const DOCS_ARTIFACT_PATTERN = /(?:^|\/)(AGENTS\.md|SKILL\.md)$|\.md$/i;
// Governance-doc artifacts (docs/rfcs/**, docs/adrs/**) record landed mechanisms,
// not prose rules — they never resolve an entry to docs-only.
const GOVERNANCE_DOC_ARTIFACT_PATTERN = /^docs\/(rfcs|adrs)\//;
// FRICTION-08 "names a mechanical obligation" — RFC/ADR id, queue item,
// repo-relative path (known top dir or extension-bearing last segment —
// bare "and/or"-style prose does not count), or a backticked x.y command token.
const MECHANICAL_TOKEN_PATTERN =
  /RFC-\d{4}|ADR-\d{4}|docs\/queues\/|`[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+`|(?:packages|apps|services|docs|tools|missions|systems|src|spec)\/[\w./-]+|[\w-]+(?:\/[\w.-]+)+\.[a-z0-9]{1,5}\b/;

/**
 * Resolved measure class for FRICTION-06 — the strongest declared artifact
 * wins on mixed sets, so an entry is docs-only only when every artifact is
 * prose (AGENTS.md/SKILL.md/docs markdown). Empty artifact sets resolve null.
 */
function inferDocsOnly(entry: FrictionEntry): boolean {
  return (
    entry.artifacts.length > 0 &&
    entry.artifacts.every(
      (ref) => DOCS_ARTIFACT_PATTERN.test(ref) && !GOVERNANCE_DOC_ARTIFACT_PATTERN.test(ref),
    )
  );
}

function resolvedMeasureKind(entry: FrictionEntry): "docs-rule" | "mechanical" | null {
  if (entry.measureKind !== undefined) {
    return DOCS_ONLY_KINDS.has(entry.measureKind) ? "docs-rule" : "mechanical";
  }
  return inferDocsOnly(entry) ? "docs-rule" : null;
}

function effectiveId(rec: FrictionSourceRecord): string | null {
  return rec.id ?? rec.fileId;
}

// RFC-1601 FRICTION-11: enum-typed fields and their closed vocabularies. A
// value outside the declared set — a hand edit's concatenated token is the
// recorded case — is an error naming field, value, and the closed vocabulary.
const VOCABULARY_FIELDS: ReadonlyArray<{ field: string; vocab: readonly string[] }> = [
  { field: "category", vocab: FRICTION_CATEGORIES },
  { field: "status", vocab: FRICTION_STATUSES },
  { field: "measureKind", vocab: FRICTION_MEASURE_KINDS },
];

export async function runFrictionValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FrictionValidateResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const violations: FrictionViolation[] = [];

  const sources = await loadFrictionSources(workspaceRoot, fs);
  const all = [...sources.dir, ...sources.legacy];
  const entries: FrictionEntry[] = [];

  // FRICTION-10: an unmigrated legacy file with records warns — the
  // migrator is one command away.
  const legacyRecordCount = sources.legacy.filter((r) => r.raw !== undefined).length;
  if (legacyRecordCount > 0) {
    violations.push(
      violation(
        "FRICTION-10",
        "warning",
        `legacy single-file registry holds ${legacyRecordCount} record(s) — run friction.migrate to split it into per-record files`,
      ),
    );
  }

  // FRICTION-09: an id in both the directory and the legacy file —
  // post-migration residue the loader refuses outright.
  for (const id of crossStoreDuplicates(sources)) {
    violations.push(
      violation(
        "FRICTION-09",
        "error",
        `friction id ${id} exists in both ${FRICTION_DIR}/ and the legacy registry — remove the legacy copy (or delete the record file) and re-validate`,
        id,
      ),
    );
  }

  // Unparseable surfaces — one FRICTION-01 per failed file/section.
  for (const rec of all) {
    if (rec.parseError !== undefined) {
      violations.push(
        violation("FRICTION-01", "error", `${rec.file ?? "legacy registry"}: ${rec.parseError}`),
      );
    }
  }

  // Per-record schema + filename-id agreement.
  for (const rec of all) {
    if (rec.parseError !== undefined) continue;
    // FRICTION-01: a record file whose name and id disagree is a rename
    // accident waiting to collide with the reservation scan.
    if (rec.source === "dir" && rec.fileId !== null && rec.id !== null && rec.id !== rec.fileId) {
      violations.push(
        violation(
          "FRICTION-01",
          "error",
          `record file ${rec.file} holds id ${rec.id} — the file name must match the record id`,
          rec.id,
        ),
      );
    }
    // FRICTION-11: present field values must be members of their closed
    // vocabulary — checked on the raw record so a hand-edited token reports
    // field + value + vocabulary instead of a bare schema complaint.
    if (typeof rec.raw === "object" && rec.raw !== null) {
      const raw = rec.raw as Record<string, unknown>;
      for (const { field, vocab } of VOCABULARY_FIELDS) {
        const value = raw[field];
        if (value !== undefined && !vocab.includes(String(value))) {
          violations.push(
            violation(
              "FRICTION-11",
              "error",
              `field "${field}" holds out-of-vocabulary value "${String(value)}" — ${field} must be one of ${vocab.join("|")}`,
              effectiveId(rec) ?? undefined,
            ),
          );
        }
      }
    }
    const parsed = frictionEntrySchema.safeParse(rec.raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const fieldPath = issue.path.join(".") || "<root>";
        violations.push(
          violation(
            schemaIssueRule(issue),
            "error",
            `Registry violation at ${fieldPath}: ${issue.message}`,
            schemaIssueEntry(rec.raw),
          ),
        );
      }
    } else {
      entries.push(parsed.data);
    }
  }

  // FRICTION-01: ids unique within each surface (cross-surface is 09).
  const withinDup = (recs: FrictionSourceRecord[]) => {
    const seen = new Map<string, number>();
    for (const rec of recs) {
      const id = effectiveId(rec);
      if (id === null) continue;
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    return [...seen].filter(([, count]) => count > 1).map(([id]) => id);
  };
  for (const id of [...withinDup(sources.dir), ...withinDup(sources.legacy)]) {
    violations.push(
      violation(
        "FRICTION-01",
        "error",
        `Duplicate friction id "${id}" appears in the same surface — concurrent append collision? Renumber to the next free id and re-validate`,
        id,
      ),
    );
  }

  for (const entry of entries) {
    // FRICTION-03: addressed entries must link their prevention artifacts.
    if (entry.status === "addressed" && entry.artifacts.length === 0) {
      violations.push(
        violation(
          "FRICTION-03",
          "error",
          `Entry ${entry.id} is addressed but carries no artifacts — link the document or file that holds the prevention`,
          entry.id,
        ),
      );
    }

    // FRICTION-04: date ordering — unconditional per the spec table.
    if (entry.lastSeen < entry.created) {
      violations.push(
        violation(
          "FRICTION-04",
          "error",
          `Entry ${entry.id} lastSeen (${entry.lastSeen}) predates created (${entry.created})`,
          entry.id,
        ),
      );
    }

    // FRICTION-05: signature hygiene (warn — degrades matching, not integrity).
    if (entry.signature.trim().length === 0) {
      violations.push(
        violation(
          "FRICTION-05",
          "warning",
          `Entry ${entry.id} has an empty signature — recurrence matching cannot find it`,
          entry.id,
        ),
      );
    } else if (entry.signature !== entry.signature.toLowerCase()) {
      violations.push(
        violation(
          "FRICTION-05",
          "warning",
          `Entry ${entry.id} signature is not lowercase-normalized: "${entry.signature}"`,
          entry.id,
        ),
      );
    }

    // RFC-1460 FRICTION-06/07/08 — escalation contract on recurring signatures.
    if (entry.status === "addressed") {
      const kind = resolvedMeasureKind(entry);
      if (kind === "docs-rule" && entry.recurrences >= 2) {
        violations.push(
          violation(
            "FRICTION-06",
            "error",
            `Entry ${entry.id} is addressed on a docs-only measure yet its signature recurred ${entry.recurrences} times — the documented rule did not bind. Flip to status: escalated and name the mechanical obligation: "${entry.signature}"`,
            entry.id,
          ),
        );
      }
      if (entry.measureKind === undefined) {
        violations.push(
          violation(
            "FRICTION-07",
            "warning",
            `Entry ${entry.id} is addressed but carries no measureKind — classification debt, declare the measure's class`,
            entry.id,
          ),
        );
      }
    }
    if (entry.status === "escalated" && !MECHANICAL_TOKEN_PATTERN.test(entry.measure)) {
      violations.push(
        violation(
          "FRICTION-08",
          "error",
          `Entry ${entry.id} is escalated but its measure names no mechanical obligation — an RFC/ADR id, a docs/queues item, a repo-relative path, or a backticked command token is required`,
          entry.id,
        ),
      );
    }

    // FRICTION-05: populated artifact refs that name files must resolve.
    for (const ref of entry.artifacts) {
      if (isPathLikeArtifact(ref) && !(await fs.exists(path.join(workspaceRoot, ref)))) {
        violations.push(
          violation(
            "FRICTION-05",
            "warning",
            `Entry ${entry.id} artifact path does not exist: ${ref}`,
            entry.id,
          ),
        );
      }
    }
  }

  const errors: Diagnostic[] = violations
    .filter((v) => v.severity === "error")
    .map((v) => ({
      ruleId: v.rule,
      severity: "error",
      message: v.message,
      file: FRICTION_DIR,
    }));
  const warnings: Diagnostic[] = violations
    .filter((v) => v.severity === "warning")
    .map((v) => ({
      ruleId: v.rule,
      severity: "warning",
      message: v.message,
      file: FRICTION_DIR,
    }));
  const status = errors.length === 0 ? "pass" : "fail";

  const rawEntryCount = all.filter((r) => r.raw !== undefined).length;
  // r3 contract: report the raw count when any record failed to parse —
  // the honest registry size, not the surviving subset.
  const reportedEntries =
    entries.length === all.filter((r) => r.parseError === undefined).length
      ? entries.length
      : rawEntryCount;
  const absent = sources.dir.length === 0 && !sources.legacyPresent;

  if (outputFormat === "pretty") {
    logger.section("Friction registry");
    logger.info(
      absent
        ? `  registry absent — lazily created, treated as empty`
        : `  ${reportedEntries} entr${reportedEntries === 1 ? "y" : "ies"}` +
            (sources.legacy.length > 0 ? ` (legacy file: ${sources.legacy.length})` : ""),
    );
    for (const w of warnings) logger.warn(`  ${w.ruleId}: ${w.message}`);
    for (const e of errors) logger.error(`  ${e.ruleId}: ${e.message}`);
  }

  return {
    data: {
      command: "friction.validate",
      status,
      registry: FRICTION_DIR,
      entries: reportedEntries,
      violations,
      errors,
      warnings,
    },
    summary:
      status === "pass"
        ? `friction.validate: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${absent ? " (registry absent)" : ""}`
        : `Friction registry invalid: ${errors.length} error(s)`,
    exitCode: status === "pass" ? 0 : 1,
  };
}
