/*
<MODULE_CONTRACT>
<purpose>docs.archive owner-regeneration (RFC-1528) — collect the generated artifacts
invalidated by archive moves and re-invoke their owner commands through
context.invoke. Owner selection is registry-driven: a command owns a generated
artifact when it declares it via generates[].path, or via a writes[] entry that
resolves to a generated file (marker, .generated. infix, or command:/generatedAt:
header convention — index.yaml/ecosystem.generated.yaml carry no GENERATED_MARKER
line). Manifest-generation logic itself is never duplicated here.</purpose>
<non-goals>
  <item>No generation logic — owners are invoked by name through the kernel port.</item>
  <item>Standalone forge CLI has no invoke port — degrade with a note, never block.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1528: initial — collectInvalidatedGenerators, generated-path probe, runArchiveRegen.</item>
  <item>RFC-1528: docs.archive regenerates invalidated generated artifacts

After moves, invoke owner commands whose reads[] match a moved path via context.invoke (manifest generator last); report regenerated paths; degrade with a note without a kernel host.</item>
</CHANGE_SUMMARY>
*/

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { hasGeneratedMarker } from "../../src/utils/generated-marker.ts";
import type {
  ForgeFlagValue,
  ForgeRegisteredCommandInfo,
  ForgeRuntimeContext,
} from "../../src/types.ts";

/** Per-owner flag overrides — generator commands that persist only under a flag. */
export const REGEN_FLAGS: Record<string, Record<string, ForgeFlagValue>> = {
  "rfc.index.generate": { write: true },
};

/**
 * Ordering contract: ecosystem.manifest.generate hashes the other generated
 * artifacts, so it always runs last among the invalidated owners.
 */
const MANIFEST_GENERATOR = "ecosystem.manifest.generate";

/** The invoking command can never be its own regen owner. */
const SELF_COMMAND = "docs.archive";

export interface ArchiveRegenCandidate {
  command: string;
  flags: Record<string, ForgeFlagValue>;
  artifactPaths: string[];
}

export interface ArchiveRegenOutcome {
  /** Workspace-relative paths owner invokes reported as modified. */
  regenerated: string[];
  /** Owner commands invoked. */
  invoked: string[];
  /** Candidate owners skipped because context.invoke is absent. */
  skipped: string[];
  /** Per-owner failures — reported, never fatal to the archive run. */
  failures: Array<{ command: string; error: string }>;
  /** True when no command registry was available to derive ownership from. */
  noRegistry: boolean;
}

/** Generated-by-name: the `.generated.` infix convention (ecosystem.generated.yaml). */
export function isGeneratedPathName(relPath: string): boolean {
  return path.basename(relPath).includes(".generated.");
}

/**
 * Generated-by-content: GENERATED_MARKER/EDITABLE_GENERATED_MARKER, or the
 * self-describing YAML header (`command:` + `generatedAt:`) emitted by the
 * manifest family of generators (docs/rfcs/index.yaml carries no marker line).
 */
export function isGeneratedContent(content: string): boolean {
  if (hasGeneratedMarker(content)) return true;
  const head = content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, 10);
  return (
    head.some((line) => /^command:\s*\S/.test(line)) &&
    head.some((line) => /^generatedAt:/.test(line))
  );
}

/** Workspace-backed probe for declared writes[] paths. */
export function generatedPathProbe(workspaceRoot: string): (relPath: string) => boolean {
  return (relPath) => {
    if (isGeneratedPathName(relPath)) return true;
    if (relPath.includes("*")) return false;
    const abs = path.join(workspaceRoot, relPath);
    if (!existsSync(abs)) return false;
    try {
      return isGeneratedContent(readFileSync(abs, "utf8"));
    } catch {
      return false;
    }
  };
}

/**
 * Pure selection: owners whose declared generated artifacts are invalidated by
 * the moved paths — i.e. the command reads at least one glob matching a moved
 * from/to path. Order: registry order with ecosystem.manifest.generate last.
 */
export function collectInvalidatedGenerators(
  movedPaths: string[],
  commands: ForgeRegisteredCommandInfo[],
  isGeneratedPath: (relPath: string) => boolean,
): ArchiveRegenCandidate[] {
  const candidates: ArchiveRegenCandidate[] = [];
  for (const command of commands) {
    if (command.name === SELF_COMMAND) continue;
    const artifactPaths = [
      ...(command.generates ?? []).map((g) => g.path),
      ...(command.writes ?? []).filter((w) => isGeneratedPath(w)),
    ];
    if (artifactPaths.length === 0) continue;
    const reads = command.reads ?? [];
    const invalidated = movedPaths.some((moved) =>
      reads.some((glob) => picomatch.isMatch(moved, glob)),
    );
    if (!invalidated) continue;
    candidates.push({
      command: command.name,
      flags: REGEN_FLAGS[command.name] ?? {},
      artifactPaths,
    });
  }
  return candidates.sort((a, b) => {
    if (a.command === MANIFEST_GENERATOR) return 1;
    if (b.command === MANIFEST_GENERATOR) return -1;
    return 0;
  });
}

/**
 * Invoke seam: run each invalidated owner through context.invoke. Absent invoke
 * (standalone forge CLI) → all candidates skipped with a note, never a crash.
 */
export async function runArchiveRegen(options: {
  movedPaths: string[];
  context: ForgeRuntimeContext;
  isGeneratedPath?: (relPath: string) => boolean;
}): Promise<ArchiveRegenOutcome> {
  const { movedPaths, context } = options;
  const commands = context.commandRegistry?.listCommands() ?? [];
  const probe = options.isGeneratedPath ?? generatedPathProbe(context.workspaceRoot);
  const candidates = collectInvalidatedGenerators(movedPaths, commands, probe);
  const outcome: ArchiveRegenOutcome = {
    regenerated: [],
    invoked: [],
    skipped: [],
    failures: [],
    noRegistry: !context.commandRegistry,
  };

  if (outcome.noRegistry || !context.invoke) {
    outcome.skipped = candidates.map((c) => c.command);
    return outcome;
  }

  for (const candidate of candidates) {
    try {
      const result = await context.invoke(candidate.command, candidate.flags);
      if (result.ok === false || (result.exitCode !== undefined && result.exitCode !== 0)) {
        outcome.failures.push({
          command: candidate.command,
          error: result.summary ?? `exit code ${result.exitCode}`,
        });
        continue;
      }
      outcome.invoked.push(candidate.command);
      // Prefer the child's reported writes; fall back to the invalidated
      // declared paths so `regenerated` always names what refreshed (AC-7).
      const reported =
        result.filesModified && result.filesModified.length > 0
          ? result.filesModified
          : candidate.artifactPaths.filter((p) => !p.includes("*"));
      for (const modified of reported) {
        if (!outcome.regenerated.includes(modified)) outcome.regenerated.push(modified);
      }
    } catch (error) {
      outcome.failures.push({
        command: candidate.command,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcome;
}
