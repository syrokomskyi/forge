/*
<MODULE_CONTRACT>
<purpose>
RFC-1154: .forge-managed marker manifests for synced skill dirs and the
stale-dir prune for forge upgrade. Every skill-sync site records the files it
wrote into .agents/skills/<name>/ so a later upgrade can distinguish
forge-owned leftover dirs from consumer-authored skills — ownership is proven
by the marker, not inferred from the name.
</purpose>
<non-goals>
  <item>Do not prune unmarked dirs — no marker means consumer-owned (pre-RFC-1154 syncs, hand-authored skills).</item>
  <item>Do not delete dirs containing files outside the manifest — consumer additions keep the dir.</item>
</non-goals>
<KEY_DECISIONS>
  <item>Marker is a per-dir JSON manifest ({ files: string[] }) — fail-safe: missing marker means no right to delete.</item>
  <item>Prune only when on-disk contents ⊆ manifest files + marker; extras keep the dir and warn.</item>
</KEY_DECISIONS>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1154: initial implementation — SKILL_MARKER_FILE, writeSkillMarker, pruneStaleSkillDirs.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import type { WorkspaceIO } from "@warpgogol/werkstatt-shared/kernel/workspace-io";
import { resolveIo } from "../utils/io.ts";
import { writeFileIfChanged } from "../utils/fs-idempotent.ts";
import * as sfs from "../utils/sync-fs.ts";

/** Marker file name written into every forge-synced skill dir. */
export const SKILL_MARKER_FILE = ".forge-managed";

export interface SkillMarkerManifest {
  files: string[]; // paths forge wrote into the skill dir, relative to it
}

export interface PruneResult {
  /** Stale marked dirs that were deleted (contents ⊆ manifest + marker). */
  pruned: string[];
  /** Marked stale dirs kept because extra consumer files exist or the marker is corrupt. */
  keptWithConsumerFiles: string[];
}

/** Canonical marker bytes — deterministic, sorted file list. */
export function buildSkillMarkerContent(files: string[]): string {
  const manifest: SkillMarkerManifest = { files: [...files].sort() };
  return JSON.stringify(manifest) + "\n";
}

/** Write the .forge-managed manifest into a synced skill dir (async/io path). */
export async function writeSkillMarker(
  skillDir: string,
  files: string[],
  io?: WorkspaceIO,
): Promise<void> {
  const fio = resolveIo(io);
  await writeFileIfChanged(
    path.join(skillDir, SKILL_MARKER_FILE),
    buildSkillMarkerContent(files),
    fio,
  );
}

/** Sync twin for runInit (sync call path — no WorkspaceIO). */
export function writeSkillMarkerSync(skillDir: string, files: string[]): void {
  const markerPath = path.join(skillDir, SKILL_MARKER_FILE);
  const next = buildSkillMarkerContent(files);
  try {
    if (sfs.readFileSync(markerPath, "utf8") === next) return;
  } catch {
    // Marker absent or unreadable — write below
  }
  sfs.writeFileSync(markerPath, next, "utf8");
}

function parseMarker(raw: string): SkillMarkerManifest | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as SkillMarkerManifest).files) &&
      (parsed as SkillMarkerManifest).files.every((f) => typeof f === "string")
    ) {
      return parsed as SkillMarkerManifest;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Prune stale synced skill dirs under `agentsSkillsDir`: a dir is stale when it
 * carries `.forge-managed` and its name is not in `currentSyncSet`. Deletion is
 * allowed only when every file in the dir is listed in the manifest (or is the
 * marker itself). Corrupt markers and dirs with extra files are kept and
 * reported in `keptWithConsumerFiles`.
 */
export async function pruneStaleSkillDirs(
  agentsSkillsDir: string,
  currentSyncSet: Set<string>,
  io?: WorkspaceIO,
): Promise<PruneResult> {
  const fio = resolveIo(io);
  const result: PruneResult = { pruned: [], keptWithConsumerFiles: [] };

  let entries;
  try {
    entries = await fio.readdir(agentsSkillsDir);
  } catch {
    return result; // No skills dir — nothing to prune
  }

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const name = entry.name;
    if (currentSyncSet.has(name)) continue;

    const dir = path.join(agentsSkillsDir, name);
    const markerPath = path.join(dir, SKILL_MARKER_FILE);
    if (!(await fio.exists(markerPath))) continue; // consumer-owned — never touch

    let manifest: SkillMarkerManifest | null = null;
    try {
      manifest = parseMarker(await fio.readFile(markerPath));
    } catch {
      manifest = null;
    }
    if (!manifest) {
      result.keptWithConsumerFiles.push(`${name} (corrupt marker)`);
      continue;
    }

    const allowed = new Set([...manifest.files, SKILL_MARKER_FILE]);
    const onDisk = await listFilesRecursive(dir, fio);
    const extra = onDisk.filter((f) => !allowed.has(f));
    if (extra.length > 0) {
      result.keptWithConsumerFiles.push(`${name} (consumer files: ${extra.join(", ")})`);
      continue;
    }

    await fio.rm(dir, { recursive: true });
    result.pruned.push(name);
  }

  return result;
}

async function listFilesRecursive(dir: string, io: WorkspaceIO, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await io.readdir(dir);
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      out.push(...(await listFilesRecursive(path.join(dir, entry.name), io, rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}
