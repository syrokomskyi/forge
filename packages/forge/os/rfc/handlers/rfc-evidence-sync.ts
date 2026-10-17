/*
<MODULE_CONTRACT>
<purpose>
RFC-1306: rfc.evidence.sync — one-command evidence resync before stamp.
Runs the workspace's generated-manifest chain in dependency order and
finishes with rfc.verification.emit when --id is given, so a single
invocation attests "all generated artifacts + RFC evidence are current".
</purpose>
<non-goals>
  <item>Does not reimplement generator logic — every step is delegated by name through the host's invocation port.</item>
  <item>Does not run inside pipelines — sync is an explicit on-demand command like rfc.verification.emit.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Step order is contract: the ecosystem manifest hashes the other artifacts, so ecosystem.manifest.generate runs last among the manifest steps.</item>
  <item>EVIDENCE_SYNC_STEPS is the canonical regen list</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1306: initial — EVIDENCE_SYNC_STEPS chain + runRfcEvidenceSync via the ctx.invoke port; EVIDENCE-SYNC-01 fail-closed without a kernel host, EVIDENCE-SYNC-02 propagates a failed step's diagnostics verbatim; review-r1: try/catch maps thrown invokes into EVIDENCE-SYNC-02, dry-run exposes `planned` in data.</item>
  <item>RFC-1306: review-r1 — io-native writes, cacheable off on chain generators, EVIDENCE-SYNC-02 on invoke throws</item>
</CHANGE_SUMMARY>
*/

import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

/**
 * The canonical RFC-evidence regen order (RFC-1306). The emit step is
 * appended conditionally on --id — the chain ends at rfc.verification.emit,
 * which never re-enters this command.
 */
export const EVIDENCE_SYNC_STEPS: readonly string[] = [
  "checks.commands.generate",
  "command.manifest.generate",
  "validator.inventory.generate",
  "docs.commands.generate",
  "ecosystem.manifest.generate",
];

export const EVIDENCE_SYNC_EMIT_STEP = "rfc.verification.emit";

export interface RfcEvidenceSyncStepResult {
  step: string;
  flags?: Record<string, unknown>;
  exitCode: number;
  status: "pass" | "fail";
  filesModified: string[];
  summary?: string;
}

export interface RfcEvidenceSyncViolation {
  rule: string;
  message: string;
  step?: string;
  /** The failed step's diagnostics/violations payload, verbatim. */
  stepDiagnostics?: unknown;
}

export interface RfcEvidenceSyncResult {
  steps: RfcEvidenceSyncStepResult[];
  rfcId?: string;
  failedStep?: string;
  /** Dry-run only — the ordered step list that would execute. */
  planned?: Array<{ step: string; flags?: Record<string, string> }>;
}

interface SyncReport {
  command: string;
  status: "pass" | "fail";
  violations: RfcEvidenceSyncViolation[];
  data?: RfcEvidenceSyncResult;
}

function childDiagnostics(data: unknown): unknown {
  if (data !== null && typeof data === "object") {
    const record = data as Record<string, unknown>;
    return record["diagnostics"] ?? record["violations"];
  }
  return undefined;
}

function syncResult(
  status: "pass" | "fail",
  violations: RfcEvidenceSyncViolation[],
  data: RfcEvidenceSyncResult | undefined,
  summary: string,
): ForgeCommandResult<SyncReport> {
  return {
    data: { command: "rfc.evidence.sync", status, violations, ...(data ? { data } : {}) },
    exitCode: status === "pass" ? 0 : 1,
    summary,
  };
}

export async function runRfcEvidenceSync(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SyncReport>> {
  const { logger, outputFormat } = context;
  const rfcId = input.flags["id"];
  const rfcIdStr = typeof rfcId === "string" && rfcId !== "" ? rfcId : undefined;
  const isDryRun = context.dryRun || input.flags["dry-run"] === true;

  const plan: Array<{ step: string; flags?: Record<string, string> }> = [
    ...EVIDENCE_SYNC_STEPS.map((step) => ({ step })),
    ...(rfcIdStr ? [{ step: EVIDENCE_SYNC_EMIT_STEP, flags: { id: rfcIdStr } }] : []),
  ];

  if (isDryRun) {
    const lines = plan.map((p) =>
      p.flags
        ? `${p.step} ${Object.entries(p.flags)
            .map(([k, v]) => `--${k}=${v}`)
            .join(" ")}`
        : p.step,
    );
    if (outputFormat === "pretty") {
      logger.info(`[dry-run] rfc.evidence.sync would run ${plan.length} steps:`);
      for (const line of lines) logger.info(`  ${line}`);
    }
    return {
      data: {
        command: "rfc.evidence.sync",
        status: "pass",
        violations: [],
        data: { steps: [], planned: plan, ...(rfcIdStr ? { rfcId: rfcIdStr } : {}) },
      },
      exitCode: 0,
      summary: `[dry-run] rfc.evidence.sync: ${plan.length} steps — ${lines.join(" → ")}`,
    };
  }

  // EVIDENCE-SYNC-01: the orchestration port exists only under a kernel
  // host — the standalone forge CLI has no executeKernelCommand behind it.
  const invoke = context.invoke;
  if (!invoke) {
    const violations: RfcEvidenceSyncViolation[] = [
      {
        rule: "EVIDENCE-SYNC-01",
        message:
          "rfc.evidence.sync requires the werkstatt kernel host (context.invoke is absent). Run it via `pnpm exec werkstatt run rfc.evidence.sync`.",
      },
    ];
    if (outputFormat === "pretty") {
      logger.warn(`EVIDENCE-SYNC-01: ${violations[0]!.message}`);
    }
    return syncResult("fail", violations, undefined, "rfc.evidence.sync: no kernel host");
  }

  const steps: RfcEvidenceSyncStepResult[] = [];
  for (const planned of plan) {
    // A throwing invoke (unresolvable child, host/module failure) still maps
    // into the EVIDENCE-SYNC-02 contract — fail closed, never a raw exception.
    let report: Awaited<ReturnType<typeof invoke>>;
    try {
      report = await invoke(planned.step, planned.flags);
    } catch (err) {
      const violations: RfcEvidenceSyncViolation[] = [
        {
          rule: "EVIDENCE-SYNC-02",
          message: `Step "${planned.step}" threw: ${err instanceof Error ? err.message : String(err)}. Partial sync — earlier steps were applied.`,
          step: planned.step,
        },
      ];
      return syncResult(
        "fail",
        violations,
        { steps, failedStep: planned.step, ...(rfcIdStr ? { rfcId: rfcIdStr } : {}) },
        `rfc.evidence.sync: step "${planned.step}" threw`,
      );
    }
    const filesModified = report.filesModified ?? [];
    const stepResult: RfcEvidenceSyncStepResult = {
      step: planned.step,
      ...(planned.flags ? { flags: planned.flags } : {}),
      exitCode: report.exitCode,
      status: report.exitCode === 0 ? "pass" : "fail",
      filesModified,
      ...(report.summary ? { summary: report.summary } : {}),
    };
    steps.push(stepResult);
    if (outputFormat === "pretty") {
      const changed = filesModified.length;
      logger.info(
        `  ${planned.step}: ${stepResult.status}${changed > 0 ? ` (${changed} file${changed === 1 ? "" : "s"} changed)` : ""}`,
      );
    }

    // EVIDENCE-SYNC-02: stop on the first failing step — a partial sync is
    // reported with the step's diagnostics verbatim, never silently tolerated.
    if (report.exitCode !== 0) {
      const violations: RfcEvidenceSyncViolation[] = [
        {
          rule: "EVIDENCE-SYNC-02",
          message: `Step "${planned.step}" failed (exit ${report.exitCode})${report.summary ? `: ${report.summary}` : ""}. Partial sync — earlier steps were applied.`,
          step: planned.step,
          ...(childDiagnostics(report.data) !== undefined
            ? { stepDiagnostics: childDiagnostics(report.data) }
            : {}),
        },
      ];
      return syncResult(
        "fail",
        violations,
        { steps, failedStep: planned.step, ...(rfcIdStr ? { rfcId: rfcIdStr } : {}) },
        `rfc.evidence.sync: failed at step "${planned.step}"`,
      );
    }
  }

  const changedFiles = [...new Set(steps.flatMap((s) => s.filesModified))];
  return syncResult(
    "pass",
    [],
    { steps, ...(rfcIdStr ? { rfcId: rfcIdStr } : {}) },
    `rfc.evidence.sync: ${steps.length} steps clean, ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} changed`,
  );
}
