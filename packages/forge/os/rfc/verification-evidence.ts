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
</CHANGE_SUMMARY>
*/

import { execFile } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { byteHash } from "../../src/utils/hash.ts";

import { runProbe } from "./acceptance.ts";
import { listRfcFiles, readAndParseRfc } from "./frontmatter-io.ts";
import { writeFileAtomic } from "../../src/utils/fs-atomic.ts";
import { buildGeneratedHeader } from "../../src/utils/generated-marker.ts";
import { stringify as yamlStringify } from "yaml";
import { RFC_DIR } from "./types.ts";
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

const VERIFICATION_DIR = join(RFC_DIR, "verification");
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

async function captureGitContext(
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

async function getKernelVersion(workspaceRoot: string): Promise<string> {
  try {
    const pkgPath = join(workspaceRoot, "packages", "os", "site-kernel", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

function byteHashHex(content: string): string {
  return byteHash(content).slice(HASH_PREFIX.length);
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
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = join(workspaceRoot, RFC_DIR);
  const targetId = input.flags["id"] as string | undefined;
  const targetStatus = input.flags["status"] as string | undefined;

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
  await mkdir(verificationDirAbs, { recursive: true });

  for (const fileName of allFiles) {
    const parsedFile = await readAndParseRfc(rfcDirPath, fileName);
    if (!parsedFile) continue;
    if ("error" in parsedFile) continue;
    const fm = parsedFile.parsed.frontmatter;
    const rfcId = String(fm["id"] ?? "");

    if (targetId && rfcId.toLowerCase() !== targetId.toLowerCase()) continue;
    if (targetStatus && String(fm["status"] ?? "") !== targetStatus) continue;

    const acceptance = fm["acceptance"];
    if (!Array.isArray(acceptance) || acceptance.length === 0) {
      skipped.push({ rfcId, reason: "no-probes" });
      continue;
    }

    const probes = acceptance as AcceptanceProbe[];
    const probeRecords: VerificationEvidenceProbeRecord[] = [];
    const rfcFilePath = join(rfcDirPath, fileName);
    const rfcMarkdown = await readFile(rfcFilePath, "utf-8");
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
    const jsonContent = `${buildGeneratedHeader({ filePath: evidenceRelPath, ownerCommand: "rfc.verification.emit" })}${yamlStringify(envelope)}\n`;
    await writeFileAtomic(evidenceAbsPath, jsonContent);

    emitted.push({ rfcId, file: evidenceRelPath, overall: envelope.overall });

    if (envelope.overall === "fail") {
      diagnostics.push({
        ruleId: "RFC-EVID-02",
        severity: "error",
        file: evidenceRelPath,
        message: `${rfcId}: evidence overall is "fail" — ${probeRecords.filter((r) => !r.ok).length} probe(s) failed.`,
      });
    }

    if (outputFormat === "pretty") {
      logger.info(
        `[evidence] ${rfcId} → ${evidenceRelPath} (${envelope.overall}, ${probeRecords.length} probes)`,
      );
    }
  }

  const hasFailures = emitted.some((e) => e.overall === "fail");
  const status: RfcVerificationEmitResult["status"] = hasFailures ? "fail" : "pass";

  return {
    data: {
      command: "rfc.verification.emit",
      status,
      emitted,
      skipped,
      diagnostics,
    },
    exitCode: hasFailures ? 1 : 0,
    summary: `rfc.verification.emit: ${emitted.length} emitted, ${skipped.length} skipped`,
  };
}
