/*
<MODULE_CONTRACT>
<purpose>compass.header.scaffold kernel handler (RFC-1318). Resolves scan root
and policy, walks the coverage surface (or an explicit --files set), computes
per-file scaffold dispositions through the pure codemod, enforces the
dirty-target refusal before any write, and reports census/apply manifests.</purpose>
<non-goals>
  <item>Do not implement transform logic — that lives in compass-header-scaffold.ts.</item>
  <item>Do not perform a dry-run mode — --census IS the writeless interception mode (Q-20).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1318: add compass.header.scaffold codemod for mechanical header sweeps</item>
</CHANGE_SUMMARY>
*/

import { ambientIo } from "../../../src/utils/io.ts";
import { writeFileIfChanged } from "../../../src/utils/fs-idempotent.ts";
import { relative, resolve } from "node:path";
import {
  createCompassInventoryEntries,
  detectAuthoringStatus,
  detectRiskClass,
  getEntrySource,
  getRelativeSegments,
  getWorkspaceRelativeSegments,
  type CompassInventoryEntry,
} from "./compass-inventory.ts";
import {
  explicitWorkspaceRelativePath,
  scaffoldFile,
  type ScaffoldDisposition,
  type ScaffoldFileInput,
  type ScaffoldFileResult,
} from "./compass-header-scaffold.ts";
import { DIRTY_LIST_CAP, isDirtyPath, listDirtyPaths } from "./git-revision.ts";
import { resolveCompassScanRoot } from "./resolve-scan-root.ts";
import { resolveCompassPolicy } from "../policy.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const io = ambientIo;

export interface ScaffoldFileReport extends ScaffoldFileResult {
  path: string;
  workspaceName: string;
}

export interface ScaffoldRunResult {
  mode: "census" | "apply";
  scanned: number;
  files: ScaffoldFileReport[];
  byPackage: Record<string, Partial<Record<ScaffoldDisposition, number>>>;
}

interface ScaffoldTarget {
  absPath: string;
  pathFromRoot: string;
  workspaceRelativePath: string;
  workspaceName: string;
  skipReason?: string;
  input?: ScaffoldFileInput;
}

function detectWorkspaceName(
  segments: string[],
  policy: ReturnType<typeof resolveCompassPolicy>,
): string {
  if (segments[0] !== undefined && segments[0] in policy.workspaceKinds) {
    return segments[1] ?? "unknown";
  }
  return "root";
}

async function explicitTarget(
  workspaceRoot: string,
  baseRoot: string,
  file: string,
  policy: ReturnType<typeof resolveCompassPolicy>,
  leafRoot?: string,
): Promise<ScaffoldTarget | undefined> {
  const absPath = resolve(baseRoot, file);
  let source: string;
  try {
    source = await io.readFile(absPath);
  } catch {
    return {
      absPath,
      pathFromRoot: file,
      workspaceRelativePath: file,
      workspaceName: "(unknown)",
      skipReason: "unreadable",
    };
  }
  const pathFromRoot = relative(workspaceRoot, absPath).replace(/\\/g, "/");
  const workspaceRelativePath = leafRoot
    ? relative(leafRoot, absPath).replace(/\\/g, "/")
    : explicitWorkspaceRelativePath(absPath, workspaceRoot, policy);
  const segments = getRelativeSegments(absPath, workspaceRoot);
  const { authoringStatus, exclusionReason } = detectAuthoringStatus(
    segments,
    workspaceRelativePath,
    source,
    policy,
  );
  const workspaceName = detectWorkspaceName(segments, policy);
  if (authoringStatus === "excluded") {
    return {
      absPath,
      pathFromRoot,
      workspaceRelativePath,
      workspaceName,
      skipReason: exclusionReason ?? "excluded",
    };
  }
  const riskClass = detectRiskClass(pathFromRoot, workspaceRelativePath, policy);
  return {
    absPath,
    pathFromRoot,
    workspaceRelativePath,
    workspaceName,
    input: {
      pathFromRoot,
      workspaceRelativePath,
      source,
      riskClass,
      keyDecisionsRequired: riskClass === "medium" || riskClass === "high",
      isTest: policy.isTestPath(workspaceRelativePath),
    },
  };
}

function entryTarget(
  workspaceRoot: string,
  entry: CompassInventoryEntry,
  policy: ReturnType<typeof resolveCompassPolicy>,
  leafRoot?: string,
): ScaffoldTarget {
  const absPath = resolve(workspaceRoot, entry.path);
  const segments = getRelativeSegments(absPath, workspaceRoot);
  const workspaceRelativePath = leafRoot
    ? relative(leafRoot, absPath).replace(/\\/g, "/")
    : getWorkspaceRelativeSegments(segments, policy).join("/");
  if (entry.authoringStatus === "excluded") {
    return {
      absPath,
      pathFromRoot: entry.path,
      workspaceRelativePath,
      workspaceName: entry.workspaceName,
      skipReason: entry.exclusionReason ?? "excluded",
    };
  }
  return {
    absPath,
    pathFromRoot: entry.path,
    workspaceRelativePath,
    workspaceName: entry.workspaceName,
    input: {
      pathFromRoot: entry.path,
      workspaceRelativePath,
      source: "",
      riskClass: entry.riskClass,
      keyDecisionsRequired: entry.keyDecisionsRequired,
      isTest: policy.isTestPath(workspaceRelativePath),
    },
  };
}

export async function runCompassHeaderScaffold(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ScaffoldRunResult>> {
  const scanRoot = resolveCompassScanRoot(input, context);
  const baseRoot = scanRoot ?? context.workspaceRoot;
  const policy = resolveCompassPolicy(baseRoot, context.forgeRoot);
  const leafRoot =
    scanRoot !== undefined &&
    (input.flags["workpiece"] !== undefined || scanRoot === context.site?.directory)
      ? scanRoot
      : undefined;

  const census = input.flags["census"] === true;
  const force = input.flags["force"] === true;

  const rawFiles = input.flags["files"];
  const files = (
    Array.isArray(rawFiles)
      ? rawFiles.filter((entry): entry is string => typeof entry === "string")
      : typeof rawFiles === "string"
        ? [rawFiles]
        : []
  )
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);

  // ── Target collection ────────────────────────────────────────────────────
  const targets: ScaffoldTarget[] = [];
  const entrySourceCache = new Map<string, string>();
  if (files.length > 0) {
    for (const file of files) {
      const target = await explicitTarget(context.workspaceRoot, baseRoot, file, policy, leafRoot);
      if (target) targets.push(target);
    }
  } else {
    const entries = await createCompassInventoryEntries(
      context.workspaceRoot,
      input,
      scanRoot,
      policy,
      context.site?.directory,
    );
    for (const entry of entries) {
      const target = entryTarget(context.workspaceRoot, entry, policy, leafRoot);
      const cached = getEntrySource(entry);
      if (cached !== undefined) entrySourceCache.set(target.absPath, cached);
      targets.push(target);
    }
  }
  targets.sort((a, b) => a.pathFromRoot.localeCompare(b.pathFromRoot));

  // ── Dispositions (identical pass for census and apply — census just never writes) ──
  const reports: ScaffoldFileReport[] = [];
  let scanned = 0;
  for (const target of targets) {
    if (!target.input) {
      reports.push({
        path: target.pathFromRoot,
        workspaceName: target.workspaceName,
        disposition: "skipped",
        source: "",
        repairs: [],
        skipReason: target.skipReason,
      });
      continue;
    }
    scanned += 1;
    const source =
      target.input.source ||
      entrySourceCache.get(target.absPath) ||
      (await io.readFile(target.absPath));
    const result = scaffoldFile({ ...target.input, source }, policy);
    reports.push({ path: target.pathFromRoot, workspaceName: target.workspaceName, ...result });
  }

  const writes = reports.filter(
    (r) =>
      (r.disposition === "inserted" ||
        r.disposition === "repaired" ||
        r.disposition === "sentinel") &&
      r.source.length > 0,
  );

  // ── Dirty-target refusal — apply mode only; census never writes ──────────
  if (!census && !force && writes.length > 0) {
    const dirty = listDirtyPaths(baseRoot);
    if (dirty && dirty.length > 0) {
      const dirtyTargets = writes.filter((w) => isDirtyPath(w.path, dirty));
      if (dirtyTargets.length > 0) {
        const shown = dirtyTargets.slice(0, DIRTY_LIST_CAP);
        const suffix =
          dirtyTargets.length > shown.length
            ? ` … and ${dirtyTargets.length - shown.length} more`
            : "";
        context.logger.error(
          `[compass.header.scaffold] refusing to write — ${dirtyTargets.length} target file(s) carry uncommitted changes:\n${shown.map((p) => `  ${p.path}`).join("\n")}${suffix}\nCommit or stash those files first, or pass --force to override.`,
        );
        return { exitCode: 1, summary: "dirty targets — refused" };
      }
    }
  }

  // ── Writes ───────────────────────────────────────────────────────────────
  if (!census) {
    for (const report of writes) {
      await writeFileIfChanged(
        resolve(context.workspaceRoot, report.path),
        report.source,
        context.io,
      );
    }
  }

  // ── Rollups ──────────────────────────────────────────────────────────────
  const byPackage: Record<string, Partial<Record<ScaffoldDisposition, number>>> = {};
  for (const report of reports) {
    const pkg = byPackage[report.workspaceName] ?? (byPackage[report.workspaceName] = {});
    pkg[report.disposition] = (pkg[report.disposition] ?? 0) + 1;
  }

  const counts = new Map<ScaffoldDisposition, number>();
  for (const report of reports) {
    counts.set(report.disposition, (counts.get(report.disposition) ?? 0) + 1);
  }
  const tally = [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(", ");

  const diagnostics = reports.filter((r) => r.diagnostic);
  if (diagnostics.length > 0) {
    for (const d of diagnostics.slice(0, 10)) {
      context.logger.warn(`[${d.diagnostic!.ruleId}] ${d.path}: ${d.diagnostic!.message}`);
    }
  }

  return {
    data: { mode: census ? "census" : "apply", scanned, files: reports, byPackage },
    exitCode: 0,
    summary: `[compass.header.scaffold] ${census ? "census" : "apply"} scanned=${scanned} ${tally}`,
    nextSteps:
      diagnostics.length > 0
        ? [
            {
              action: `${diagnostics.length} file(s) skipped with SCAFFOLD-01/02 diagnostics — review them manually (fixture strings or unrepairable malformation).`,
              kind: "optional",
            },
          ]
        : undefined,
  };
}
