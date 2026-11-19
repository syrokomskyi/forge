/*
<MODULE_CONTRACT>
<purpose>Derived release-line version (RFC-1488, RFC-1493): the single
implementation of `X.Y.Z+N.&lt;head9&gt;[.dirty]` anchored to the last
reachable annotated tag, plus the version-file fallback for untagged lines.
flow.version and the public os/flow reader share this — werkstatt never
re-reads the tag grammar itself.</purpose>
<non-goals>
  <item>No pending-level math — release-level.ts owns it.</item>
  <item>No diagnostics surface — callers decide which states are findings.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Derived version anchors to the last tag, never the version file — divergence is a FLOW-08 finding.</item>
  <item>An untagged line resolves to the version-file value with source "version-file" — never throws for the untagged state itself (RFC-1493).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1493: step 1 — shared derived-version extraction consumed by flow.version and resolveRepositoryLineVersion</item>
  <item>RFC-1493: step 1 — forge public release-line version reader</item>
  <item>RFC-1493: step 2 — platform identity command, migrator-cursor pin comparison</item>
  <item>RFC-1515: harden forge flow worktree lifecycle against vanished paths, forge-local state, dead-holder locks and generated drift</item>
  <item>RFC-1616: refuse mid-window mmap writes and refusal-to-benign collapse</item>
</CHANGE_SUMMARY>
*/

import type { WorkspaceIO } from "../../src/types.ts";
import { repoShaped } from "../../src/utils/verifier-git.ts";
import { git, statusTracked } from "./git.ts";
import { readLineVersionFile, type ReleaseLine } from "./release-lines.ts";
import { listLineTags } from "./release-tags.ts";
import type { SemVer } from "./semver.ts";

export interface DerivedLineVersion {
  /** `X.Y.Z+N.<head9>[.dirty]` for a tagged line, else the version-file value (null when unreadable). */
  version: string | null;
  source: "release-tag" | "version-file";
  lastTag: { name: string; version: SemVer } | null;
  commitsSince: number;
  head: string | null;
  dirty: boolean;
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
  if (result.exitCode === 0) return Number.parseInt(result.stdout.trim(), 10) || 0;
  // A failed count on a repo-shaped surface is unverifiable — `0` would
  // fabricate the `+N` suffix baked into a published version string
  // (CX-r23-B). Non-repo workdirs keep the documented clean-read
  // contract (isBare's repoShaped pattern).
  if (repoShaped(repoRoot)) {
    throw new Error(
      `commitsSinceRef: rev-list failed (${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return 0;
}

/** Tracked modifications inside `paths` (empty = whole worktree). Non-git workdirs read as clean — the version-file fallback then applies. */
async function dirtyPaths(repoRoot: string, paths: string[], io: WorkspaceIO): Promise<number> {
  let entries: string[];
  try {
    entries = (await statusTracked(repoRoot, io)).entries;
  } catch (err) {
    // statusTracked throws only on an unverifiable repo surface — a
    // swallowed `0` would stamp `.dirty` incorrectly into the derived
    // version (CX-r23-B). The non-repo benign path lives inside
    // statusTracked itself; anything that reaches here is unverifiable.
    if (repoShaped(repoRoot)) throw err;
    return 0;
  }
  if (paths.length === 0) return entries.length;
  return entries.filter((entry) => {
    const file = entry.slice(3).split(" -> ").pop() ?? "";
    return paths.some((p) => file === p || file.startsWith(`${p}/`));
  }).length;
}

/**
 * Derive a line's version: `X.Y.Z+N.<head9>[.dirty]` anchored to the highest
 * reachable annotated tag when one exists, else the version-file value.
 * Never throws for the untagged state; `version` is null only when both the
 * tag and the version file are unreadable.
 */
export async function deriveLineVersion(
  repoRoot: string,
  line: ReleaseLine,
  io: WorkspaceIO,
): Promise<DerivedLineVersion> {
  const [tags, currentVersion, dirtyCount, headResult] = await Promise.all([
    listLineTags(repoRoot, line, io),
    readLineVersionFile(repoRoot, line, io),
    dirtyPaths(repoRoot, line.paths, io),
    git(repoRoot, io, ["rev-parse", "--short=9", "HEAD"]),
  ]);
  const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
  const dirty = dirtyCount > 0;
  const commitsSince = await commitsSinceRef(repoRoot, tags.lastTag?.name ?? "", line.paths, io);

  if (tags.lastTag === null || head === null) {
    return {
      version: tags.lastTag === null ? currentVersion : null,
      source: tags.lastTag === null ? "version-file" : "release-tag",
      lastTag: tags.lastTag,
      commitsSince,
      head,
      dirty,
    };
  }

  const base =
    commitsSince > 0
      ? `${tags.lastTag.name.slice(line.tagPrefix.length)}+${commitsSince}.${head}`
      : tags.lastTag.name.slice(line.tagPrefix.length);
  const version =
    dirty && commitsSince === 0 ? `${base}+0.${head}.dirty` : dirty ? `${base}.dirty` : base;
  return { version, source: "release-tag", lastTag: tags.lastTag, commitsSince, head, dirty };
}
