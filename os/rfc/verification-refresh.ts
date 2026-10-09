/*
<MODULE_CONTRACT>
<purpose>
RFC-0999: re-run acceptance probes for implemented RFCs and update their
verification evidence envelopes in-place. Preserves emittedAt, adds
lastRefreshedAt, replaces probes[] with fresh results. Supports --id,
--all, and --dry-run flags.
</purpose>
<non-goals>
  <item>Do not duplicate probe execution — reuse runProbe from acceptance.ts.</item>
  <item>Do not create new envelopes — refresh only updates existing ones.</item>
  <item>Do not run for non-implemented RFCs — only implemented status has evidence.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0999: initial implementation.</item>
  <item>RFC-1237: dual-read dry-run (context.dryRun || flags["dry-run"]),
io.writeFile port routing, emit-canonical generated header — refresh owns
content freshness, never envelope identity (ownerCommand stays
rfc.verification.emit).</item>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";
import { resolveIo } from "../../src/utils/io.ts";
import { performance } from "node:perf_hooks";
import { parse as yamlParse } from "yaml";

import { runProbe } from "./acceptance.ts";
import { listRfcFiles, readAndParseRfc } from "./frontmatter-io.ts";
import {
  captureGitContext,
  getKernelVersion,
  mapWithConcurrency,
  resolveConcurrency,
  VERIFICATION_DIR,
  buildEvidenceEnvelope,
  serializeEvidenceEnvelope,
} from "./verification-evidence.ts";
import { RFC_DIR } from "./types.ts";
import type {
  AcceptanceProbe,
  RfcStatus,
  VerificationEvidence,
  VerificationEvidenceProbeRecord,
  RfcVerificationRefreshResult,
} from "./types.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";

export async function runRfcVerificationRefresh(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcVerificationRefreshResult>> {
  const io = resolveIo(context.io);
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = join(workspaceRoot, RFC_DIR);
  const targetId = input.flags["id"] as string | undefined;
  const allMode = input.flags["all"] === true;
  // RFC-1237: consumeCommonFlags strips --dry-run into context.dryRun before
  // dispatch — the input.flags read stays for direct/programmatic callers.
  const dryRun = context.dryRun === true || input.flags["dry-run"] === true;
  const concurrency = resolveConcurrency(input.flags["concurrency"], (m) => logger.warn(m));

  if (!targetId && !allMode) {
    return {
      data: {
        command: "rfc.verification.refresh",
        status: "pass",
        refreshed: [],
        skipped: [],
        diagnostics: [],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
      },
      exitCode: 0,
      summary: "rfc.verification.refresh: pass --id <rfc-id> or --all to select target RFC(s)",
    };
  }

  const allFiles = await listRfcFiles(rfcDirPath);
  const refreshed: RfcVerificationRefreshResult["refreshed"] = [];
  const skipped: RfcVerificationRefreshResult["skipped"] = [];
  const diagnostics: Diagnostic[] = [];

  const gitContext = await captureGitContext(workspaceRoot);
  const kernelVersion = await getKernelVersion(workspaceRoot);

  const processFile = async (
    fileName: string,
  ): Promise<{
    refreshedEntry?: NonNullable<RfcVerificationRefreshResult["refreshed"]>[number];
    skippedEntry?: NonNullable<RfcVerificationRefreshResult["skipped"]>[number];
    diagnostic?: Diagnostic;
  }> => {
    const parsedFile = await readAndParseRfc(rfcDirPath, fileName);
    if (!parsedFile) return {};
    if ("error" in parsedFile) return {};
    const fm = parsedFile.parsed.frontmatter;
    const rfcId = String(fm["id"] ?? "");
    const status = String(fm["status"] ?? "");

    if (targetId && rfcId.toLowerCase() !== targetId.toLowerCase()) return {};

    if (status !== "implemented") {
      return { skippedEntry: { rfcId, reason: "not implemented" } };
    }

    const slug = rfcId.toLowerCase();
    const evidenceFileName = `${slug}.generated.yaml`;
    const evidenceRelPath = join(VERIFICATION_DIR, evidenceFileName);
    const evidenceAbsPath = join(workspaceRoot, evidenceRelPath);

    let existingEnvelope: VerificationEvidence | null = null;
    try {
      const raw = await io.readFile(evidenceAbsPath);
      const parsed = yamlParse(raw) as VerificationEvidence;
      if (parsed && typeof parsed === "object" && parsed.rfcId) {
        existingEnvelope = parsed;
      }
    } catch {
      // file doesn't exist or can't be parsed
    }

    const acceptance = fm["acceptance"];
    if (!existingEnvelope || !Array.isArray(acceptance) || acceptance.length === 0) {
      return { skippedEntry: { rfcId, reason: "no evidence envelope" } };
    }

    const probes = acceptance as AcceptanceProbe[];
    const probeRecords: VerificationEvidenceProbeRecord[] = [];
    const rfcFilePath = join(rfcDirPath, fileName);
    const rfcMarkdown = await io.readFile(rfcFilePath);
    const now = new Date().toISOString();

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
      existingEnvelope.emittedAt,
    );
    envelope.lastRefreshedAt = now;

    if (!dryRun) {
      // RFC-1237: emit-canonical serialization — emit owns these envelopes;
      // refresh owns content freshness, never file identity (OWN-DUP-01).
      // Port write routes through recording IO under kernel --dry-run.
      await io.writeFile(evidenceAbsPath, serializeEvidenceEnvelope(envelope));
    }

    const probesFailed = probeRecords.filter((r) => !r.ok).length;
    const previousOverall = existingEnvelope.overall;

    if (outputFormat === "pretty") {
      const drift = previousOverall !== envelope.overall ? `, was ${previousOverall}` : "";
      logger.info(
        `[refresh] ${rfcId} → ${evidenceRelPath} (${envelope.overall}, ${probeRecords.length} probes${drift}${dryRun ? ", dry-run" : ""})`,
      );
    }

    return {
      refreshedEntry: {
        rfcId,
        file: evidenceRelPath,
        overall: envelope.overall,
        previousOverall,
        probesTotal: probeRecords.length,
        probesFailed,
      },
      ...(envelope.overall === "fail"
        ? {
            diagnostic: {
              ruleId: "RFC-REFRESH-01",
              severity: "error",
              file: evidenceRelPath,
              message: `${rfcId}: refresh overall is "fail" — ${probesFailed}/${probeRecords.length} probe(s) failed${previousOverall === "pass" ? " (regressed: was pass)" : ""}.`,
            } satisfies Diagnostic,
          }
        : {}),
    };
  };

  const results = await mapWithConcurrency(allFiles, concurrency, processFile);
  for (const r of results) {
    if (r.refreshedEntry) refreshed.push(r.refreshedEntry);
    if (r.skippedEntry) skipped.push(r.skippedEntry);
    if (r.diagnostic) diagnostics.push(r.diagnostic);
  }

  const passed = refreshed.filter((r) => r.overall === "pass").length;
  const failed = refreshed.filter((r) => r.overall === "fail").length;
  const hasFailures = failed > 0;
  const hasSkippedNoEnvelope = skipped.some((s) => s.reason === "no evidence envelope");
  const status: RfcVerificationRefreshResult["status"] = hasFailures ? "fail" : "pass";
  const delta = {
    recovered: refreshed
      .filter((r) => r.previousOverall === "fail" && r.overall === "pass")
      .map((r) => r.rfcId),
    regressed: refreshed
      .filter((r) => r.previousOverall === "pass" && r.overall === "fail")
      .map((r) => r.rfcId),
  };
  const deltaSummary =
    delta.recovered.length + delta.regressed.length > 0
      ? `, ${delta.regressed.length} regressed, ${delta.recovered.length} recovered`
      : "";

  return {
    data: {
      command: "rfc.verification.refresh",
      status,
      refreshed,
      skipped,
      diagnostics,
      delta,
      summary: {
        total: refreshed.length,
        passed,
        failed,
        skipped: skipped.length,
      },
    },
    exitCode: hasFailures || hasSkippedNoEnvelope ? 1 : 0,
    summary: `rfc.verification.refresh: ${refreshed.length} refreshed, ${skipped.length} skipped${deltaSummary}`,
  };
}
