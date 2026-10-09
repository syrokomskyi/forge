/*
<MODULE_CONTRACT>
<purpose>
RFC-0330: emit per-RFC verification evidence artifacts. Executes acceptance
probes via the existing runProbe, captures git/kernel context, and writes
a JSON evidence envelope to docs/rfcs/verification/<slug>.generated.yaml.
</purpose>
<non-goals>
  <item>Do not duplicate probe execution — reuse runProbe from acceptance.ts.</item>
  <item>Do not run automatically inside build pipelines — on-demand only.</item>
  <item>Do not backfill evidence for pre-cutoff RFCs.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0330: initial implementation.</item>
  <item>RFC-0999: exported captureGitContext, getKernelVersion, byteHashHex, VERIFICATION_DIR for reuse by verification-refresh.ts.</item>
  <item>RFC-1237: dual-read dry-run (context.dryRun || flags["dry-run"]),
io.writeFile port routing, dry-run summary marker; serializeEvidenceEnvelope —
shared emit-canonical serializer restoring the structured YAML marker-key
header (generatedMarker/doNotEdit/ownerCommand/editInstead/regenerateCommand
with "pnpm exec werkstatt run" prefix), also consumed by refresh.</item>
</CHANGE_SUMMARY>
*/

import { execFile } from "../../src/utils/sync-fs.ts";
import { ambientIo, resolveIo } from "../../src/utils/io.ts";

import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { byteHash } from "../../src/utils/hash.ts";

import { runProbe } from "./acceptance.ts";
import { listRfcFiles, readAndParseRfc } from "./frontmatter-io.ts";
import { generatedHeaderFields } from "../../src/utils/generated-marker.ts";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { RFC_DIR } from "./types.ts";

// Ambient default for helper fns without a context param — handlers override
// with `const io = resolveIo(context.io)` inside their own scope.
const io = ambientIo;
import type {
  AcceptanceProbe,
  RfcStatus,
  VerificationEvidence,
  VerificationEvidenceProbeRecord,
  RfcVerificationEmitResult,
} from "./types.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";

export const VERIFICATION_DIR = join(RFC_DIR, "verification");
const HASH_PREFIX = "sha" + "256:";

function execGit(workspaceRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: workspaceRoot, timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve("");
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function captureGitContext(
  workspaceRoot: string,
): Promise<{ commit: string; workingTreeDirty: boolean }> {
  const [commitOutput, statusOutput] = await Promise.all([
    execGit(workspaceRoot, ["rev-parse", "HEAD"]),
    execGit(workspaceRoot, ["status", "--porcelain"]),
  ]);
  return {
    commit: commitOutput || "unknown",
    workingTreeDirty: statusOutput.length > 0,
  };
}

export async function getKernelVersion(workspaceRoot: string): Promise<string> {
  try {
    const pkgPath = join(workspaceRoot, "packages", "os", "site-kernel", "package.json");
    const pkg = JSON.parse(await io.readFile(pkgPath));
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

export function byteHashHex(content: string): string {
  return byteHash(content).slice(HASH_PREFIX.length);
}

/**
 * Bounded-parallel map preserving input order — one in-flight worker per slot,
 * results land in the same positions as their inputs. Used by the emit/refresh
 * sweeps so `--concurrency N` overlaps probe subprocesses across RFCs.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, () =>
    (async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index]!, index);
      }
    })(),
  );
  await Promise.all(lanes);
  return results;
}

/**
 * Resolve the `--concurrency` flag (string flag; the kernel schema has no
 * number kind). Garbage/NaN/non-positive degrades to 1 with a warning;
 * clamped to 16 — probe workers spawn vitest/site-kernel children and wider
 * fan-out starves CPU rather than speeding the sweep.
 */
export function resolveConcurrency(flag: unknown, warn?: (message: string) => void): number {
  if (flag === undefined) return 1;
  const raw = Array.isArray(flag) ? flag[0] : flag;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    warn?.(`--concurrency "${String(raw)}" is not a positive integer — falling back to 1.`);
    return 1;
  }
  if (parsed > 16) {
    warn?.(
      `--concurrency ${parsed} exceeds the 16 cap — clamped (probe workers spawn subprocesses).`,
    );
    return 16;
  }
  return parsed;
}

/**
 * RFC-1237: the emit-canonical envelope serialization — structured marker keys
 * (generatedMarker/doNotEdit/ownerCommand/editInstead/regenerateCommand) as
 * leading YAML fields, then the envelope body. emit and refresh MUST share
 * this serializer: refresh owns content freshness, never envelope identity
 * (OWN-DUP-01), so refresh output is identical-by-construction.
 */
export function serializeEvidenceEnvelope(envelope: VerificationEvidence): string {
  return `${yamlStringify({
    ...generatedHeaderFields({
      ownerCommand: "rfc.verification.emit",
      commandPrefix: "pnpm exec werkstatt run",
    }),
    ...envelope,
  })}\n`;
}

function normalizeProbes(probes: AcceptanceProbe[]): string {
  return JSON.stringify(probes, Object.keys(probes[0] ?? {}).sort());
}

export function buildEvidenceEnvelope(
  rfcId: string,
  title: string,
  rfcStatus: RfcStatus,
  rfcMarkdown: string,
  probes: AcceptanceProbe[],
  probeRecords: VerificationEvidenceProbeRecord[],
  gitContext: { commit: string; workingTreeDirty: boolean },
  kernelVersion: string,
  emittedAt: string,
): VerificationEvidence {
  const overall: "pass" | "fail" = probeRecords.every((r) => r.ok) ? "pass" : "fail";
  return {
    rfcId,
    title,
    rfcStatus,
    emittedAt,
    commit: gitContext.commit,
    workingTreeDirty: gitContext.workingTreeDirty,
    kernelVersion,
    rfcFileHash: byteHashHex(rfcMarkdown),
    acceptanceHash: byteHashHex(normalizeProbes(probes)),
    probes: probeRecords,
    overall,
  };
}

export async function runRfcVerificationEmit(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcVerificationEmitResult>> {
  const io = resolveIo(context.io);
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = join(workspaceRoot, RFC_DIR);
  const targetId = input.flags["id"] as string | undefined;
  const targetStatus = input.flags["status"] as string | undefined;
  // RFC-1237: consumeCommonFlags strips --dry-run into context.dryRun before
  // dispatch — the input.flags read stays for direct/programmatic callers.
  const dryRun = context.dryRun === true || input.flags["dry-run"] === true;
  const concurrency = resolveConcurrency(input.flags["concurrency"], (m) => logger.warn(m));

  if (!targetId && !targetStatus) {
    return {
      data: {
        command: "rfc.verification.emit",
        status: "pass",
        emitted: [],
        skipped: [],
        diagnostics: [],
      },
      exitCode: 0,
      summary:
        "rfc.verification.emit: pass --id <rfc-id> or --status <status> to select target RFC(s)",
    };
  }

  const allFiles = await listRfcFiles(rfcDirPath);
  const emitted: RfcVerificationEmitResult["emitted"] = [];
  const skipped: RfcVerificationEmitResult["skipped"] = [];
  const diagnostics: Diagnostic[] = [];

  const gitContext = await captureGitContext(workspaceRoot);
  if (gitContext.commit === "unknown") {
    diagnostics.push({
      ruleId: "RFC-EVID-01",
      severity: "warning",
      message: "Git context unavailable — commit recorded as 'unknown'.",
    });
  }
  const kernelVersion = await getKernelVersion(workspaceRoot);
  const verificationDirAbs = join(workspaceRoot, VERIFICATION_DIR);
  if (!dryRun) await io.mkdir(verificationDirAbs);

  const processFile = async (
    fileName: string,
  ): Promise<{
    emittedEntry?: NonNullable<RfcVerificationEmitResult["emitted"]>[number];
    skippedEntry?: NonNullable<RfcVerificationEmitResult["skipped"]>[number];
    diagnostic?: Diagnostic;
  }> => {
    const parsedFile = await readAndParseRfc(rfcDirPath, fileName);
    if (!parsedFile) return {};
    if ("error" in parsedFile) return {};
    const fm = parsedFile.parsed.frontmatter;
    const rfcId = String(fm["id"] ?? "");

    if (targetId && rfcId.toLowerCase() !== targetId.toLowerCase()) return {};
    if (targetStatus && String(fm["status"] ?? "") !== targetStatus) return {};

    const acceptance = fm["acceptance"];
    if (!Array.isArray(acceptance) || acceptance.length === 0) {
      return { skippedEntry: { rfcId, reason: "no-probes" } };
    }

    const probes = acceptance as AcceptanceProbe[];
    const probeRecords: VerificationEvidenceProbeRecord[] = [];
    const rfcFilePath = join(rfcDirPath, fileName);
    const rfcMarkdown = await io.readFile(rfcFilePath);
    const emittedAt = new Date().toISOString();

    for (const probe of probes) {
      const start = performance.now();
      const result = await runProbe(probe, workspaceRoot, context.commandRegistry);
      const durationMs = Math.round(performance.now() - start);
      probeRecords.push({
        probe,
        ok: result.ok,
        detail: result.detail,
        durationMs,
      });
    }

    const envelope = buildEvidenceEnvelope(
      rfcId,
      String(fm["title"] ?? ""),
      String(fm["status"] ?? "") as RfcStatus,
      rfcMarkdown,
      probes,
      probeRecords,
      gitContext,
      kernelVersion,
      emittedAt,
    );

    const slug = rfcId.toLowerCase();
    const evidenceFileName = `${slug}.generated.yaml`;
    const evidenceRelPath = join(VERIFICATION_DIR, evidenceFileName);
    const evidenceAbsPath = join(workspaceRoot, evidenceRelPath);

    // Committed-envelope baseline for the sweep delta — lets a fail-heavy run
    // separate still-failing drift from fresh regressions without git diff.
    let previousOverall: "pass" | "fail" | undefined;
    try {
      const existing = yamlParse(await io.readFile(evidenceAbsPath)) as VerificationEvidence | null;
      if (existing && (existing.overall === "pass" || existing.overall === "fail")) {
        previousOverall = existing.overall;
      }
    } catch {
      // No committed envelope — first emission for this RFC.
    }

    // RFC-1237: port write — the recording IO adapter intercepts under kernel
    // --dry-run even if the explicit guard regresses.
    if (!dryRun) await io.writeFile(evidenceAbsPath, serializeEvidenceEnvelope(envelope));

    if (outputFormat === "pretty") {
      const drift =
        previousOverall !== undefined && previousOverall !== envelope.overall
          ? `, was ${previousOverall}`
          : "";
      logger.info(
        `[evidence] ${rfcId} → ${evidenceRelPath} (${envelope.overall}, ${probeRecords.length} probes${drift}${dryRun ? ", dry-run" : ""})`,
      );
    }

    return {
      emittedEntry: {
        rfcId,
        file: evidenceRelPath,
        overall: envelope.overall,
        ...(previousOverall !== undefined ? { previousOverall } : {}),
      },
      ...(envelope.overall === "fail"
        ? {
            diagnostic: {
              ruleId: "RFC-EVID-02",
              severity: "error",
              file: evidenceRelPath,
              message: `${rfcId}: evidence overall is "fail" — ${probeRecords.filter((r) => !r.ok).length} probe(s) failed${previousOverall === "pass" ? " (regressed: was pass)" : ""}.`,
            } satisfies Diagnostic,
          }
        : {}),
    };
  };

  const results = await mapWithConcurrency(allFiles, concurrency, processFile);
  for (const r of results) {
    if (r.emittedEntry) emitted.push(r.emittedEntry);
    if (r.skippedEntry) skipped.push(r.skippedEntry);
    if (r.diagnostic) diagnostics.push(r.diagnostic);
  }

  const hasFailures = emitted.some((e) => e.overall === "fail");
  const status: RfcVerificationEmitResult["status"] = hasFailures ? "fail" : "pass";
  const delta = {
    recovered: emitted
      .filter((e) => e.previousOverall === "fail" && e.overall === "pass")
      .map((e) => e.rfcId),
    regressed: emitted
      .filter((e) => e.previousOverall === "pass" && e.overall === "fail")
      .map((e) => e.rfcId),
  };
  const deltaSummary =
    delta.recovered.length + delta.regressed.length > 0
      ? `, ${delta.regressed.length} regressed, ${delta.recovered.length} recovered`
      : "";

  return {
    data: {
      command: "rfc.verification.emit",
      status,
      emitted,
      skipped,
      diagnostics,
      delta,
    },
    exitCode: hasFailures ? 1 : 0,
    summary: `rfc.verification.emit: ${emitted.length} emitted, ${skipped.length} skipped${deltaSummary}${dryRun ? ", dry-run" : ""}`,
  };
}
