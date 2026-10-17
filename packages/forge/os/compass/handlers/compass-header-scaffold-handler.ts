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
  <item>RFC-1318</item>
</CHANGE_SUMMARY>
*/

import { ambientIo } from "../../../src/utils/io.ts";
import { writeFileIfChanged } from "../../../src/utils/fs-idempotent.ts";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  createCompassInventoryEntries,
  detectAuthoringStatus,
  detectRiskClass,
  detectWorkspaceName,
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
import { DIRTY_LIST_CAP, isDirtyPath, listDirtyPaths, repoTopLevel } from "./git-revision.ts";
import { resolveCompassScanRoot } from "./resolve-scan-root.ts";
import { resolveCompassPolicy } from "../policy.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const io = ambientIo;

export interface ScaffoldFileReport extends Omit<ScaffoldFileResult, "source"> {
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

async function explicitTarget(
  workspaceRoot: string,
  baseRoot: string,
  file: string,
  policy: ReturnType<typeof resolveCompassPolicy>,
  leafRoot?: string,
): Promise<ScaffoldTarget> {
  const absPath = resolve(baseRoot, file);
  const pathFromRoot = relative(workspaceRoot, absPath).replace(/\\/g, "/");
  const workspaceRelativePath = leafRoot
    ? relative(leafRoot, absPath).replace(/\\/g, "/")
    : explicitWorkspaceRelativePath(absPath, workspaceRoot, policy);
  const segments = getRelativeSegments(absPath, workspaceRoot);
  const workspaceName = detectWorkspaceName(segments, policy);
  const shell: Omit<ScaffoldTarget, "skipReason" | "input"> = {
    absPath,
    pathFromRoot,
    workspaceRelativePath,
    workspaceName,
  };
  // --files bypasses scan roots, not the extension allowlist — a binary or
  // non-source path must never receive a header.
  const extension = absPath.slice(absPath.lastIndexOf("."));
  if (!policy.fileExtensions.has(extension)) {
    return { ...shell, skipReason: `unsupported extension ${extension || "(none)"}` };
  }
  let source: string;
  try {
    source = await io.readFile(absPath);
  } catch {
    return { ...shell, skipReason: "unreadable" };
  }
  const { authoringStatus, exclusionReason } = detectAuthoringStatus(
    segments,
    workspaceRelativePath,
    source,
    policy,
  );
  if (authoringStatus === "excluded") {
    return { ...shell, skipReason: exclusionReason ?? "excluded" };
  }
  const riskClass = detectRiskClass(pathFromRoot, workspaceRelativePath, policy);
  return {
    ...shell,
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
      source: getEntrySource(entry) ?? "",
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
  if (files.length > 0) {
    for (const file of files) {
      targets.push(await explicitTarget(context.workspaceRoot, baseRoot, file, policy, leafRoot));
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
      targets.push(entryTarget(context.workspaceRoot, entry, policy, leafRoot));
    }
  }
  targets.sort((a, b) => a.pathFromRoot.localeCompare(b.pathFromRoot));

  // ── Dispositions (identical pass for census and apply — census just never writes) ──
  // Pending write sources live outside the report payload — serializing every
  // file body into data.files[] would balloon a full-repo census.
  const reports: ScaffoldFileReport[] = [];
  const writeSources = new Map<string, string>();
  let scanned = 0;
  for (const target of targets) {
    if (!target.input) {
      reports.push({
        path: target.pathFromRoot,
        workspaceName: target.workspaceName,
        disposition: "skipped",
        repairs: [],
        skipReason: target.skipReason,
      });
      continue;
    }
    scanned += 1;
    const source = target.input.source || (await io.readFile(target.absPath));
    const result = scaffoldFile({ ...target.input, source }, policy);
    const { source: nextSource, ...report } = result;
    if (
      result.disposition === "inserted" ||
      result.disposition === "repaired" ||
      result.disposition === "sentinel"
    ) {
      writeSources.set(target.pathFromRoot, nextSource);
    }
    reports.push({ path: target.pathFromRoot, workspaceName: target.workspaceName, ...report });
  }

  const writes = reports.filter((r) => writeSources.has(r.path));

  // ── Dirty-target refusal — apply mode only; census never writes ──────────
  if (!census && !force && writes.length > 0) {
    const rawDirty = listDirtyPaths(baseRoot);
    if (rawDirty && rawDirty.length > 0) {
      // Porcelain paths are repo-top-relative while reports carry
      // workspace-relative paths — rebase through the actual top-level so a
      // scoped scan (--package/--packages inside one repo, or a nested
      // --workpiece repo) still sees its dirty targets. realpath both sides:
      // git reports canonical paths while workspaceRoot may be symlinked.
      const topLevel = repoTopLevel(baseRoot);
      let wsRoot = context.workspaceRoot;
      try {
        wsRoot = realpathSync(wsRoot);
      } catch {
        // keep the workspace root as given
      }
      const gitBase = topLevel ?? baseRoot;
      const dirty = rawDirty.map((d) => {
        const rebased = relative(wsRoot, resolve(gitBase, d)).replace(/\\/g, "/");
        return d.endsWith("/") && !rebased.endsWith("/") ? `${rebased}/` : rebased;
      });
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
      const nextSource = writeSources.get(report.path);
      if (nextSource === undefined) continue;
      await writeFileIfChanged(resolve(context.workspaceRoot, report.path), nextSource, context.io);
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

  // Per-package table in default output — the result contract promises it
  // outside --json too.
  const packageLines = Object.entries(byPackage)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([pkg, tallies]) =>
        `  ${pkg}: ${Object.entries(tallies)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
    );
  if (packageLines.length > 0) {
    context.logger.info(`[compass.header.scaffold] by package:\n${packageLines.join("\n")}`);
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
