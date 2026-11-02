/*
<MODULE_CONTRACT>
<purpose>flow.version — the read-only release-line report (RFC-1488). For
every discovered line (or the one named by --line) it reports the last
reachable annotated tag, the version file's current value, commits since the
tag, the derived version `X.Y.Z+N.&lt;head9&gt;` (`.dirty` when the line's
paths carry tracked modifications) and the pending level computed from
X-RFC trailers. Diagnostics: FLOW-VER-01 (no baseline tag), FLOW-VER-02
(basename collision), FLOW-VER-03 (unreadable RFC), FLOW-VER-04 (unknown
--line).</purpose>
<non-goals>
  <item>No writes, ever — the command is read-only; only flow.install (baseline) and the wave-2 cut create tags.</item>
  <item>No release decision — flow.cut (wave 2) consumes this report.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Derived version is anchored to the last tag, never the version file — the file is a release-time write and diverging is a FLOW-08 finding, not a second anchor.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1488: step 4 — flow.version handler</item>
  <item>RFC-1488: steps 2-4 — release tags, pending level (X-RFC + versionBump), flow.version command</item>
  <item>RFC-1490: step 1 — explicit ref param on tag/level helpers + W1-2 +0.<hash>.dirty shape (AC-12)</item>
  <item>RFC-1493: step 1 — forge public release-line version reader</item>
</CHANGE_SUMMARY>
*/

import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  WorkspaceIO,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import { git, requireGit, topLevel } from "../git.ts";
import { deriveLineVersion } from "../line-version.ts";
import { pendingLevel } from "../release-level.ts";
import {
  discoverReleaseLines,
  readLineVersionFile,
  type ReleaseLine,
} from "../release-lines.ts";
import type { ReleaseLevel } from "../semver.ts";

export interface FlowVersionLineReport {
  id: string;
  tagPrefix: string;
  versionFile: string | null;
  paths: string[];
  /** `version` currently in the line's version file; null when absent/unreadable. */
  currentVersion: string | null;
  lastTag: string | null;
  lastVersion: string | null;
  commitsSince: number;
  head: string | null;
  dirty: boolean;
  derived: string | null;
  level: ReleaseLevel;
  rfcs: Array<{ id: string; versionBump: string | null }>;
  nextVersion: string | null;
}

export interface FlowVersionData {
  lines: FlowVersionLineReport[];
  shallow: boolean;
}

export interface FlowVersionOutcome {
  data: FlowVersionData;
  diagnostics: Diagnostic[];
}

/**
 * Build the flow.version report over `repoRoot`. Purely read-only; every
 * diagnostic a caller needs to surface comes back in `diagnostics`.
 */
export async function collectFlowVersion(
  repoRoot: string,
  io: WorkspaceIO,
  onlyLine: string | null,
): Promise<FlowVersionOutcome> {
  const diagnostics: Diagnostic[] = [];
  const { lines, diagnostics: discoveryDiagnostics } = await discoverReleaseLines(repoRoot, io);
  diagnostics.push(...discoveryDiagnostics);

  const selected =
    onlyLine === null ? lines : lines.filter((line) => line.id === onlyLine);
  if (onlyLine !== null && selected.length === 0) {
    diagnostics.push({
      ruleId: "FLOW-VER-04",
      severity: "error",
      message: `unknown release line '${onlyLine}' — known lines: ${lines.map((l) => l.id).join(", ")}`,
    });
    return { data: { lines: [], shallow: false }, diagnostics };
  }

  const headResult = await git(repoRoot, io, ["rev-parse", "--short=9", "HEAD"]); // flow.version reports HEAD only
  const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
  const shallowResult = await git(repoRoot, io, ["rev-parse", "--is-shallow-repository"]);
  const shallow = shallowResult.exitCode === 0 && shallowResult.stdout.trim() === "true";

  const reports: FlowVersionLineReport[] = [];
  for (const line of selected) {
    reports.push(await buildLineReport(repoRoot, line, head, io, diagnostics));
  }
  return { data: { lines: reports, shallow }, diagnostics };
}

async function buildLineReport(
  repoRoot: string,
  line: ReleaseLine,
  head: string | null,
  io: WorkspaceIO,
  diagnostics: Diagnostic[],
): Promise<FlowVersionLineReport> {
  const derived_ = await deriveLineVersion(repoRoot, line, io);
  const currentVersion = await readLineVersionFile(repoRoot, line, io);
  const since = derived_.lastTag?.name ?? "";

  if (derived_.lastTag === null) {
    diagnostics.push({
      ruleId: "FLOW-VER-01",
      severity: "warning",
      message: `release line '${line.id}' has no reachable baseline tag — run pnpm exec forge flow.install to create it`,
    });
  }

  const { commitsSince, dirty } = derived_;
  const derived = derived_.source === "release-tag" && head !== null ? derived_.version : null;

  const pending = await pendingLevel(
    line,
    since,
    io,
    repoRoot,
    derived_.lastTag?.version ?? null,
  );
  diagnostics.push(...pending.diagnostics);

  return {
    id: line.id,
    tagPrefix: line.tagPrefix,
    versionFile: line.versionFile,
    paths: line.paths,
    currentVersion,
    lastTag: derived_.lastTag?.name ?? null,
    lastVersion: derived_.lastTag
      ? derived_.lastTag.name.slice(line.tagPrefix.length)
      : null,
    commitsSince,
    head,
    dirty,
    derived,
    level: pending.level,
    rfcs: pending.rfcs,
    nextVersion: pending.nextVersion,
  };
}

export async function runFlowVersion(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowVersionData & { diagnostics: Diagnostic[] }>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.version must run inside a git repository");
  }

  const onlyLine = typeof input.flags["line"] === "string" ? input.flags["line"] : null;
  const { data, diagnostics } = await collectFlowVersion(repoRoot, io, onlyLine);
  const errors = diagnostics.filter((d) => d.severity === "error");

  if (outputFormat === "pretty") {
    logger.section("Flow version");
    for (const line of data.lines) {
      logger.info(
        `  ${line.id}: ${line.derived ?? "(untagged)"} — level ${line.level}` +
          (line.nextVersion !== null ? ` → ${line.nextVersion}` : ""),
      );
    }
    for (const d of diagnostics) {
      if (d.severity === "error") logger.error(`  ${d.ruleId}: ${d.message}`);
      else logger.warn(`  ${d.ruleId}: ${d.message}`);
    }
  }

  return {
    data: { ...data, diagnostics },
    exitCode: errors.length > 0 ? 1 : 0,
    summary: `[flow.version] ${data.lines.length} line(s) — ${errors.length} error(s)`,
  };
}
