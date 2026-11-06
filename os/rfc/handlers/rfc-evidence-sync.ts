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
  <item>RFC-1516: the committed envelope is read via `git show HEAD:&lt;path&gt;`, never the worktree file — an uncommitted hand-edit can never become reusable input; every gate below green+matching+in-window falls back to full re-execution with its reason journalized.</item>
  <item>RFC-1516: reuse is evaluated in emit (not in the sync orchestrator) so the direct `rfc.verification.emit` path, the sync chain, and the stamp's in-process emits share one decision; sync only forwards the escape flag and surfaces the verdict.</item>
  <item>RFC-1516 review-r1: freshness binds to `resultsFrom ?? emittedAt`, not `emittedAt` alone — an envelope that replays records stamps the original execution's anchor, so chained emit+commit cycles cannot extend result age past the window.</item>
  <item>RFC-1516 review-r1: a probes-count mismatch is `malformed` only after the acceptanceHash gate — a legitimately changed list reports `acceptance-changed`; a matching-hash envelope with a short or misshapen probes array is crafted bytes and degrades to full re-execution, never a crash or partial reuse.</item>
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
import { execFile } from "../../../src/utils/sync-fs.ts";
import { parse as yamlParse } from "yaml";
import { gitEnvForCwd } from "../verification-origin.ts";
import type { VerificationEvidence } from "../types.ts";

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

/** RFC-1516: the evidence-freshness window — a committed green envelope
 *  younger than this may replay its heavy-probe results instead of
 *  re-executing them. 4h covers every realistic stamp-retry session while
 *  bounding staleness. */
export const EVIDENCE_REUSE_WINDOW_MS = 14400000;

export type EvidenceReuseReason =
  | "envelope-reused"
  | "absent"
  | "malformed"
  | "not-green"
  | "acceptance-changed"
  | "expired"
  | "disabled";

export interface EvidenceReuseVerdict {
  reusable: boolean;
  reason: EvidenceReuseReason;
  /** The reused envelope's `emittedAt` when reusable — provenance, not a
   *  claim the probes just ran. */
  reusedFrom?: string;
}

/** Reuse is strictly gated — anything short of a well-formed, green,
 *  acceptance-matching, in-window envelope falls back to full re-execution.
 *  `malformed` covers every unreadable/underspecified shape: unparsable
 *  YAML, a non-object body, missing contract fields, bad record elements —
 *  and a probes-array length that contradicts a matching acceptanceHash
 *  (a crafted envelope; a legitimately different list reports
 *  `acceptance-changed` first). */
export function evaluateEvidenceReuse(opts: {
  committed: VerificationEvidence | null;
  /** true when bytes existed but did not parse to the envelope contract. */
  malformed?: boolean;
  /** committed probes[].length ≠ the live acceptance list length. */
  probeCountMismatch?: boolean;
  acceptanceHashHex: string;
  disabled: boolean;
  now?: number;
}): EvidenceReuseVerdict {
  if (opts.disabled) return { reusable: false, reason: "disabled" };
  if (opts.malformed) return { reusable: false, reason: "malformed" };
  const env = opts.committed;
  if (!env) return { reusable: false, reason: "absent" };
  if (env.overall !== "pass") return { reusable: false, reason: "not-green" };
  if (env.acceptanceHash !== opts.acceptanceHashHex) {
    return { reusable: false, reason: "acceptance-changed" };
  }
  if (opts.probeCountMismatch) return { reusable: false, reason: "malformed" };
  // Freshness binds to the oldest replayed result, not the last emission:
  // `resultsFrom` is stamped when an envelope replays committed records, so
  // chained emit+commit cycles cannot extend result age past the window.
  const anchor = typeof env.resultsFrom === "string" ? env.resultsFrom : env.emittedAt;
  const anchorMs = Date.parse(anchor ?? "");
  const now = opts.now ?? Date.now();
  // Future timestamps are outside the window too (60s skew tolerance) —
  // a negative age must never read as "fresh".
  if (
    !Number.isFinite(anchorMs) ||
    now - anchorMs > EVIDENCE_REUSE_WINDOW_MS ||
    anchorMs - now > 60_000
  ) {
    return { reusable: false, reason: "expired" };
  }
  return { reusable: true, reason: "envelope-reused", reusedFrom: env.emittedAt };
}

/** The committed envelope — read from HEAD bytes (`git show`), never the
 *  worktree file, so an uncommitted hand-edit can never become reusable
 *  input. Returns {envelope} on a contract-shaped parse, {malformed} on
 *  bytes that exist but don't satisfy it, {} when nothing is committed. */
export async function readCommittedEnvelope(
  workspaceRoot: string,
  relPath: string,
  expectedProbeCount?: number,
): Promise<{
  envelope?: VerificationEvidence;
  malformed?: boolean;
  probeCountMismatch?: boolean;
}> {
  const rel = relPath.replace(/\\/g, "/");
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      "git",
      ["show", `HEAD:${rel}`],
      { cwd: workspaceRoot, timeout: 5000, env: gitEnvForCwd() },
      (err, out) => {
        resolve(err ? "" : out);
      },
    );
  });
  if (stdout.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = yamlParse(stdout);
  } catch {
    return { malformed: true };
  }
  if (typeof parsed !== "object" || parsed === null) return { malformed: true };
  const env = parsed as Partial<VerificationEvidence>;
  if (
    typeof env.rfcId !== "string" ||
    typeof env.emittedAt !== "string" ||
    typeof env.acceptanceHash !== "string" ||
    (env.overall !== "pass" && env.overall !== "fail") ||
    !Array.isArray(env.probes) ||
    env.probes.some(
      (r) => r === null || typeof r !== "object" || typeof r.ok !== "boolean",
    ) ||
    (env.resultsFrom !== undefined && typeof env.resultsFrom !== "string")
  ) {
    return { malformed: true };
  }
  // A length mismatch is NOT malformed on its own — an acceptance-changed
  // envelope legitimately describes a different-sized list. The verdict
  // classifies it as malformed only when the hash still matches (crafted).
  const probeCountMismatch =
    expectedProbeCount !== undefined && env.probes.length !== expectedProbeCount;
  return { envelope: env as VerificationEvidence, probeCountMismatch };
}

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
  /** RFC-1516: the emit step's freshness-window verdict — surfaced verbatim
   *  so a stamp-sync log shows whether heavy probes re-executed or the
   *  committed envelope replayed. */
  reuse?: EvidenceReuseVerdict;
  /** Criteria whose run/test/page/proof results carried over. */
  heavyProbesReused?: string[];
  /** Criteria re-resolved against the live tree. */
  cheapProbesReRun?: string[];
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
  // RFC-1516: the escape flag forwards verbatim to the emit step — every
  // probe then re-executes regardless of envelope freshness.
  const noEvidenceReuse = input.flags["no-evidence-reuse"] === true;

  const plan: Array<{ step: string; flags?: Record<string, string> }> = [
    ...EVIDENCE_SYNC_STEPS.map((step) => ({ step })),
    ...(rfcIdStr
      ? [
          {
            step: EVIDENCE_SYNC_EMIT_STEP,
            flags: {
              id: rfcIdStr,
              ...(noEvidenceReuse ? { "no-evidence-reuse": "true" } : {}),
            },
          },
        ]
      : []),
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
  let emitReport: Awaited<ReturnType<typeof invoke>> | null = null;
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
    if (planned.step === EVIDENCE_SYNC_EMIT_STEP) emitReport = report;
    if (outputFormat === "pretty") {
      const changed = filesModified.length;
      logger.info(
        `  ${planned.step}: ${stepResult.status}${changed > 0 ? ` (${changed} file${changed === 1 ? "" : "s"} changed)` : ""}`,
      );
      // RFC-1516: a one-line note keeps replayed probes visible — an old
      // pass must never look like a fresh execution in pretty output.
      if (planned.step === EVIDENCE_SYNC_EMIT_STEP && report.exitCode === 0) {
        const emitted = (report.data as { emitted?: Array<{
          reuse?: { reusable?: boolean; reusedFrom?: string };
          heavyProbesReused?: string[];
        }> } | null)?.emitted?.[0];
        if (emitted?.reuse?.reusable === true) {
          logger.info(
            `  ${planned.step}: envelope-reused — ${emitted.heavyProbesReused?.length ?? 0} heavy probe(s) replayed from ${emitted.reuse.reusedFrom}`,
          );
        }
      }
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
  // RFC-1516: surface the emit step's freshness-window verdict verbatim —
  // a stamp-sync log shows whether heavy probes re-executed or the
  // committed envelope replayed, never silently.
  const emitStep = steps.find((s) => s.step === EVIDENCE_SYNC_EMIT_STEP);
  const emitData =
    emitStep !== undefined && emitReport !== null
      ? (emitReport.data as {
          emitted?: Array<{
            reuse?: EvidenceReuseVerdict;
            heavyProbesReused?: string[];
            cheapProbesReRun?: string[];
          }>;
        } | null)
      : null;
  const emittedEntry = emitData?.emitted?.[0];
  return syncResult(
    "pass",
    [],
    {
      steps,
      ...(rfcIdStr ? { rfcId: rfcIdStr } : {}),
      ...(emittedEntry?.reuse ? { reuse: emittedEntry.reuse } : {}),
      ...(emittedEntry?.heavyProbesReused?.length
        ? { heavyProbesReused: emittedEntry.heavyProbesReused }
        : {}),
      ...(emittedEntry?.cheapProbesReRun?.length
        ? { cheapProbesReRun: emittedEntry.cheapProbesReRun }
        : {}),
    },
    `rfc.evidence.sync: ${steps.length} steps clean, ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} changed`,
  );
}
