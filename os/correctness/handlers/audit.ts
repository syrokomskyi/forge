/*
<MODULE_CONTRACT>
<purpose>RFC-1579: `correctness.audit` command handler — flags, exit codes
(1 only for introduced errors, 2 for usage errors), pretty output, and the
`--write-ledger` mode (the only mutating mode; dry-run from context.dryRun,
DNA-110).</purpose>
<non-goals>
  <item>No auditor logic — audit/run.ts.</item>
  <item>Never writes the ledger from a gate path — only with --write-ledger.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial handler.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
</CHANGE_SUMMARY>
*/

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadForgeConfig } from "../../../src/config/forge-config.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { createOriginGit } from "../../rfc/verification-origin.ts";
import { DEFAULT_LEDGER_PATH, mergeLedger, parseLedger, serializeLedger } from "../audit/ledger.ts";
import { runCorrectnessAudit } from "../audit/run.ts";
import type { AuditCheckId, AuditResult } from "../audit/types.ts";

function flagString(input: ForgeCommandInput, name: string): string | undefined {
  const v = input.flags[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function ledgerPath(workspaceRoot: string): string {
  try {
    return loadForgeConfig(workspaceRoot).bindings?.paths?.correctnessLedger ?? DEFAULT_LEDGER_PATH;
  } catch {
    return DEFAULT_LEDGER_PATH;
  }
}

export async function runCorrectnessAuditCommand(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AuditResult>> {
  const writeLedger = input.flags["write-ledger"] === true;
  const outcome = await runCorrectnessAudit(context.workspaceRoot, {
    base: flagString(input, "base"),
    staged: input.flags["staged"] === true,
    check: flagString(input, "check") as AuditCheckId | undefined,
  });
  if (!outcome.ok) {
    return { exitCode: 2, summary: `[correctness.audit] usage error: ${outcome.usageError}` };
  }
  const data = outcome.result;

  if (writeLedger) {
    const rel = ledgerPath(context.workspaceRoot);
    const abs = path.join(context.workspaceRoot, rel);
    let previous: string | null = null;
    try {
      previous = readFileSync(abs, "utf8");
    } catch {
      previous = null;
    }
    const head =
      (await createOriginGit(context.workspaceRoot).run(["rev-parse", "HEAD"]))?.trim() ??
      "unknown";
    const merged = mergeLedger(parseLedger(previous), data.findings, {
      sha: head,
      date: new Date().toISOString().slice(0, 10),
    });
    const dryRun = context.dryRun === true;
    if (!dryRun) {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, serializeLedger(merged));
    }
    data.ledger = { path: rel, written: !dryRun, rows: merged.rows.length };
  }

  const introduced = data.findings.filter((f) => f.attribution === "introduced");
  if (context.outputFormat === "pretty") {
    for (const f of data.findings) {
      if (f.attribution === "resolved") continue;
      const where = f.location ? ` (${f.location.file}:${f.location.line})` : "";
      const line = `${f.rule} ${f.check} [${f.attribution}] ${f.subject}: ${f.message}${where}`;
      if (f.attribution === "introduced" && f.severity === "error") context.logger.error(line);
      else context.logger.warn(line);
    }
  }
  const summary =
    `correctness.audit: ${data.status} against ${data.base.slice(0, 12)} — ` +
    `${introduced.length} introduced, ${data.findings.filter((f) => f.attribution === "legacy").length} legacy, ` +
    `${data.findings.filter((f) => f.attribution === "accepted").length} accepted, ` +
    `${data.findings.filter((f) => f.attribution === "resolved").length} resolved; ` +
    `${data.unverifiable} unverifiable statement(s)` +
    (data.skipped.length > 0 ? `; skipped: ${data.skipped.join(", ")}` : "") +
    (data.ledger
      ? `; ledger ${data.ledger.written ? "written" : "planned (dry-run)"}: ${data.ledger.path} (${data.ledger.rows} rows)`
      : "");
  return { data, summary, exitCode: data.status === "fail" ? 1 : 0 };
}
