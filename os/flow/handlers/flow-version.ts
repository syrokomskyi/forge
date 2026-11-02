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
import { git, requireGit, statusTracked, topLevel } from "../git.ts";
import { pendingLevel } from "../release-level.ts";
import {
  discoverReleaseLines,
  readLineVersionFile,
  type ReleaseLine,
} from "../release-lines.ts";
import { listLineTags } from "../release-tags.ts";
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

/** Count commits in `since..<ref>` (or all of <ref> when since is empty) touching `paths`. */
async function commitsSinceRef(
  repoRoot: string,
  since: string,
  paths: string[],
  io: WorkspaceIO,
  ref = "HEAD",
): Promise<number> {
  const range = since === "" ? ref : `${since}..${ref}`;
  const args = ["rev-list", "--count", range];
  if (paths.length > 0) args.push("--", ...paths);
  const result = await git(repoRoot, io, args);
  return result.exitCode === 0 ? Number.parseInt(result.stdout.trim(), 10) || 0 : 0;
}

/** Tracked modifications inside `paths` (empty = whole worktree). */
async function dirtyPaths(
  repoRoot: string,
  paths: string[],
  io: WorkspaceIO,
): Promise<number> {
  const entries = await statusTracked(repoRoot, io);
  if (paths.length === 0) return entries.length;
  return entries.filter((entry) => {
    const file = entry.slice(3).split(" -> ").pop() ?? "";
    return paths.some((p) => file === p || file.startsWith(`${p}/`));
  }).length;
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
  const [tags, currentVersion, dirtyCount] = await Promise.all([
    listLineTags(repoRoot, line, io),
    readLineVersionFile(repoRoot, line, io),
    dirtyPaths(repoRoot, line.paths, io),
  ]);
  const since = tags.lastTag?.name ?? "";
  const commitsSince = await commitsSinceRef(repoRoot, since, line.paths, io);

  if (tags.lastTag === null) {
    diagnostics.push({
      ruleId: "FLOW-VER-01",
      severity: "warning",
      message: `release line '${line.id}' has no reachable baseline tag — run pnpm exec forge flow.install to create it`,
    });
  }

  const dirty = dirtyCount > 0;
  let derived: string | null = null;
  if (tags.lastTag !== null && head !== null) {
    const base =
      commitsSince > 0
        ? `${tags.lastTag.name.slice(line.tagPrefix.length)}+${commitsSince}.${head}`
        : tags.lastTag.name.slice(line.tagPrefix.length);
    derived =
      dirty && commitsSince === 0 ? `${base}+0.${head}.dirty` : dirty ? `${base}.dirty` : base;
  }

  const pending = await pendingLevel(
    line,
    since,
    io,
    repoRoot,
    tags.lastTag?.version ?? null,
  );
  diagnostics.push(...pending.diagnostics);

  return {
    id: line.id,
    tagPrefix: line.tagPrefix,
    versionFile: line.versionFile,
    paths: line.paths,
    currentVersion,
    lastTag: tags.lastTag?.name ?? null,
    lastVersion: tags.lastTag ? tags.lastTag.name.slice(line.tagPrefix.length) : null,
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
