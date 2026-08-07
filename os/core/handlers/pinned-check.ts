/*
<MODULE_CONTRACT>
<purpose>Shared pre-check utility for the forge pinned-files protection system (RFC-0733).
Loads the pinned manifest from .forge/pinned.yaml and provides an isPinned lookup
that all archive handlers call before moving files. Manifest loading is cached
per invocation — loadPinnedManifest is called once and the result is reused.</purpose>
<non-goals>
  <item>Does not implement validation logic (git diff parsing, violation detection) — use pinned-validate.ts.</item>
  <item>Does not implement manifest creation — use pinned-init.ts.</item>
  <item>Does not enforce overrides or audit logging — that is pinned-validate.ts responsibility.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0733: initial pinned-check utility — loadPinnedManifest, isPinned, checkFilesForPinned.</item>
  <item>Gap fix: add isIntraDirMove to exempt moves within the same pinned directory (e.g. rfc.archive moves docs/rfcs/x.md → docs/rfcs/archive/implemented/x.md).</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { PinnedEntry, PinnedManifest, PinnedMode, PinnedViolation } from "./pinned-types.ts";

const PINNED_DIR = ".forge";
const PINNED_FILE = "pinned.yaml";

/**
 * Path to the pinned manifest relative to the repository root.
 */
export const PINNED_MANIFEST_PATH = path.join(PINNED_DIR, PINNED_FILE);

/**
 * Error thrown when the manifest exists but is malformed (invalid YAML or missing required fields).
 */
export class PinnedManifestMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinnedManifestMalformedError";
  }
}

/**
 * Load and parse the pinned manifest from .forge/pinned.yaml.
 * Returns null if the file does not exist (protection is opt-in).
 * Throws PinnedManifestMalformedError if the file exists but is not valid YAML
 * or does not contain a `pinned` array.
 */
export async function loadPinnedManifest(repoRoot: string): Promise<PinnedManifest | null> {
  const manifestPath = path.join(repoRoot, PINNED_MANIFEST_PATH);

  let content: string;
  try {
    content = await fs.readFile(manifestPath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    throw new PinnedManifestMalformedError(
      `pinned.yaml is not valid YAML: ${String((err as Error).message)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new PinnedManifestMalformedError(
      "pinned.yaml must contain a top-level object with a `pinned` array",
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj["pinned"])) {
    throw new PinnedManifestMalformedError("pinned.yaml is missing required `pinned` array field");
  }

  const entries: PinnedEntry[] = [];
  for (const raw of obj["pinned"]) {
    if (!raw || typeof raw !== "object") {
      throw new PinnedManifestMalformedError(
        "pinned.yaml: each entry must be an object with path, mode, and reason",
      );
    }
    const entry = raw as Record<string, unknown>;
    const entryPath = entry["path"];
    const entryMode = entry["mode"];
    const entryReason = entry["reason"];

    if (typeof entryPath !== "string" || !entryPath) {
      throw new PinnedManifestMalformedError(
        "pinned.yaml: each entry must have a non-empty `path` string",
      );
    }
    if (entryMode !== "protect" && entryMode !== "freeze") {
      throw new PinnedManifestMalformedError(
        `pinned.yaml: entry "${entryPath}" has invalid mode "${String(entryMode)}" — must be "protect" or "freeze"`,
      );
    }
    if (typeof entryReason !== "string" || !entryReason) {
      throw new PinnedManifestMalformedError(
        `pinned.yaml: entry "${entryPath}" must have a non-empty reason string`,
      );
    }

    entries.push({
      path: entryPath,
      mode: entryMode as PinnedMode,
      reason: entryReason,
    });
  }

  return { pinned: entries };
}

/**
 * Check if a relative file path matches a pinned entry.
 *
 * Path matching rules:
 * - Exact match: if the entry path equals the file path, it matches.
 * - Directory match: if the entry path ends with `/`, it matches any file
 *   that starts with the directory prefix (recursive).
 *
 * Returns the matching PinnedEntry or null if no match.
 */
export function isPinned(manifest: PinnedManifest, relPath: string): PinnedEntry | null {
  const normalizedRelPath = relPath.replace(/\\/g, "/");

  for (const entry of manifest.pinned) {
    const normalizedEntryPath = entry.path.replace(/\\/g, "/");

    if (normalizedEntryPath.endsWith("/")) {
      if (normalizedRelPath.startsWith(normalizedEntryPath)) {
        return entry;
      }
    } else if (normalizedRelPath === normalizedEntryPath) {
      return entry;
    }
  }

  return null;
}

/**
 * Check if a move from sourceRel to destRel stays within the same pinned directory.
 * This exempts intra-directory moves (e.g. rfc.archive moves
 * docs/rfcs/rfc-0076.md → docs/rfcs/archive/implemented/rfc-0076.md)
 * from the pinned pre-check, since the file hasn't left the protected directory.
 *
 * Only applies to directory-pinned entries (path ends with `/`).
 * Returns true if the same pinned directory entry matches both source and dest.
 */
export function isIntraDirMove(
  manifest: PinnedManifest,
  sourceRel: string,
  destRel: string,
): boolean {
  const normalizedSource = sourceRel.replace(/\\/g, "/");
  const normalizedDest = destRel.replace(/\\/g, "/");

  for (const entry of manifest.pinned) {
    const normalizedEntryPath = entry.path.replace(/\\/g, "/");
    if (normalizedEntryPath.endsWith("/")) {
      if (
        normalizedSource.startsWith(normalizedEntryPath) &&
        normalizedDest.startsWith(normalizedEntryPath)
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Batch-check multiple file paths against the manifest.
 * Returns violations for files that match a pinned entry.
 * The operation type is determined by the caller (delete, move, or modify).
 */
export function checkFilesForPinned(
  manifest: PinnedManifest,
  files: Array<{ relPath: string; operation: PinnedViolation["operation"] }>,
): PinnedViolation[] {
  const violations: PinnedViolation[] = [];

  for (const { relPath, operation } of files) {
    const entry = isPinned(manifest, relPath);
    if (entry) {
      violations.push({
        path: relPath,
        mode: entry.mode,
        operation,
        reason: entry.reason,
      });
    }
  }

  return violations;
}
