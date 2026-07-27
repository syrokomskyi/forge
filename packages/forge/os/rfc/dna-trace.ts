/*
<MODULE_CONTRACT>
<purpose>
RFC-0331: DNA-trace builder, validate command, and generate command.
Parses DNA invariants from docs/architecture-dna.md, collects satisfies
entries from all RFCs, and builds a bidirectional trace matrix.
</purpose>
<non-goals>
  <item>Do not validate registry establishment — that is dna.registry.validate (RFC-0158).</item>
  <item>Do not backfill satisfies for pre-cutoff RFCs.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0331: initial implementation.</item>
</CHANGE_SUMMARY>
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "../../src/utils/fs-atomic.ts";
import { GENERATED_MARKER, buildGeneratedHeader } from "../../src/utils/generated-marker.ts";
import { stringify as yamlStringify } from "yaml";
import { listRfcFiles, readAndParseRfc } from "./frontmatter-io.ts";
import { RFC_DIR } from "./types.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";

const DNA_REGISTRY_PATH = "docs/architecture-dna.md";
const DNA_HEADING_RE = /^##\s+DNA-(\d+)\b/gm;

export interface DnaTraceEntry {
  dnaId: string;
  satisfiedBy: {
    implemented: string[];
    accepted: string[];
    draft: string[];
    other: string[];
  };
}

export interface DnaTraceResult {
  command: "rfc.dna.trace.validate";
  status: "pass" | "fail";
  dnaCount: number;
  tracedDnaCount: number;
  entries: DnaTraceEntry[];
  diagnostics: Diagnostic[];
  written?: string;
}

async function parseDnaRegistry(workspaceRoot: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const src = await readFile(join(workspaceRoot, DNA_REGISTRY_PATH), "utf-8");
    for (const m of src.matchAll(DNA_HEADING_RE)) {
      ids.add(`DNA-${m[1]}`);
    }
  } catch {
    // handled by caller
  }
  return ids;
}

interface RfcSatisfiesEntry {
  rfcId: string;
  status: string;
  satisfies: string[];
}

async function collectSatisfies(workspaceRoot: string): Promise<RfcSatisfiesEntry[]> {
  const rfcDirPath = join(workspaceRoot, RFC_DIR);
  const files = await listRfcFiles(rfcDirPath);
  const entries: RfcSatisfiesEntry[] = [];
  for (const fileName of files) {
    const result = await readAndParseRfc(rfcDirPath, fileName);
    if (!result) continue;
    const fm = result.parsed.frontmatter;
    const rfcId = String(fm["id"] ?? "");
    const status = String(fm["status"] ?? "");
    const satisfies = Array.isArray(fm["satisfies"])
      ? (fm["satisfies"] as unknown[]).map(String)
      : [];
    if (satisfies.length > 0) {
      entries.push({ rfcId, status, satisfies });
    }
  }
  return entries;
}

export async function buildDnaTrace(
  workspaceRoot: string,
): Promise<{ entries: DnaTraceEntry[]; diagnostics: Diagnostic[]; registryIds: Set<string> }> {
  const registryIds = await parseDnaRegistry(workspaceRoot);
  const rfcEntries = await collectSatisfies(workspaceRoot);
  const diagnostics: Diagnostic[] = [];

  if (registryIds.size === 0) {
    diagnostics.push({
      ruleId: "DNA-TRACE-00",
      severity: "error",
      file: DNA_REGISTRY_PATH,
      message: `DNA registry not found or unreadable at ${DNA_REGISTRY_PATH}.`,
    });
  }

  // Build entries for every registry DNA id
  const entries: DnaTraceEntry[] = [];
  for (const dnaId of [...registryIds].sort()) {
    const satisfiedBy = {
      implemented: [] as string[],
      accepted: [] as string[],
      draft: [] as string[],
      other: [] as string[],
    };
    for (const rfc of rfcEntries) {
      if (!rfc.satisfies.includes(dnaId)) continue;
      switch (rfc.status) {
        case "implemented":
          satisfiedBy.implemented.push(rfc.rfcId);
          break;
        case "accepted":
          satisfiedBy.accepted.push(rfc.rfcId);
          break;
        case "draft":
        case "reviewing":
          satisfiedBy.draft.push(rfc.rfcId);
          break;
        default:
          satisfiedBy.other.push(rfc.rfcId);
          break;
      }
    }
    entries.push({ dnaId, satisfiedBy });
  }

  // DNA-TRACE-01: satisfies entry references a DNA id absent from the registry
  for (const rfc of rfcEntries) {
    for (const id of rfc.satisfies) {
      if (!/^DNA-\d+$/.test(id)) continue; // V-24 handles format
      if (!registryIds.has(id)) {
        diagnostics.push({
          ruleId: "DNA-TRACE-01",
          severity: "error",
          message: `${rfc.rfcId} satisfies "${id}" but this DNA id is not in the registry (${DNA_REGISTRY_PATH}).`,
        });
      }
    }
  }

  // DNA-TRACE-02: DNA invariant with zero accepted/implemented satisfiers
  for (const entry of entries) {
    const hasCoverage =
      entry.satisfiedBy.implemented.length > 0 || entry.satisfiedBy.accepted.length > 0;
    if (!hasCoverage) {
      diagnostics.push({
        ruleId: "DNA-TRACE-02",
        severity: "info",
        file: DNA_REGISTRY_PATH,
        message: `${entry.dnaId} has no accepted/implemented RFC referencing it via satisfies (historical RFCs are exempt).`,
      });
    }
  }

  // DNA-TRACE-03: satisfies on a rejected RFC
  for (const rfc of rfcEntries) {
    if (rfc.status === "rejected") {
      for (const id of rfc.satisfies) {
        diagnostics.push({
          ruleId: "DNA-TRACE-03",
          severity: "warning",
          message: `${rfc.rfcId} (status: rejected) still declares satisfies "${id}" — a rejected RFC satisfies nothing; the claim is stale.`,
        });
      }
    }
  }

  return { entries, diagnostics, registryIds };
}

export async function runRfcDnaTraceValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<DnaTraceResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const dnaFilter = input.flags["dna"] as string | undefined;

  const { entries, diagnostics, registryIds } = await buildDnaTrace(workspaceRoot);

  let filteredEntries = entries;
  if (dnaFilter) {
    filteredEntries = entries.filter((e) => e.dnaId === dnaFilter);
    if (filteredEntries.length === 0) {
      diagnostics.push({
        ruleId: "DNA-TRACE-INFO",
        severity: "info",
        message: `--dna ${dnaFilter} matched no registry entries.`,
      });
    }
  }

  const tracedDnaCount = entries.filter(
    (e) => e.satisfiedBy.implemented.length > 0 || e.satisfiedBy.accepted.length > 0,
  ).length;

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  const status: DnaTraceResult["status"] = hasErrors ? "fail" : "pass";

  if (outputFormat === "pretty") {
    logger.section(`DNA trace (${registryIds.size} invariants, ${tracedDnaCount} traced)`);
    for (const entry of filteredEntries) {
      const impl = entry.satisfiedBy.implemented.join(", ");
      const acc = entry.satisfiedBy.accepted.join(", ");
      logger.info(`${entry.dnaId}: implemented=[${impl}] accepted=[${acc}]`);
    }
    for (const d of diagnostics) {
      if (d.severity === "error") logger.error(`[${d.ruleId}] ${d.message}`);
      else if (d.severity === "warning") logger.warn(`[${d.ruleId}] ${d.message}`);
    }
  }

  return {
    data: {
      command: "rfc.dna.trace.validate",
      status,
      dnaCount: registryIds.size,
      tracedDnaCount,
      entries: filteredEntries,
      diagnostics,
    },
    exitCode: hasErrors ? 1 : 0,
    summary: `rfc.dna.trace.validate: ${registryIds.size} DNA invariants, ${tracedDnaCount} traced, ${diagnostics.filter((d) => d.severity === "error").length} error(s)`,
  };
}

export async function runRfcDnaTraceGenerate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<DnaTraceResult>> {
  const { workspaceRoot, logger, outputFormat } = context;

  const { entries, diagnostics, registryIds } = await buildDnaTrace(workspaceRoot);

  const tracedDnaCount = entries.filter(
    (e) => e.satisfiedBy.implemented.length > 0 || e.satisfiedBy.accepted.length > 0,
  ).length;

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  const status: DnaTraceResult["status"] = hasErrors ? "fail" : "pass";

  const outRel = join(RFC_DIR, "dna-trace.generated.yaml");
  const payload: DnaTraceResult = {
    command: "rfc.dna.trace.validate",
    status,
    dnaCount: registryIds.size,
    tracedDnaCount,
    entries,
    diagnostics,
    written: outRel,
  };
  const jsonContent = `${buildGeneratedHeader({ filePath: outRel, ownerCommand: "rfc.dna.trace.generate" })}${yamlStringify({ ...payload })}\n`;
  await writeFileAtomic(join(workspaceRoot, outRel), jsonContent);

  if (outputFormat === "pretty") {
    logger.section(
      `DNA trace generated (${registryIds.size} invariants, ${tracedDnaCount} traced)`,
    );
    logger.success(`Wrote ${outRel}`);
  }

  return {
    data: payload,
    exitCode: hasErrors ? 1 : 0,
    summary: `rfc.dna.trace.generate: wrote ${outRel} (${registryIds.size} DNA, ${tracedDnaCount} traced)`,
  };
}
