/*
<MODULE_CONTRACT>
<purpose>RFC-1336: authority.delegation.validate — the registry's validator
(DNA-91 contract authority, rules DELEG-01..08). Absent registry is a clean
pass; schema violations and non-delegable scopes block; agent:* wildcards,
unknown sites, unknown scopes, and bad signatures warn.</purpose>
<non-goals>
  <item>Do not mutate the registry — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1336: initial handler — DELEG-01..08.</item>
  <item>RFC-1336: step 1: forge authority module — delegation registry schema + resolver, four authority.* commands, optional Ed25519 signing</item>
</CHANGE_SUMMARY>
*/

import YAML from "yaml";

import {
  DELEGATIONS_FILENAME,
  NON_DELEGABLE_SCOPES,
  authorityDelegationsSchema,
  canonicalDelegationPayload,
  delegationsPath,
  isDelegableScope,
} from "../../../src/authority/delegations.ts";
import { verifyDelegationSignature } from "../../../src/authority/signing.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import { flagString, systemsCacheSiteExists } from "../helpers.ts";

export interface AuthorityDelegationValidateResult {
  command: "authority.delegation.validate";
  status: "pass" | "fail";
  file: string;
  delegations: number;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

function diag(
  ruleId: string,
  severity: "error" | "warning",
  message: string,
  file?: string,
): Diagnostic {
  return { ruleId, severity, message, file };
}

export async function runAuthorityDelegationValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AuthorityDelegationValidateResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const siteFilter = flagString(input, "site");
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const io = resolveIo(context.io);
  const filePath = delegationsPath(workspaceRoot);

  // DELEG-01: absent registry is legal (zero delegations); unreadable or
  // unparseable registry is a blocking load failure — never fail open.
  let raw: unknown;
  try {
    raw = YAML.parse(await io.readFile(filePath));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        data: {
          command: "authority.delegation.validate",
          status: "pass",
          file: DELEGATIONS_FILENAME,
          delegations: 0,
          errors,
          warnings,
        },
        summary: "no delegation registry — zero delegations",
        exitCode: 0,
      };
    }
    errors.push(
      diag(
        "DELEG-01",
        "error",
        `cannot read/parse ${DELEGATIONS_FILENAME}: ${e instanceof Error ? e.message : String(e)}`,
        DELEGATIONS_FILENAME,
      ),
    );
    return { data: resultData(errors, warnings, 0), summary: "registry unreadable", exitCode: 1 };
  }

  // DELEG-02: schema violations.
  const parsed = authorityDelegationsSchema.safeParse(raw);
  const entries = parsed.success
    ? parsed.data.delegations
    : Array.isArray((raw as { delegations?: unknown[] })?.delegations)
      ? ((raw as { delegations: unknown[] }).delegations.filter(
          (d): d is Record<string, unknown> => typeof d === "object" && d !== null,
        ) as never[])
      : [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(
        diag(
          "DELEG-02",
          "error",
          `schema violation at ${issue.path.join(".") || "<root>"}: ${issue.message}`,
          DELEGATIONS_FILENAME,
        ),
      );
    }
  }

  // Semantic checks run over whatever parsed — per-entry diagnostics.
  const seen = new Set<string>();
  const now = Date.now();
  for (const d of entries) {
    const id = typeof d.id === "string" ? d.id : "<unknown>";
    if (seen.has(id)) {
      errors.push(
        diag("DELEG-03", "error", `duplicate delegation id "${id}"`, DELEGATIONS_FILENAME),
      );
    }
    seen.add(id);

    const scope = typeof d.scope === "string" ? d.scope : "";
    if ((NON_DELEGABLE_SCOPES as readonly string[]).includes(scope)) {
      errors.push(
        diag(
          "DELEG-04",
          "error",
          `"${id}" delegates non-delegable scope "${scope}" (RFC-1336: human-only)`,
          DELEGATIONS_FILENAME,
        ),
      );
    } else if (scope && !isDelegableScope(scope)) {
      warnings.push(
        diag(
          "DELEG-05",
          "warning",
          `"${id}" uses unknown scope "${scope}" — not in the RFC-1336 catalogue`,
          DELEGATIONS_FILENAME,
        ),
      );
    }

    if (d.grantedTo === "agent:*") {
      warnings.push(
        diag(
          "DELEG-06",
          "warning",
          `"${id}" grants the agent:* wildcard — prefer an explicit agent:<id>`,
          DELEGATIONS_FILENAME,
        ),
      );
    }

    if (Array.isArray(d.sites)) {
      for (const siteId of d.sites as string[]) {
        if (siteFilter && siteId !== siteFilter && siteFilter !== undefined) continue;
        if (!(await systemsCacheSiteExists(workspaceRoot, siteId, context.io))) {
          warnings.push(
            diag(
              "DELEG-07",
              "warning",
              `"${id}" references site "${siteId}" — no systems-cache/${siteId} sibling exists`,
              DELEGATIONS_FILENAME,
            ),
          );
        }
      }
    }

    if (typeof d.signature === "string" && parsed.success) {
      const entry = parsed.data.delegations.find((e) => e.id === id);
      if (
        entry &&
        !verifyDelegationSignature(entry.signature!, canonicalDelegationPayload(entry))
      ) {
        warnings.push(
          diag(
            "DELEG-08",
            "warning",
            `"${id}" signature does not verify against its canonical payload`,
            DELEGATIONS_FILENAME,
          ),
        );
      }
    }

    // Informational: expired-but-unrevoked entries are legal history, no signal.
    void now;
  }

  const status = errors.length === 0 ? "pass" : "fail";
  if (outputFormat === "pretty") {
    logger.section(`Authority delegations: ${DELEGATIONS_FILENAME}`);
    logger.info(`  ${entries.length} delegation(s)`);
    for (const w of warnings) logger.warn(`  ${w.ruleId}: ${w.message}`);
    for (const e of errors) logger.error(`  ${e.ruleId}: ${e.message}`);
  }

  return {
    data: resultData(errors, warnings, entries.length),
    summary:
      status === "pass"
        ? `delegation registry valid: ${entries.length} delegation(s), ${warnings.length} warning(s)`
        : `delegation registry invalid: ${errors.length} error(s)`,
    exitCode: status === "pass" ? 0 : 1,
  };

  function resultData(
    errs: Diagnostic[],
    warns: Diagnostic[],
    count: number,
  ): AuthorityDelegationValidateResult {
    return {
      command: "authority.delegation.validate",
      status: errs.length === 0 ? "pass" : "fail",
      file: DELEGATIONS_FILENAME,
      delegations: count,
      errors: errs,
      warnings: warns,
    };
  }
}
