/*
<MODULE_CONTRACT>
<purpose>forge memory.compact — mechanically enforce the MEMORY.md character budget
(RFC-0664) by removing oldest Environment notes bullets until the file fits.
Invoked standalone and by forge doctor --fix for the memory-layer check (RFC-1151).</purpose>
<non-goals>
  <item>Never touch "## Current focus" or "## Decisions in flight" — those need editorial judgment.</item>
  <item>No semantic rewriting — bullets are removed whole, never edited or merged.</item>
  <item>No archiving into daily/ logs — removed content is recoverable via git history.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1151: initial memory.compact — oldest-first Environment notes truncation.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import type { ForgeCommandInput, ForgeCommandResult, ForgeRuntimeContext } from "../types.ts";
import { resolveMemoryBudget } from "./memory-scaffold.ts";

const MEMORY_MD_PATH = path.join(".agents", "memory", "MEMORY.md");
const COMPACT_SECTION = "## Environment notes";
const PROTECTED_SECTIONS = new Set(["## Current focus", "## Decisions in flight"]);

export interface MemoryCompactResult {
  command: "forge.memory.compact";
  status: "pass" | "fail";
  removed: number;
  remainingChars: number;
  budget: number;
  removedLines?: string[];
  errors: string[];
}

interface Section {
  header: string;
  start: number; // line index of the "## ..." header
  end: number; // line index one past the section's last line
}

function parseSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      if (sections.length > 0) sections[sections.length - 1].end = i;
      sections.push({ header: lines[i].trim(), start: i, end: lines.length });
    }
  }
  return sections;
}

function isBullet(line: string): boolean {
  return /^\s*-\s+/.test(line);
}

/**
 * Remove oldest bullets from `## Environment notes` until the file fits the
 * budget. Returns the new line list and the removed bullet lines.
 * Exported for reuse by `forge doctor --fix` (RFC-1151).
 */
export function compactMemoryMd(
  content: string,
  budget: number,
): { lines: string[]; removedLines: string[]; fitsBudget: boolean } {
  if (content.length <= budget) {
    return { lines: content.split("\n"), removedLines: [], fitsBudget: true };
  }

  const lines = content.split("\n");
  const sections = parseSections(lines);
  const target = sections.find((s) => s.header === COMPACT_SECTION);

  const removedLines: string[] = [];
  if (target) {
    // Sanity: never remove from protected sections even if headers drift.
    if (PROTECTED_SECTIONS.has(target.header)) {
      return { lines, removedLines, fitsBudget: false };
    }
    // Remove bullet lines oldest-first (document order) within the section.
    let i = target.start + 1;
    while (i < target.end && lines.join("\n").length > budget) {
      if (isBullet(lines[i])) {
        removedLines.push(lines[i]);
        lines.splice(i, 1);
        target.end--;
        // Recompute section ends after splice — only the target shrinks.
      } else {
        i++;
      }
    }
  }

  const fitsBudget = lines.join("\n").length <= budget;
  return { lines, removedLines, fitsBudget };
}

export async function runMemoryCompact(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<MemoryCompactResult>> {
  const { workspaceRoot, logger, outputFormat, dryRun } = context;
  const memoryPath = path.join(workspaceRoot, MEMORY_MD_PATH);
  const budget = resolveMemoryBudget(workspaceRoot);

  const fail = (msg: string): ForgeCommandResult<MemoryCompactResult> => ({
    data: {
      command: "forge.memory.compact",
      status: "fail",
      removed: 0,
      remainingChars: 0,
      budget,
      errors: [msg],
    },
    exitCode: 1,
    summary: `forge.memory.compact: failed — ${msg}`,
  });

  if (!fs.existsSync(memoryPath)) {
    return {
      data: {
        command: "forge.memory.compact",
        status: "pass",
        removed: 0,
        remainingChars: 0,
        budget,
        errors: [],
      },
      exitCode: 0,
      summary: "forge.memory.compact: OK — MEMORY.md absent, nothing to compact",
    };
  }

  const content = fs.readFileSync(memoryPath, "utf8");
  if (content.length <= budget) {
    return {
      data: {
        command: "forge.memory.compact",
        status: "pass",
        removed: 0,
        remainingChars: content.length,
        budget,
        errors: [],
      },
      exitCode: 0,
      summary: `forge.memory.compact: OK — already within budget (${content.length}/${budget} chars)`,
    };
  }

  const { lines, removedLines, fitsBudget } = compactMemoryMd(content, budget);
  const remainingChars = lines.join("\n").length;

  if (!fitsBudget) {
    return fail(
      `still over budget after removing ${removedLines.length} Environment notes bullet(s) ` +
        `(${remainingChars}/${budget} chars) — manual editorial compaction required`,
    );
  }

  if (!dryRun) {
    fs.writeFileSync(memoryPath, lines.join("\n"), "utf8");
  }

  if (outputFormat === "pretty") {
    for (const line of removedLines) {
      logger.info(`removed: ${line.slice(0, 80)}`);
    }
    logger.success(
      `${dryRun ? "[dry-run] would remove" : "removed"} ${removedLines.length} bullet(s) — ${remainingChars}/${budget} chars`,
    );
  }

  return {
    data: {
      command: "forge.memory.compact",
      status: "pass",
      removed: removedLines.length,
      remainingChars,
      budget,
      removedLines: dryRun ? removedLines : undefined,
      errors: [],
    },
    exitCode: 0,
    summary: dryRun
      ? `forge.memory.compact: [dry-run] would remove ${removedLines.length} bullet(s) — ${remainingChars}/${budget} chars`
      : `forge.memory.compact: OK — removed ${removedLines.length} bullet(s), ${remainingChars}/${budget} chars`,
  };
}
