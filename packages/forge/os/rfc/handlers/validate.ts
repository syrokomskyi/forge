/*
<MODULE_CONTRACT>
<purpose>RFC validation handler — V-01..V-22 frontmatter, section, and referential integrity checks.</purpose>
<non-goals>
  <item>Do not introduce app-specific runtime composition or deployment behavior into this reusable package source file.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
  <item>KERNEL-FLAG-02: Guard --id against non-string values (boolean/array from unvalidated flag input) — throws a clear flag error instead of TypeError in rfcFileMatchesId.</item>
  <item>RFC-1467: block rfc.create on terminal-kind near-duplicates until --revisit acknowledges + V-52 validate mirror</item>
  <item>RFC-1489: batch test probes through one instrumented Vitest run + frontmatter corpus reads

runProbeSet is the single shared execution point: barrier-free segments of test probes sharing one effective bound run in one vitest --reporter=json --outputFile process with per-(file,testName) attribution; missing files/reports yield unverified. run/page/proof and all non-test kinds are barriers. --no-batch escapes to the legacy path on acceptance.run, verification.emit and verification.refresh. rfc.validate reads non-target corpus files frontmatter-only via readRfcFrontmatter (64 KiB bound, full-parse fallback); emit/refresh/acceptance corpus scans use the same accessor. Corpus map slimmed to RfcCorpusEntry {fileName, frontmatter}.</item>
  <item>RFC-1513: steps 2-4 — batched committed-review reads + run-scoped index

OriginGit gains optional showMany backed by one git cat-file --batch
process (per-spec null on missing objects, wholesale null on spawn or
framing failure). collectCommittedReviews prefers it and keeps the
sequential show loop for stubs. rfc.validate memoizes the index once
per run and V-49 consumes it — identical diagnostics, one batched read.</item>
  <history>RFC-0303, RFC-1097</history>
</CHANGE_SUMMARY>
*/

import path from "node:path";

import {
  listRfcFiles,
  readAndParseRfc,
  readRfcFrontmatter,
  rfcFileMatchesId,
  type ParsedRfc,
  type RfcCorpusEntry,
} from "../frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import type {
  RfcValidationViolation,
  RfcValidationResult,
  Marker,
  ProbeCoverageReport,
} from "../types.ts";
import { RFC_DIR, RFC_KNOWN_KEYS, RFC_PROBE_BINDING_CUTOFF } from "../types.ts";
import { DNA_DOCS, AP_DOCS, loadInvariantIds } from "./shared.ts";
import { collectRfcCommandLifecycleViolations } from "./lifecycle.ts";
import { evaluateAcceptanceCriteria, computeProbeCoverage } from "./validate-rules.ts";
import { validateSingleRfc, checkFrontmatterYamlParse } from "./validate-rules.ts";
import { collectDecisionLog } from "../decision-log.ts";
import { collectCommittedReviews } from "./implement-stamp-deviations.ts";
import { createOriginGit } from "../verification-origin.ts";
import { loadForgeConfig } from "../../../src/config/forge-config.ts";

export async function runRfcValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcValidationResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);

  const rawId = input.flags["id"];
  if (rawId !== undefined && typeof rawId !== "string") {
    throw new Error(`Flag "--id" for command "rfc.validate" requires a single string value.`);
  }
  const targetId = rawId as string | undefined;

  const allFiles = await listRfcFiles(rfcDirPath);
  const filesToValidate = targetId
    ? allFiles.filter((f) => rfcFileMatchesId(f, targetId))
    : allFiles;

  if (filesToValidate.length === 0) {
    if (targetId) {
      throw new Error(`No RFC file found for id ${targetId} in ${RFC_DIR}/`);
    }
    logger.info("No RFC files found to validate.");
    return {
      data: { command: "rfc.validate", status: "pass", count: 0, violations: [], markers: [] },
      summary: "No RFC files found to validate",
    };
  }

  // RFC-1489: the corpus map carries frontmatter only — referential rules never
  // read non-target bodies. Full `parsed` (with body) exists only for targets.
  const allParsed: Map<string, RfcCorpusEntry> = new Map();
  const allParsedByFile: Map<string, { fileName: string; parsed: ParsedRfc }> = new Map();

  const violations: RfcValidationViolation[] = [];
  const allMarkers: Marker[] = [];
  const coverage: Array<{ rfcId: string; report: ProbeCoverageReport }> = [];

  function addViolation(
    rfcId: string,
    file: string,
    rule: string,
    message: string,
    severity: "error" | "warning" = "error",
  ): void {
    violations.push({ rfcId, file, rule, message, severity });
  }

  const targetSet = new Set(filesToValidate);
  for (const f of allFiles) {
    const result = targetSet.has(f)
      ? await readAndParseRfc(rfcDirPath, f)
      : await readRfcFrontmatter(rfcDirPath, f);
    if (result) {
      if ("error" in result) {
        checkFrontmatterYamlParse(f, result, addViolation);
        continue;
      }
      const id = String(result.parsed.frontmatter["id"] ?? "");
      allParsed.set(id, { fileName: f, frontmatter: result.parsed.frontmatter });
      if (targetSet.has(f)) {
        allParsedByFile.set(f, { fileName: f, parsed: result.parsed });
      }
    }
  }

  const validDnaIds = await loadInvariantIds(workspaceRoot, DNA_DOCS, "DNA");
  const validApIds = await loadInvariantIds(workspaceRoot, AP_DOCS, "AP");
  const knownKeys = new Set<string>(RFC_KNOWN_KEYS);

  const seenIds = new Map<string, string>();
  const seenFilenameNumbers = new Map<number, string>();

  // RFC-1467 V-52: the decision log is collected once per validate run —
  // the getter memoizes so a multi-draft run pays the collection cost once.
  let decisionLogPromise: Promise<Awaited<ReturnType<typeof collectDecisionLog>>> | undefined;
  const decisionLog = () => {
    decisionLogPromise ??= collectDecisionLog(rfcDirPath);
    return decisionLogPromise;
  };

  // RFC-1513: the committed-review index builds at most once per validate run
  // — the getter memoizes so every `## Deviations`-carrying RFC shares one
  // batched read instead of paying per-file `git show` calls (V-49).
  let committedReviewsPromise:
    | Promise<Awaited<ReturnType<typeof collectCommittedReviews>>>
    | undefined;
  const committedReviews = () => {
    committedReviewsPromise ??= (async () => {
      let reviewsDir: string | null = null;
      try {
        reviewsDir = loadForgeConfig(workspaceRoot).bindings?.paths?.reviewsDir ?? null;
      } catch {
        // forge.yaml unreadable → no committed-report index → entries dangle.
      }
      return collectCommittedReviews(createOriginGit(workspaceRoot), reviewsDir);
    })();
    return committedReviewsPromise;
  };

  for (const fileName of filesToValidate) {
    const result = allParsedByFile.get(fileName);
    if (!result) continue;

    const markers = await validateSingleRfc(
      fileName,
      result.parsed,
      allParsed,
      seenIds,
      validDnaIds,
      validApIds,
      knownKeys,
      workspaceRoot,
      addViolation,
      seenFilenameNumbers,
      decisionLog,
      committedReviews,
    );
    allMarkers.push(...markers);

    const fm = result.parsed.frontmatter;
    const rfcId = String(fm["id"] ?? "");
    const createdAt = String(fm["createdAt"] ?? "");
    const isArchived = fileName.startsWith("archive/");
    if (createdAt >= RFC_PROBE_BINDING_CUTOFF && !isArchived) {
      const criteriaEval = evaluateAcceptanceCriteria(result.parsed.body);
      const report = computeProbeCoverage(criteriaEval.criterionIds, fm["acceptance"]);
      coverage.push({ rfcId, report });
    }
  }

  const lifecycle = await collectRfcCommandLifecycleViolations(
    workspaceRoot,
    filesToValidate,
    allParsedByFile,
    context.commandRegistry,
  );
  for (const violation of lifecycle.violations) {
    addViolation(
      violation.rfcId,
      violation.file,
      violation.rule,
      violation.message,
      violation.severity,
    );
  }

  const hasErrors = violations.some((v) => v.severity === "error");
  const resultStatus = hasErrors ? "fail" : "pass";

  if (outputFormat === "pretty") {
    if (violations.length === 0) {
      logger.success(`All ${filesToValidate.length} RFC(s) passed validation.`);
    } else {
      logger.section(`RFC Validation (${filesToValidate.length} file(s))`);
      for (const v of violations) {
        const prefix = v.severity === "error" ? "ERROR" : "WARN";
        logger[v.severity === "error" ? "error" : "warn"](
          `[${prefix}] ${v.rfcId} ${v.rule}: ${v.message}`,
        );
      }
      const errorCount = violations.filter((v) => v.severity === "error").length;
      const warnCount = violations.filter((v) => v.severity === "warning").length;
      const parts: string[] = [];
      if (errorCount > 0) parts.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
      if (warnCount > 0) parts.push(`${warnCount} warning${warnCount === 1 ? "" : "s"}`);
      const counts = parts.join(", ");
      if (errorCount > 0) {
        logger.error(counts);
      } else {
        logger.warn(`${counts} — passed`);
      }
    }
  }

  return {
    data: {
      command: "rfc.validate",
      status: resultStatus,
      count: filesToValidate.length,
      violations,
      markers: allMarkers,
      coverage: coverage.length > 0 ? coverage : undefined,
    },
    exitCode: hasErrors ? 1 : 0,
    summary: hasErrors
      ? `${violations.filter((v) => v.severity === "error").length} error${violations.filter((v) => v.severity === "error").length === 1 ? "" : "s"} found`
      : `All ${filesToValidate.length} RFC(s) passed validation`,
    nextSteps: hasErrors
      ? [
          {
            action: `Fix the ${violations.filter((v) => v.severity === "error").length} error${violations.filter((v) => v.severity === "error").length === 1 ? "" : "s"} above, then re-run: pnpm exec forge run rfc.validate`,
            kind: "required",
          },
        ]
      : undefined,
  };
}
