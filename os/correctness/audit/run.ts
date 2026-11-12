/*
<MODULE_CONTRACT>
<purpose>RFC-1579 orchestration of `correctness.audit` — resolve the base
revision, load the base and judged snapshots (working tree or staged index),
run the code auditors on both and the configuration auditor on the judged
tree, attribute findings differentially, apply the allow-list, and derive
the status (fail only on introduced errors).</purpose>
<non-goals>
  <item>No writes — the ledger writer lives in the handler behind --write-ledger.</item>
  <item>No manifest validation or oracle freeze — RFC-1578 / RFC-1580.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial orchestration.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
  <item>RFC-1579: gate line, ecosystem.commit early run, reference page

typescript profile integration-gate.sh runs the primary install's correctness.audit against FLOW_BASE_SHA; werkstatt ecosystem.commit gains EC-34 (correctness.audit --staged, refuses introduced CORR-AUDIT-01..03, warns on CORR-AUDIT-04); in-code CREATE TABLE tables (Durable Object storage) are unverifiable instead of D1 findings; correctness.audit declares generates: []; reference page and agent guides.

Measured on werkstatt (rollout step 3): 7 wrangler D1 configs, ~10 s per run, 3 legacy sql.schema.conform findings (packages/warpgogol-billing-cloudflare against schemas outside the repo), 127 unverifiable statements, no state machines; CORR-AUDIT-04 present (verify equals test) — fixed by the werkstatt gate-wiring queue task.</item>
  <item>RFC-1579: close review REVIEW-CODE-2026-11-13-01 findings

F1 INSERT 'has no column named' is a finding; F2 severity/kind escalation since base is introduced; F3 unparseable machine tables are errors; F4 comma joins, string literals and comments in table extraction; F5 only migration INSERT/REPLACE seed writes; F6 SET-clause-only coverage; F7 method-call writers; F8 regex literals in the scanner; F9 alias resolution; F10 EC-34 judges the payload only; F11 EC-34 before the scoped gates with a dry-run line; F12/F13 config and YAML errors named; F14 config-only check skips snapshots; F15 git grep failures fail closed; F16 portable prefilter; F17 shell no-ops; F18 shared D1 schemas; in-code DDL scoped per package; ledger tests. DEV-1..DEV-4 recorded in the RFC Deviations section.</item>
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { createOriginGit } from "../../rfc/verification-origin.ts";

import { auditVerifySubstance } from "./bindings-verify-substance.ts";
import { attribute, readAllowList } from "./differential.ts";
import { auditLedgerOrphans } from "./ledger-orphans.ts";
import { closeSchemas, discoverSchemas } from "./schema-db.ts";
import { auditSqlSchemaConform, inCodeTables } from "./sql-schema-conform.ts";
import { scanLiterals, scanStatements, type SqlStatement } from "./sql-scanner.ts";
import {
  defaultBase,
  isTestFile,
  loadSnapshot,
  resolveRevision,
  type SnapshotKind,
  type TreeSnapshot,
} from "./snapshot.ts";
import { auditStateTransitions, declaredWriters } from "./state-transitions-coverage.ts";
import { AUDIT_CHECK_IDS, type AuditCheckId, type AuditResult, type RawFinding } from "./types.ts";

export interface AuditOptions {
  /** Revision to compare against; default: HEAD with --staged, else merge-base with develop. */
  base?: string;
  /** Judge the staged index instead of the working tree. */
  staged?: boolean;
  /** Run one auditor only. */
  check?: AuditCheckId;
}

export type AuditOutcome = { ok: true; result: AuditResult } | { ok: false; usageError: string };

interface CodePass {
  findings: RawFinding[];
  unverifiable: number;
  skipped: string[];
}

function statementsOf(snapshot: TreeSnapshot): SqlStatement[] {
  const out: SqlStatement[] = [];
  for (const [file, text] of snapshot.files) {
    if (!/\.(?:ts|mts|tsx)$/.test(file) || isTestFile(file)) continue;
    out.push(...scanStatements(file, text));
  }
  return out;
}

const DDL_RE = /CREATE\s+(?:VIRTUAL\s+)?TABLE/i;

/** Literal texts carrying in-code DDL (non-test TypeScript only), with their file. */
function literalTextsOf(snapshot: TreeSnapshot): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const [file, text] of snapshot.files) {
    if (!/\.(?:ts|mts|tsx)$/.test(file) || isTestFile(file) || !DDL_RE.test(text)) continue;
    for (const lit of scanLiterals(text))
      if (DDL_RE.test(lit.text)) out.push({ file, text: lit.text });
  }
  return out;
}

/** Run the code auditors (1–3) over one snapshot. */
export function runCodeAuditors(snapshot: TreeSnapshot, only?: AuditCheckId): CodePass {
  const wants = (id: AuditCheckId) => !only || only === id;
  const pass: CodePass = { findings: [], unverifiable: 0, skipped: [] };
  if (wants("sql.schema.conform") || wants("ledger.orphans")) {
    const discovery = discoverSchemas(snapshot);
    try {
      for (const u of discovery.unsupported)
        pass.skipped.push(`sql.schema.conform: unsupported-config (${u})`);
      const noD1 = discovery.schemas.length === 0 && discovery.failures.length === 0;
      if (noD1) {
        if (wants("sql.schema.conform")) pass.skipped.push("sql.schema.conform: no-d1");
        if (wants("ledger.orphans")) pass.skipped.push("ledger.orphans: no-d1");
      } else {
        const statements = statementsOf(snapshot);
        if (wants("sql.schema.conform")) {
          const r = auditSqlSchemaConform(
            discovery,
            statements,
            inCodeTables(literalTextsOf(snapshot)),
          );
          pass.findings.push(...r.findings);
          pass.unverifiable += r.unverifiable;
        }
        if (wants("ledger.orphans"))
          pass.findings.push(...auditLedgerOrphans(discovery, statements, snapshot).findings);
      }
    } finally {
      closeSchemas(discovery);
    }
  }
  if (wants("state.transitions.coverage")) {
    const r = auditStateTransitions(snapshot);
    pass.findings.push(...r.findings);
    pass.skipped.push(...r.skipped);
  }
  return pass;
}

function forgeDoc(snapshot: TreeSnapshot): unknown {
  try {
    return parseYaml(snapshot.files.get("forge.yaml") ?? "") ?? {};
  } catch {
    return {};
  }
}

export async function runCorrectnessAudit(
  workspaceRoot: string,
  options: AuditOptions = {},
): Promise<AuditOutcome> {
  if (options.check && !AUDIT_CHECK_IDS.includes(options.check)) {
    return {
      ok: false,
      usageError: `--check ${options.check} is not an auditor (${AUDIT_CHECK_IDS.join(", ")})`,
    };
  }
  const baseRef = options.base ?? (options.staged ? "HEAD" : null);
  const base = baseRef
    ? await resolveRevision(workspaceRoot, baseRef)
    : await defaultBase(workspaceRoot);
  if (!base) {
    return {
      ok: false,
      usageError: baseRef
        ? `--base ${baseRef} does not resolve to a commit`
        : "no merge-base with develop — pass --base <ref>",
    };
  }
  const judgedKind: SnapshotKind = options.staged ? { kind: "index" } : { kind: "worktree" };
  const configOnly = options.check === "bindings.verify.substance";
  const empty = { findings: [] as RawFinding[], unverifiable: 0, skipped: [] as string[] };
  let now: TreeSnapshot | null;
  let then: TreeSnapshot | null;
  try {
    if (configOnly) {
      // The configuration auditor needs only forge.yaml — no base or code reads.
      const forgeYaml = options.staged
        ? await createOriginGit(workspaceRoot).run(["show", ":forge.yaml"])
        : (() => {
            try {
              return readFileSync(path.join(workspaceRoot, "forge.yaml"), "utf8");
            } catch {
              return null;
            }
          })();
      now = {
        label: judgedKind.kind,
        files: new Map(forgeYaml ? [["forge.yaml", forgeYaml]] : []),
      };
      then = { label: base, files: new Map() };
    } else {
      now = await loadSnapshot(workspaceRoot, judgedKind, declaredWriters);
      then = await loadSnapshot(workspaceRoot, { kind: "rev", sha: base }, declaredWriters);
    }
  } catch (err) {
    return { ok: false, usageError: `cannot read the trees: ${(err as Error).message}` };
  }
  if (!now || !then)
    return { ok: false, usageError: `cannot read the ${!now ? "judged tree" : `base ${base}`}` };

  const codeOnly = options.check && !configOnly ? options.check : undefined;
  const nowPass = configOnly ? empty : runCodeAuditors(now, codeOnly);
  const basePass = configOnly ? empty : runCodeAuditors(then, codeOnly);

  const doc = forgeDoc(now);
  const exempt = (doc as { correctness?: { mode?: unknown } })?.correctness?.mode === "exempt";
  const config =
    !options.check || options.check === "bindings.verify.substance"
      ? auditVerifySubstance(now.files.get("forge.yaml"), exempt)
      : { findings: [], unverifiable: 0, skipped: [] };

  const findings = attribute(
    basePass.findings,
    [...nowPass.findings, ...config.findings],
    readAllowList(doc),
  );
  const blocking = findings.some((f) => f.attribution === "introduced" && f.severity === "error");
  return {
    ok: true,
    result: {
      command: "correctness.audit",
      base,
      status: blocking ? "fail" : "pass",
      findings,
      unverifiable: nowPass.unverifiable,
      skipped: [...nowPass.skipped, ...config.skipped],
    },
  };
}
