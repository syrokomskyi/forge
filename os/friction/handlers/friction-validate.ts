/*
<MODULE_CONTRACT>
<purpose>friction.validate command handler (RFC-1433) — validates the
append-only friction registry at docs/frictions.yaml. FRICTION-01 fails on
unreadable/unparseable/schema-broken files; FRICTION-02 on malformed or
duplicate ids; FRICTION-03 on out-of-enum category/status (folded into the
schema check); FRICTION-04/05 warn on hygiene issues (missing measure on open
entries, addressed without artifacts, lastSeen before created). An absent
registry is not an error — lazily created means absent equals empty.</purpose>
<non-goals>
  <item>Do not mutate the registry file — read-only validation.</item>
  <item>Do not match frictions or compute recurrences — that is the retro
  skill's job; this command only checks registry integrity.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1433: initial validator — five rules over the append-only
  registry, ENOENT passes with entries: 0 per the lazy-creation contract.</item>
  <item>RFC-1433: os/friction module, friction.validate, retro autopsy + RFC fast-path

Add friction.validate (FRICTION-01..05, contract frictions) over the
append-only docs/frictions.yaml registry; absent file passes with
entries: 0 per lazy-creation contract. fo-session-retro gains the
autopsy step (signal checklist, signature matching, harvest mode +
triggerPhrases) and fo-idea-create-rfc the friction fast-path. Module
registered in bin/cli.ts, WORKSHOP_MODULE_MAP.forge, package.json
exports; AGENTS.md module row; 13 vitest cases.</item>
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
import type { FrictionEntry, FrictionValidateResult } from "../types.ts";

const REGISTRY_PATH = "docs/frictions.yaml";

function diag(
  ruleId: string,
  severity: "error" | "warning",
  message: string,
  file?: string,
): Diagnostic {
  return { ruleId, severity, message, file };
}

export async function runFrictionValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FrictionValidateResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];

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
      errors.push(
        diag(
          "FRICTION-01",
          "error",
          `Cannot read ${REGISTRY_PATH}: ${e instanceof Error ? e.message : String(e)}`,
          REGISTRY_PATH,
        ),
      );
    }
  }

  let raw: unknown = null;
  if (source !== null) {
    try {
      raw = YAML.parse(source);
    } catch (e) {
      errors.push(
        diag(
          "FRICTION-01",
          "error",
          `YAML parse error in ${REGISTRY_PATH}: ${e instanceof Error ? e.message : String(e)}`,
          REGISTRY_PATH,
        ),
      );
    }
  }

  if (source !== null && errors.length === 0) {
    // FRICTION-03: category/status are enum-checked by the schema — a
    // schema failure reports the offending path so the agent sees which
    // enum or field broke.
    const parsed = frictionsRegistrySchema.safeParse(raw ?? []);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.join(".") || "<root>";
        errors.push(
          diag(
            issue.path.length >= 2 && (issue.path[1] === "category" || issue.path[1] === "status")
              ? "FRICTION-03"
              : "FRICTION-01",
            "error",
            `Registry schema violation at ${field}: ${issue.message}`,
            REGISTRY_PATH,
          ),
        );
      }
    } else {
      entries = parsed.data;

      // FRICTION-02: ids unique + well-formed (the regex half lives in the
      // schema; duplicates need the whole list).
      const seen = new Map<string, number>();
      for (const entry of entries) {
        seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1);
      }
      for (const [id, count] of seen) {
        if (count > 1) {
          errors.push(
            diag(
              "FRICTION-02",
              "error",
              `Duplicate friction id "${id}" appears ${count} times — concurrent append collision? Renumber to the next free id and re-validate`,
              REGISTRY_PATH,
            ),
          );
        }
      }

      // FRICTION-04/05: hygiene warnings — the registry still validates,
      // but stale or incomplete entries degrade the harvest.
      for (const entry of entries) {
        if (entry.status === "open" && entry.measure.trim().length === 0) {
          warnings.push(
            diag(
              "FRICTION-04",
              "warning",
              `Entry ${entry.id} is open but carries no measure — a friction without a proposed prevention cannot be harvested`,
              REGISTRY_PATH,
            ),
          );
        }
        if (entry.status === "addressed" && entry.artifacts.length === 0) {
          warnings.push(
            diag(
              "FRICTION-05",
              "warning",
              `Entry ${entry.id} is addressed but has no artifacts — link the document or file that carries the prevention`,
              REGISTRY_PATH,
            ),
          );
        }
        if (entry.recurrences > 0 && entry.lastSeen < entry.created) {
          warnings.push(
            diag(
              "FRICTION-05",
              "warning",
              `Entry ${entry.id} has recurrences but lastSeen (${entry.lastSeen}) predates created (${entry.created})`,
              REGISTRY_PATH,
            ),
          );
        }
      }
    }
  }

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
      file: REGISTRY_PATH,
      entries: entries.length,
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
