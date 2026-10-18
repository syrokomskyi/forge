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
  <item>RFC-1249: wire werkstatt.commands.validate into packages.check + retire CMD-OUTPUT debt</item>
  <item>RFC-1271: review wave — deep probe normalization, malformed-envelope fail-closed, post-stamp re-emit, honest repair hints</item>
  <item>RFC-1320: pre-probe generated-artifact freshness gate — EVIDENCE-FRESH-01 blocks emission on stale/missing probe dependencies via generated.drift.validate --target=workspace; EVIDENCE-FRESH-02 warns on unverifiable; EVIDENCE-FRESH-03 fails loudly on unknown probe kinds; emit-owned envelopes excluded; blocking diagnostics flip the run's exit code</item>
  <item>RFC-1330: emit attaches git-derived origin; origin is volatile for --check.</item>
  <item>RFC-1334: step 4 — reachable acceptance probe (symbol and command modes) and V-45</item>
  <history>RFC-0330, RFC-0999, RFC-1237</history>
</CHANGE_SUMMARY>
*/

import { execFile } from "../../src/utils/sync-fs.ts";
import { ambientIo, resolveIo } from "../../src/utils/io.ts";

import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { byteHash } from "../../src/utils/hash.ts";

import { runProbe } from "./acceptance.ts";
import { attachProbeOrigins } from "./verification-origin.ts";
import { EVIDENCE_SYNC_STEPS } from "./handlers/rfc-evidence-sync.ts";
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

// RFC-1320: emitted envelopes are owned by this command — an RFC's own
// evidence artifact must never freshness-block its own emission.
const EMIT_OWNED_EVIDENCE_RE = /^docs\/rfcs\/verification\/.*\.generated\.yaml$/;
const COMMAND_MANIFEST_PATH = "docs/command-manifest.generated.yaml";

/**
 * RFC-1320: exhaustive probe-kind → candidate-artifact mapping. Probes that
 * execute live (run/test/page) carry no generated dependency; path-bearing
 * probes map to their referenced file; command-registered reads the command
 * manifest via acceptance.ts's manifest fallback. An unrecognized kind fails
 * loudly — a future kind must opt into this table.
 */
export function probeArtifactCandidates(probe: AcceptanceProbe): string[] {
  switch (probe.probe) {
    case "command-registered":
      return [COMMAND_MANIFEST_PATH];
    case "file-contains":
    case "file-exists":
      if (typeof probe.path !== "string" || probe.path.length === 0) {
        throw new Error(
          `EVIDENCE-FRESH-03: probe "${probe.probe}" carries no string path — fix the acceptance frontmatter.`,
        );
      }
      return [probe.path];
    case "json-schema":
      if (typeof probe.artifact !== "string" || probe.artifact.length === 0) {
        throw new Error(
          'EVIDENCE-FRESH-03: probe "json-schema" carries no string artifact — fix the acceptance frontmatter.',
        );
      }
      return [probe.artifact];
    case "reachable":
      return "command" in probe ? [COMMAND_MANIFEST_PATH] : [probe.module];
    case "run":
    case "test":
    case "page":
      return [];
    default:
      throw new Error(
        `EVIDENCE-FRESH-03: unknown probe kind "${String((probe as { probe?: unknown }).probe)}" — extend the freshness artifact map.`,
      );
  }
}

interface DriftArtifactVerdict {
  path: string;
  owner: string | null;
  verdict:
    | "fresh"
    | "stale"
    | "missing"
    | "skipped-volatile"
    | "skipped-binary"
    | "render-unavailable"
    | "unowned";
}

function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * RFC-1320: pre-probe freshness gate. Collects probe-referenced artifacts,
 * delegates byte-comparison to `generated.drift.validate --target=workspace
 * --paths` via context.invoke, and maps verdicts: stale/missing → blocking
 * EVIDENCE-FRESH-01 (no envelope written); invoke-absent/throw/payload-gap/
 * render-unavailable → EVIDENCE-FRESH-02 warning and probes still run.
 * `unowned` verdicts mean no generates[] declaration — no fire.
 */
async function freshnessPrecheck(
  rfcId: string,
  probes: AcceptanceProbe[],
  context: ForgeRuntimeContext,
): Promise<{ block?: Diagnostic; warnings: Diagnostic[] }> {
  const warnings: Diagnostic[] = [];
  const warn = (message: string): Diagnostic => ({
    ruleId: "EVIDENCE-FRESH-02",
    severity: "warning",
    message: `${rfcId}: ${message}`,
  });

  const candidates = new Set<string>();
  for (const probe of probes) {
    try {
      const paths = probeArtifactCandidates(probe);
      for (const p of paths) {
        const norm = toPosixPath(p);
        if (EMIT_OWNED_EVIDENCE_RE.test(norm)) continue;
        candidates.add(norm);
      }
    } catch (err) {
      // Loud failure — a future probe kind must opt into the artifact map
      // rather than silently mapping to none, and a malformed path-bearing
      // probe must fail this RFC, never crash the sweep (RFC-1320 review).
      return {
        warnings,
        block: {
          ruleId: "EVIDENCE-FRESH-03",
          severity: "error",
          message: `${rfcId}: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }
  if (candidates.size === 0) return { warnings };

  const invoke = context.invoke;
  if (!invoke) {
    warnings.push(
      warn(
        `EVIDENCE-FRESH-02: no kernel host (context.invoke absent) — probe-referenced generated artifact freshness unverified: ${[...candidates].join(", ")}`,
      ),
    );
    return { warnings };
  }

  let report: Awaited<ReturnType<typeof invoke>>;
  try {
    report = await invoke("generated.drift.validate", {
      target: "workspace",
      paths: [...candidates],
    });
  } catch (err) {
    warnings.push(
      warn(
        `EVIDENCE-FRESH-02: freshness check threw (${err instanceof Error ? err.message : String(err)}) — artifacts trusted unverified: ${[...candidates].join(", ")}`,
      ),
    );
    return { warnings };
  }

  const data =
    report && typeof report.data === "object" && report.data !== null
      ? (report.data as { artifacts?: unknown })
      : undefined;
  const artifacts = Array.isArray(data?.artifacts)
    ? (data.artifacts as DriftArtifactVerdict[])
    : undefined;
  if (!artifacts) {
    warnings.push(
      warn(
        `EVIDENCE-FRESH-02: freshness check returned no artifact verdicts — trusted unverified: ${[...candidates].join(", ")}`,
      ),
    );
    return { warnings };
  }

  const blocking = artifacts.filter((a) => a.verdict === "stale" || a.verdict === "missing");
  if (blocking.length > 0) {
    const details = blocking
      .map((a) => {
        const remedy =
          a.owner && EVIDENCE_SYNC_STEPS.includes(a.owner)
            ? `werkstatt run rfc.evidence.sync --id ${rfcId}`
            : `werkstatt run ${a.owner ?? "<generator>"}`;
        return `"${a.path}" (${a.verdict}, owner: ${a.owner ?? "unowned"}, remedy: ${remedy})`;
      })
      .join("; ");
    return {
      warnings,
      block: {
        ruleId: "EVIDENCE-FRESH-01",
        severity: "error",
        message: `${rfcId}: probe-referenced generated artifact(s) not fresh — ${details}. Emission blocked; regenerate the artifact(s) and re-run rfc.verification.emit.`,
      },
    };
  }

  const unverifiable = artifacts.filter(
    (a) =>
      a.verdict === "render-unavailable" ||
      a.verdict === "skipped-volatile" ||
      a.verdict === "skipped-binary",
  );
  if (unverifiable.length > 0) {
    warnings.push(
      warn(
        `EVIDENCE-FRESH-02: freshness unverifiable for ${unverifiable.map((a) => `"${a.path}" (${a.verdict}${a.owner ? `, owner: ${a.owner}` : ""})`).join(", ")} — probes still run`,
      ),
    );
  }
  return { warnings };
}

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

/**
 * RFC-1271: canonical serialization for acceptanceHash. Keys are sorted
 * recursively at every depth and NO key is filtered — every probe field
 * (top-level or nested inside expect/schemaInline) must reach the hash,
 * otherwise retargeting a nested probe field leaves the hash unchanged.
 * Exported so rfc.implement.stamp recomputes with the identical function.
 */
export function normalizeProbes(probes: AcceptanceProbe[]): string {
  return JSON.stringify(sortKeysDeep(probes));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
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

/**
 * RFC-1271 `--check`: compare a committed envelope against a fresh
 * computation on non-volatile fields only. Volatile per-run metadata
 * (emittedAt, lastRefreshedAt, durationMs, commit, workingTreeDirty,
 * kernelVersion, probe details) is per-run evidence context, not evidence
 * identity — it is intentionally not compared. RFC-1330 `origin` records are
 * volatile too: they depend on git history, not on the RFC bytes.
 */
export function checkEvidenceEnvelope(
  committed: Partial<VerificationEvidence>,
  fresh: VerificationEvidence,
): string[] {
  const mismatches: string[] = [];
  if (committed.rfcFileHash !== fresh.rfcFileHash) mismatches.push("rfcFileHash");
  if (committed.acceptanceHash !== fresh.acceptanceHash) mismatches.push("acceptanceHash");
  const committedProbes = committed.probes ?? [];
  if (committedProbes.length !== fresh.probes.length) {
    mismatches.push("probes.length");
  } else {
    fresh.probes.forEach((rec, i) => {
      if (committedProbes[i]?.ok !== rec.ok) mismatches.push(`probes[${i}].ok`);
    });
  }
  if (committed.overall !== fresh.overall) mismatches.push("overall");
  return mismatches;
}

export async function runRfcVerificationEmit(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcVerificationEmitResult>> {
  const io = resolveIo(context.io);
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = join(workspaceRoot, RFC_DIR);
  const targetId = input.flags["id"] as string | undefined;
  const checkOnly = input.flags["check"] === true;
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
  if (!dryRun && !checkOnly) await io.mkdir(verificationDirAbs);

  const processFile = async (
    fileName: string,
  ): Promise<{
    emittedEntry?: NonNullable<RfcVerificationEmitResult["emitted"]>[number];
    skippedEntry?: NonNullable<RfcVerificationEmitResult["skipped"]>[number];
    checkEntry?: NonNullable<RfcVerificationEmitResult["check"]>[number];
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

    // RFC-1320: generated-artifact freshness gate runs BEFORE any probe —
    // a probe reading stale bytes proves nothing. EVIDENCE-FRESH-01 skips
    // emission (blocking diagnostic, non-zero exit); EVIDENCE-FRESH-02 only
    // warns.
    const fresh = await freshnessPrecheck(rfcId, probes, context);
    diagnostics.push(...fresh.warnings);
    if (fresh.block) {
      return {
        skippedEntry: {
          rfcId,
          reason:
            fresh.block.ruleId === "EVIDENCE-FRESH-03"
              ? "unknown-probe-kind"
              : "stale-generated-artifact",
        },
        diagnostic: fresh.block,
      };
    }

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
      emittedAt,
    );

    const slug = rfcId.toLowerCase();
    const evidenceFileName = `${slug}.generated.yaml`;
    const evidenceRelPath = join(VERIFICATION_DIR, evidenceFileName);
    const evidenceAbsPath = join(workspaceRoot, evidenceRelPath);

    // RFC-1271 --check: same probe run as emit, but the committed envelope is
    // compared to the fresh computation and nothing is written. A missing
    // envelope is itself a divergence.
    if (checkOnly) {
      let committed: Partial<VerificationEvidence> | null = null;
      try {
        committed = yamlParse(await io.readFile(evidenceAbsPath)) as Partial<VerificationEvidence>;
      } catch {
        // No committed envelope.
      }
      const mismatches =
        committed === null ? ["envelope-missing"] : checkEvidenceEnvelope(committed, envelope);
      return { checkEntry: { rfcId, match: mismatches.length === 0, mismatches } };
    }

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
  const checked: NonNullable<RfcVerificationEmitResult["check"]> = [];
  for (const r of results) {
    if (r.emittedEntry) emitted.push(r.emittedEntry);
    if (r.skippedEntry) skipped.push(r.skippedEntry);
    if (r.checkEntry) checked.push(r.checkEntry);
    if (r.diagnostic) diagnostics.push(r.diagnostic);
  }

  // RFC-1320: a blocking diagnostic (EVIDENCE-FRESH-01/03) means the run
  // failed even when nothing was emitted.
  const hasFailures =
    emitted.some((e) => e.overall === "fail") ||
    checked.some((c) => !c.match) ||
    diagnostics.some((d) => d.severity === "error");
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
      ...(checkOnly ? { check: checked } : {}),
    },
    exitCode: hasFailures ? 1 : 0,
    summary: checkOnly
      ? `rfc.verification.emit --check: ${checked.filter((c) => c.match).length} match, ${checked.filter((c) => !c.match).length} diverged, ${skipped.length} skipped`
      : `rfc.verification.emit: ${emitted.length} emitted, ${skipped.length} skipped${deltaSummary}${dryRun ? ", dry-run" : ""}`,
  };
}
