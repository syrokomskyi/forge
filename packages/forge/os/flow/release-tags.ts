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
  <item>listLegacyTags (RFC-1498) is reporting-only: one for-each-ref pass with NUL-delimited records (contents is multi-line) classifies prefix+semver-matching tags the reader does not honour — never rewrites them.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1490: step 1 — explicit ref param on tag/level helpers + W1-2 +0.<hash>.dirty shape (AC-12)</item>
  <item>RFC-1490: step 4 — ordinary flow.cut (release branch, verified versions, gate, main swap, tags, resume)</item>
  <item>RFC-1490: independent-review pass — lock-held planning, fix-branch verification, spec-shaped data, coverage</item>
  <item>RFC-1498: step 3 — legacy-tags report in flow.install

listLegacyTags scans refs/tags in a single for-each-ref pass carrying objecttype and NUL-delimited contents: a tag whose name matches a line grammar (tagPrefix + strict semver) is pre-program when it is lightweight, or annotated but its body lacks the schema forge/release-tag@1 line. flow.install gains an informational legacy-tags plan step listing every such tag as name (kind) — never a refusal, nothing is deleted or rewritten; execution simply marks the step done. Tests AC-5 (a lightweight v1.2.2 and a schema-less annotated lib at 0.1.0 appear with their kinds) and AC-6 (installation proceeds and both tags remain). Compass metadata updated.</item>
  <item>RFC-1511: accept recorded products map in verified gate, guard folders lookup and exec edges (RFC-1511 review r1)</item>
  <history>RFC-1488</history>
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

export interface LegacyTag {
  /** Full tag name, e.g. v1.2.2 or lib@0.1.0. */
  name: string;
  /** Release-line id whose tag grammar the name matches. */
  line: string;
  /**
   * Why the release-line reader does not treat it as a line tag:
   * lightweight tags are invisible by design; an annotated tag without
   * the forge/release-tag@1 schema line predates the program.
   */
  kind: "lightweight" | "annotated-without-schema";
}

export const RELEASE_TAG_SCHEMA_LINE = /^schema:\s*forge\/release-tag@1\s*$/m;

/**
 * Pre-program tags (RFC-1498): every tag whose name matches a discovered
 * line's grammar (tagPrefix + strict semver) but that the release-line
 * reader does not honour — lightweight tags, and annotated tags whose
 * body lacks the `schema: forge/release-tag@1` line. One `for-each-ref`
 * pass; %00 delimits records because %(contents) is multi-line.
 */
export async function listLegacyTags(
  repoRoot: string,
  lines: ReleaseLine[],
  io: WorkspaceIO,
): Promise<LegacyTag[]> {
  const sep = "\x1f";
  const format = `%(refname)${sep}%(objecttype)${sep}%(contents)%00`;
  const result = await git(repoRoot, io, ["for-each-ref", "refs/tags", `--format=${format}`]);
  if (result.exitCode !== 0) return [];
  const legacy: LegacyTag[] = [];
  for (const rec of result.stdout.split("\x00")) {
    const firstSep = rec.indexOf(sep);
    const secondSep = firstSep === -1 ? -1 : rec.indexOf(sep, firstSep + 1);
    if (firstSep === -1 || secondSep === -1) continue;
    const refname = rec.slice(0, firstSep).replace(/^\s+/, "");
    const objecttype = rec.slice(firstSep + 1, secondSep);
    const contents = rec.slice(secondSep + 1);
    const name = refname.startsWith("refs/tags/") ? refname.slice("refs/tags/".length) : refname;
    const line = lines.find(
      (l) =>
        name.startsWith(l.tagPrefix) &&
        parseVersion(name.slice(l.tagPrefix.length)) !== null,
    );
    if (line === undefined) continue;
    if (objecttype === "tag") {
      if (!RELEASE_TAG_SCHEMA_LINE.test(contents)) {
        legacy.push({ name, line: line.id, kind: "annotated-without-schema" });
      }
    } else {
      legacy.push({ name, line: line.id, kind: "lightweight" });
    }
  }
  return legacy;
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
    .map(([k, v]) => `  ${k}: ${/^[A-Za-z0-9._/+@-]+$/.test(v) ? v : JSON.stringify(v)}`)
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
