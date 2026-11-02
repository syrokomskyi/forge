/*
<MODULE_CONTRACT>
<purpose>Tag reading for release lines (RFC-1488): list the annotated tags
reachable from HEAD that match a line's tag prefix (`v*` | `&lt;pkg&gt;@*`),
pick the semantically highest one (not the nearest — a stale older tag must
never hide a higher baseline) and expose the reachable set for evidence.
Lightweight tags are invisible to release lines by design.</purpose>
<non-goals>
  <item>No tag creation — flow.install's baseline step owns that, and it is the only writer.</item>
  <item>No version math — semver.ts and release-level.ts own it.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>`--merged HEAD` scopes to reachable tags only: a tag on an abandoned side branch must not become the baseline.</item>
  <item>`%(objecttype)` + `%(*objectname)` distinguishes annotated (`tag`) from lightweight (`commit`) — only annotated tags carry a line.</item>
  <item>Highest reachable wins over nearest: the historical `forge@0.15.0` predates real `forge@9.x` tags and must not lower the reported version.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1488: step 2 — annotated reachable-tag listing + highest-version selection</item>
  <item>RFC-1488: steps 2-4 — release tags, pending level (X-RFC + versionBump), flow.version command</item>
  <item>RFC-1488: review r1 — parse guard, door/rules metadata, id-exact RFC binding, refname precision, FLOW-09 top-level anchor, test cleanup</item>
  <item>RFC-1490: step 1 — explicit ref param on tag/level helpers + W1-2 +0.<hash>.dirty shape (AC-12)</item>
  <item>RFC-1490: step 4 — ordinary flow.cut (release branch, verified versions, gate, main swap, tags, resume)</item>
</CHANGE_SUMMARY>
*/

import type { WorkspaceIO } from "../../src/types.ts";
import { git } from "./git.ts";
import type { ReleaseLine } from "./release-lines.ts";
import { compareVersions, parseVersion, type SemVer } from "./semver.ts";

export interface LineTags {
  /** Highest-version annotated reachable tag matching the line's prefix. */
  lastTag: { name: string; version: SemVer } | null;
  /** All matching annotated reachable tag names, newest first (for evidence). */
  reachable: string[];
}

interface TagRow {
  name: string;
  objecttype: string;
  peeled: string;
  creatordate: string;
}

const NULL_FIELD = "";

/**
 * Annotated tags reachable from HEAD matching `line.tagPrefix`, newest first.
 * Format: `<refname:short>\x1f<objecttype>\x1f<*objectname>\x1f<creatordate>`.
 * Lightweight tags (`objecttype` = commit/blob) are dropped; a non-semver
 * suffix after the prefix (e.g. `v-next`) is dropped too.
 */
async function listAnnotated(
  repoRoot: string,
  line: ReleaseLine,
  io: WorkspaceIO,
  ref: string,
): Promise<TagRow[]> {
  const head = await git(repoRoot, io, ["rev-parse", "--verify", "-q", ref]);
  if (head.exitCode !== 0) return []; // unborn branch — nothing reachable
  const sep = "\x1f";
  // %(refname) (full form) — %(refname:short) would hide a tag sharing its
  // name with a branch (shortening is ambiguous by design).
  const format = `%(refname)${sep}%(objecttype)${sep}%(*objectname)${sep}%(creatordate:iso-strict)`;
  const result = await git(repoRoot, io, [
    "for-each-ref",
    `refs/tags/${line.tagPrefix}*`,
    `--format=${format}`,
    "--sort=-creatordate",
    "--merged",
    ref,
  ]);
  if (result.exitCode !== 0) return [];
  const rows: TagRow[] = [];
  for (const raw of result.stdout.split("\n")) {
    const line_ = raw.trimEnd();
    if (!line_) continue;
    const [refname = "", objecttype = "", peeled = "", creatordate = ""] = line_.split(sep);
    if (objecttype !== "tag") continue; // annotated only
    const name = refname.startsWith("refs/tags/") ? refname.slice("refs/tags/".length) : refname;
    const versionText = name.startsWith(line.tagPrefix)
      ? name.slice(line.tagPrefix.length)
      : NULL_FIELD;
    if (!versionText || parseVersion(versionText) === null) continue;
    rows.push({ name, objecttype, peeled, creatordate });
  }
  return rows;
}

/**
 * Read a line's tag state: `lastTag` is the highest-version annotated
 * reachable tag for its prefix, `reachable` the full matching set newest
 * first. Null/empty when the line was never tagged.
 */
export async function listLineTags(
  repoRoot: string,
  line: ReleaseLine,
  io: WorkspaceIO,
  ref = "HEAD",
): Promise<LineTags> {
  const rows = await listAnnotated(repoRoot, line, io, ref);
  let lastTag: LineTags["lastTag"] = null;
  for (const row of rows) {
    const version = parseVersion(row.name.slice(line.tagPrefix.length));
    if (version === null) continue;
    if (lastTag === null || compareVersions(version, lastTag.version) > 0) {
      lastTag = { name: row.name, version };
    }
  }
  return { lastTag, reachable: rows.map((r) => r.name) };
}

/** Short (9-char) form of a full commit hash — derived-version metadata. */
export function shortHash(hash: string): string {
  return hash.slice(0, 9);
}

/**
 * forge/release-tag@1 annotation body (RFC-1488). `previous`/`rfcs`/`fingerprints`
 * come from the cut's pendingLevel and the fingerprint hook.
 */
export function releaseTagAnnotation(fields: {
  tag: string;
  line: string;
  version: string;
  level: string;
  previous: string | null;
  rfcs: string[];
  fingerprints: Record<string, string>;
}): string {
  const fp = Object.entries(fields.fingerprints)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  return [
    `release ${fields.tag}`,
    "",
    "schema: forge/release-tag@1",
    `line: ${fields.line}`,
    `version: ${fields.version}`,
    `level: ${fields.level}`,
    `previous: ${fields.previous ?? "null"}`,
    `rfcs: [${fields.rfcs.map((r) => `"${r}"`).join(", ")}]`,
    fp.length > 0 ? `fingerprints:\n${fp}` : "fingerprints: {}",
  ].join("\n");
}

export interface ReleaseTagSpec {
  /** Full tag name, e.g. v1.3.0 or lib@2.1.0. */
  name: string;
  /** Commit the tag points at. */
  target: string;
  /** Full annotation text (the forge/release-tag@1 body). */
  annotation: string;
}

/**
 * Create an annotated release tag at `target` with the given annotation
 * body via `git tag -a <name> <target> -m <annotation>`. Callers build the
 * forge/release-tag@1 text; this is the single tag-writing seam (flow.install
 * baselines and flow.cut releases share it).
 */
export async function writeReleaseTag(
  repoRoot: string,
  io: WorkspaceIO,
  spec: ReleaseTagSpec,
): Promise<{ exitCode: number | null; stderr: string }> {
  const result = await git(repoRoot, io, ["tag", "-a", spec.name, spec.target, "-m", spec.annotation]);
  return { exitCode: result.exitCode, stderr: result.stderr };
}
