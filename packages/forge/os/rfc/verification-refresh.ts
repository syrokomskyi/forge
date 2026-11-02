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
  <item>RFC-1249: wire werkstatt.commands.validate into packages.check + retire CMD-OUTPUT debt</item>
  <item>RFC-1330: refresh attaches git-derived origin like emit.</item>
  <item>RFC-1391: close RFC-1391 review r1 findings — evidence freshness, config classification, contract guards

REVIEW-CODE-2026-10-24-04 (warning): a stale .cache/proofs report could
fabricate proved; forge.yaml now resolves inside runProofCheck so a malformed
config is error not unavailable, and both surfaces share one path; {entry} is
required in formal.tools.command; spec/entry paths are confined to the
workspace; the exhaustive entry dispatches per packageManager; proved runs
record log, counterexample stays the refuted-path record.</item>
  <item>RFC-1391: close RFC-1391 review r2 findings — refresh proof passthrough, log surface

REVIEW-CODE-2026-10-24-05 (warning): rfc.verification.refresh stripped the
proof payload from probe records — a refresh would rewrite an envelope
without verdict/hashes and trip RFC-IMP-13 on next stamp; mirrored the emit
spread and pinned it with a regression test. proof.check pretty output now
prints the persisted log; every exhaustive verdict path carries vitest
output as log.</item>
  <item>RFC-1489: batch test probes through one instrumented Vitest run + frontmatter corpus reads

runProbeSet is the single shared execution point: barrier-free segments of test probes sharing one effective bound run in one vitest --reporter=json --outputFile process with per-(file,testName) attribution; missing files/reports yield unverified. run/page/proof and all non-test kinds are barriers. --no-batch escapes to the legacy path on acceptance.run, verification.emit and verification.refresh. rfc.validate reads non-target corpus files frontmatter-only via readRfcFrontmatter (64 KiB bound, full-parse fallback); emit/refresh/acceptance corpus scans use the same accessor. Corpus map slimmed to RfcCorpusEntry {fileName, frontmatter}.</item>
  <history>RFC-0999, RFC-1237</history>
</CHANGE_SUMMARY>
*/

import { join, relative } from "node:path";
import { resolveIo } from "../../src/utils/io.ts";
import { parse as yamlParse } from "yaml";

import { runProbeSet } from "./acceptance.ts";
import { attachProbeOrigins } from "./verification-origin.ts";
import { listRfcFiles, readRfcFrontmatter } from "./frontmatter-io.ts";
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
    // RFC-1489: refresh needs frontmatter only (id/status/acceptance); the
    // evidence envelope and RFC bytes are read separately below.
    const parsedFile = await readRfcFrontmatter(rfcDirPath, fileName);
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

    // RFC-1489: batch-compatible test probes share one Vitest run via
    // runProbeSet; `--no-batch` forces the legacy per-probe path.
    const { results: setResults, durationsMs } = await runProbeSet(probes, {
      workspaceRoot,
      commandRegistry: context.commandRegistry,
      forgeRoot: context.forgeRoot,
      noBatch: input.flags["no-batch"] === true,
    });
    for (const [probeIndex, probe] of probes.entries()) {
      const result = setResults[probeIndex]!;
      const durationMs = durationsMs[probeIndex]!;
      probeRecords.push({
        probe,
        ok: result.ok,
        detail: result.detail,
        durationMs,
        ...(result.proof ? { proof: result.proof } : {}),
      });
    }

    // RFC-1330: git-derived origin per probe (post-cutoff RFCs only).
    await attachProbeOrigins({
      workspaceRoot,
      rfcRelPath: relative(workspaceRoot, rfcFilePath),
      frontmatter: fm,
      probes,
      records: probeRecords,
    });

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
