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
</CHANGE_SUMMARY>
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parse as yamlParse } from "yaml";

import { runProbe } from "./acceptance.ts";
import { listRfcFiles, readAndParseRfc } from "./frontmatter-io.ts";
import { writeFileAtomic } from "../../src/utils/fs-atomic.ts";
import { buildGeneratedHeader } from "../../src/utils/generated-marker.ts";
import { stringify as yamlStringify } from "yaml";
import {
  captureGitContext,
  getKernelVersion,
  byteHashHex,
  VERIFICATION_DIR,
  buildEvidenceEnvelope,
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

function normalizeProbes(probes: AcceptanceProbe[]): string {
  return JSON.stringify(probes, Object.keys(probes[0] ?? {}).sort());
}

export async function runRfcVerificationRefresh(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcVerificationRefreshResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = join(workspaceRoot, RFC_DIR);
  const targetId = input.flags["id"] as string | undefined;
  const allMode = input.flags["all"] === true;
  const dryRun = input.flags["dry-run"] === true;

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
      summary:
        "rfc.verification.refresh: pass --id <rfc-id> or --all to select target RFC(s)",
    };
  }

  const allFiles = await listRfcFiles(rfcDirPath);
  const refreshed: RfcVerificationRefreshResult["refreshed"] = [];
  const skipped: RfcVerificationRefreshResult["skipped"] = [];
  const diagnostics: Diagnostic[] = [];

  const gitContext = await captureGitContext(workspaceRoot);
  const kernelVersion = await getKernelVersion(workspaceRoot);

  for (const fileName of allFiles) {
    const parsedFile = await readAndParseRfc(rfcDirPath, fileName);
    if (!parsedFile) continue;
    if ("error" in parsedFile) continue;
    const fm = parsedFile.parsed.frontmatter;
    const rfcId = String(fm["id"] ?? "");
    const status = String(fm["status"] ?? "");

    if (targetId && rfcId.toLowerCase() !== targetId.toLowerCase()) continue;

    if (status !== "implemented") {
      skipped.push({ rfcId, reason: "not implemented" });
      continue;
    }

    const slug = rfcId.toLowerCase();
    const evidenceFileName = `${slug}.generated.yaml`;
    const evidenceRelPath = join(VERIFICATION_DIR, evidenceFileName);
    const evidenceAbsPath = join(workspaceRoot, evidenceRelPath);

    let existingEnvelope: VerificationEvidence | null = null;
    try {
      const raw = await readFile(evidenceAbsPath, "utf-8");
      const parsed = yamlParse(raw) as VerificationEvidence;
      if (parsed && typeof parsed === "object" && parsed.rfcId) {
        existingEnvelope = parsed;
      }
    } catch {
      // file doesn't exist or can't be parsed
    }

    if (!existingEnvelope) {
      skipped.push({ rfcId, reason: "no evidence envelope" });
      continue;
    }

    const acceptance = fm["acceptance"];
    if (!Array.isArray(acceptance) || acceptance.length === 0) {
      skipped.push({ rfcId, reason: "no evidence envelope" });
      continue;
    }

    const probes = acceptance as AcceptanceProbe[];
    const probeRecords: VerificationEvidenceProbeRecord[] = [];
    const rfcFilePath = join(rfcDirPath, fileName);
    const rfcMarkdown = await readFile(rfcFilePath, "utf-8");
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
      const yamlContent = `${buildGeneratedHeader({ filePath: evidenceRelPath, ownerCommand: "rfc.verification.refresh" })}${yamlStringify(envelope)}\n`;
      await writeFileAtomic(evidenceAbsPath, yamlContent);
    }

    const probesFailed = probeRecords.filter((r) => !r.ok).length;
    refreshed.push({
      rfcId,
      file: evidenceRelPath,
      overall: envelope.overall,
      probesTotal: probeRecords.length,
      probesFailed,
    });

    if (envelope.overall === "fail") {
      diagnostics.push({
        ruleId: "RFC-REFRESH-01",
        severity: "error",
        file: evidenceRelPath,
        message: `${rfcId}: refresh overall is "fail" — ${probesFailed}/${probeRecords.length} probe(s) failed.`,
      });
    }

    if (outputFormat === "pretty") {
      logger.info(
        `[refresh] ${rfcId} → ${evidenceRelPath} (${envelope.overall}, ${probeRecords.length} probes${dryRun ? ", dry-run" : ""})`,
      );
    }
  }

  const passed = refreshed.filter((r) => r.overall === "pass").length;
  const failed = refreshed.filter((r) => r.overall === "fail").length;
  const hasFailures = failed > 0;
  const hasSkippedNoEnvelope = skipped.some((s) => s.reason === "no evidence envelope");
  const status: RfcVerificationRefreshResult["status"] = hasFailures ? "fail" : "pass";

  return {
    data: {
      command: "rfc.verification.refresh",
      status,
      refreshed,
      skipped,
      diagnostics,
      summary: {
        total: refreshed.length,
        passed,
        failed,
        skipped: skipped.length,
      },
    },
    exitCode: hasFailures || hasSkippedNoEnvelope ? 1 : 0,
    summary: `rfc.verification.refresh: ${refreshed.length} refreshed, ${skipped.length} skipped`,
  };
}
