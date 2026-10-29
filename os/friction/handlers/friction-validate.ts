/*
<MODULE_CONTRACT>
<purpose>friction.validate command handler (RFC-1433) — validates the
append-only friction registry at docs/frictions.yaml against the spec's
failure-modes table: FRICTION-01 entry shape + id uniqueness/format (fail),
FRICTION-02 closed category catalog (fail), FRICTION-03 status enum +
addressed-requires-artifacts (fail), FRICTION-04 lastSeen >= created +
recurrences >= 0 (fail), FRICTION-05 signature non-empty/lowercase-normalized
+ artifact path existence (warn). An absent registry is not an error —
lazily created means absent equals empty.</purpose>
<non-goals>
  <item>Do not mutate the registry file — read-only validation.</item>
  <item>Do not match frictions or compute recurrences — that is the retro
  skill's job; this command only checks registry integrity.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1433: initial validator — five rules over the append-only
  registry, ENOENT passes with entries: 0 per the lazy-creation contract.</item>
  <item>RFC-1433: review realignment — rule ids remapped to the accepted
  spec table (dup id → 01, category → 02, addressed-without-artifacts → 03
  fail, lastSeen/recurrences → 04 fail unconditional, signature → 05 warn);
  output emits the documented violations[] shape.</item>
  <item>RFC-1433: r2 review — entries reports the raw entry count even when
  the schema parse fails (was: 0); rule ids typed as FrictionRuleId.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import YAML from "yaml";

import { ambientIo as fs } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { frictionsRegistrySchema } from "../types.ts";
import type {
  FrictionEntry,
  FrictionRuleId,
  FrictionValidateResult,
  FrictionViolation,
} from "../types.ts";

const REGISTRY_PATH = "docs/frictions.yaml";

function violation(
  rule: FrictionRuleId,
  severity: "error" | "warning",
  message: string,
  entry?: string,
): FrictionViolation {
  return { rule, severity, message, ...(entry ? { entry } : {}) };
}

/** Map a zod issue's field path to the rule the spec's failure-modes table assigns. */
function schemaIssueRule(issue: { path: PropertyKey[]; code: string }): FrictionRuleId {
  const field = issue.path[1];
  if (field === "category") return "FRICTION-02";
  if (field === "status") return "FRICTION-03";
  // recurrences < 0 is the spec's FRICTION-04 check surfacing through the
  // schema's min(0); other recurrences type issues are entry-shape (01).
  if (field === "recurrences" && issue.code === "too_small") return "FRICTION-04";
  return "FRICTION-01";
}

/** Best-effort entry id for a schema issue — raw list index → id when readable. */
function schemaIssueEntry(issue: { path: PropertyKey[] }, raw: unknown): string | undefined {
  const index = issue.path[0];
  if (typeof index !== "number" || !Array.isArray(raw)) return undefined;
  const candidate = raw[index];
  return candidate && typeof candidate === "object" && typeof candidate.id === "string"
    ? candidate.id
    : undefined;
}

/** Artifact refs that name files (contain a path separator) must resolve. */
function isPathLikeArtifact(ref: string): boolean {
  return ref.includes("/");
}

export async function runFrictionValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FrictionValidateResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const violations: FrictionViolation[] = [];

  const absolutePath = path.join(workspaceRoot, REGISTRY_PATH);
  let entries: FrictionEntry[] = [];
  let absent = false;

  let source: string | null = null;
  try {
    source = await fs.readFile(absolutePath);
  } catch (e) {
    // ENOENT only: the registry is created lazily — absent equals empty.
    // Other read errors (permissions, EISDIR) are FRICTION-01.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      absent = true;
    } else {
      violations.push(
        violation(
          "FRICTION-01",
          "error",
          `Cannot read ${REGISTRY_PATH}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  let raw: unknown = null;
  if (source !== null) {
    try {
      raw = YAML.parse(source);
    } catch (e) {
      violations.push(
        violation(
          "FRICTION-01",
          "error",
          `YAML parse error in ${REGISTRY_PATH}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  let rawEntryCount = 0;
  if (source !== null && violations.length === 0) {
    rawEntryCount = Array.isArray(raw) ? raw.length : 0;
    const parsed = frictionsRegistrySchema.safeParse(raw ?? []);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const fieldPath = issue.path.join(".") || "<root>";
        violations.push(
          violation(
            schemaIssueRule(issue),
            "error",
            `Registry violation at ${fieldPath}: ${issue.message}`,
            schemaIssueEntry(issue, raw),
          ),
        );
      }
    } else {
      entries = parsed.data;

      // FRICTION-01: ids unique (format lives in the schema's regex).
      const seen = new Map<string, number>();
      for (const entry of entries) {
        seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1);
      }
      for (const [id, count] of seen) {
        if (count > 1) {
          violations.push(
            violation(
              "FRICTION-01",
              "error",
              `Duplicate friction id "${id}" appears ${count} times — concurrent append collision? Renumber to the next free id and re-validate`,
              id,
            ),
          );
        }
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
    }
  }

  const errors: Diagnostic[] = violations
    .filter((v) => v.severity === "error")
    .map((v) => ({
      ruleId: v.rule,
      severity: "error",
      message: v.message,
      file: REGISTRY_PATH,
    }));
  const warnings: Diagnostic[] = violations
    .filter((v) => v.severity === "warning")
    .map((v) => ({
      ruleId: v.rule,
      severity: "warning",
      message: v.message,
      file: REGISTRY_PATH,
    }));
  const status = errors.length === 0 ? "pass" : "fail";

  if (outputFormat === "pretty") {
    logger.section("Friction registry");
    logger.info(
      absent
        ? `  ${REGISTRY_PATH} absent — lazily created, treated as empty`
        : `  ${REGISTRY_PATH}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
    );
    for (const w of warnings) logger.warn(`  ${w.ruleId}: ${w.message}`);
    for (const e of errors) logger.error(`  ${e.ruleId}: ${e.message}`);
  }

  return {
    data: {
      command: "friction.validate",
      status,
      registry: REGISTRY_PATH,
      entries: entries.length || rawEntryCount,
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
