/*
<MODULE_CONTRACT>
<purpose>Pending release level for a line (RFC-1488): count the commits in
`&lt;since&gt;..HEAD` touching the line's paths, read their `X-RFC` trailers,
resolve each RFC's `versionBump` through the canonical RFC reader named by
forge.yaml resolverDoors.rfc, and report the highest pending level plus the
next release version it implies.</purpose>
<non-goals>
  <item>No tag listing or version-file reading — release-tags.ts and the handler own those.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>`patch` is the floor for any commit — a change merged without an X-RFC trailer still levels the line; `none` only when zero commits touched the line.</item>
  <item>Missing/unreadable RFC file counts as `patch` plus a FLOW-VER-03 warning — the RFC contract, and a safer under- than over-statement.</item>
  <item>RFC frontmatter is read only via `listRfcFiles`/`readAndParseRfc` (RFC-1465) — never re-parsed locally.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1488: step 3 — pending level from X-RFC trailers + versionBump</item>
  <item>RFC-1488: steps 2-4 — release tags, pending level (X-RFC + versionBump), flow.version command</item>
  <item>RFC-1488: review r1 — parse guard, door/rules metadata, id-exact RFC binding, refname precision, FLOW-09 top-level anchor, test cleanup</item>
  <item>RFC-1490: step 1 — explicit ref param on tag/level helpers + W1-2 +0.<hash>.dirty shape (AC-12)</item>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import { listRfcFiles, readAndParseRfc, rfcFileMatchesId } from "../rfc/frontmatter-io.ts";
import type { Diagnostic, WorkspaceIO } from "../../src/types.ts";
import { git } from "./git.ts";
import type { ReleaseLine } from "./release-lines.ts";
import {
  bumpVersion,
  formatVersion,
  maxLevel,
  type ReleaseLevel,
  type SemVer,
} from "./semver.ts";

export interface PendingLevel {
  line: string;
  level: ReleaseLevel;
  /** Distinct X-RFC trailer ids and each RFC's declared versionBump (null when absent/unreadable). */
  rfcs: Array<{ id: string; versionBump: string | null }>;
  /** lastVersion with `level` applied; null when `none` or no baseline tag. */
  nextVersion: string | null;
  /** FLOW-VER-03 entries for RFC files that could not be read. */
  diagnostics: Diagnostic[];
}

const RFC_DIR = "docs/rfcs";
const VALID_BUMPS = new Set(["patch", "minor", "major"]);

/** Distinct `X-RFC:` trailer values in the commits of `range` touching `paths`. */
async function xRfcTrailers(
  repoRoot: string,
  range: string,
  paths: string[],
  io: WorkspaceIO,
): Promise<string[]> {
  const args = ["log", "--format=%(trailers:key=X-RFC,valueonly,separator=%x20)", range];
  if (paths.length > 0) args.push("--", ...paths);
  const result = await git(repoRoot, io, args);
  if (result.exitCode !== 0) return [];
  const ids = new Set<string>();
  for (const token of result.stdout.split(/[\s]+/)) {
    if (/^RFC-\d+$/i.test(token)) ids.add(token.toUpperCase());
  }
  return [...ids].sort();
}

/**
 * Pending level of `line` over `since..HEAD` (`since` = "" → all of HEAD).
 * `lastVersion` (the line's last tag version) anchors `nextVersion`; null
 * keeps `nextVersion` null.
 */
export async function pendingLevel(
  line: ReleaseLine,
  since: string,
  io: WorkspaceIO,
  repoRoot: string,
  lastVersion: SemVer | null,
  ref = "HEAD",
): Promise<PendingLevel> {
  const range = since === "" ? ref : `${since}..${ref}`;
  const countArgs = ["rev-list", "--count", range];
  if (line.paths.length > 0) countArgs.push("--", ...line.paths);
  const count = await git(repoRoot, io, countArgs);
  const commitsSince = count.exitCode === 0 ? Number.parseInt(count.stdout.trim(), 10) : 0;

  const diagnostics: Diagnostic[] = [];
  const rfcs: PendingLevel["rfcs"] = [];
  let level: ReleaseLevel = Number.isFinite(commitsSince) && commitsSince > 0 ? "patch" : "none";

  if (commitsSince > 0) {
    const rfcDirPath = join(repoRoot, RFC_DIR);
    const rfcFiles = await listRfcFiles(rfcDirPath);
    for (const id of await xRfcTrailers(repoRoot, range, line.paths, io)) {
      const fileName = rfcFiles.find((f) => rfcFileMatchesId(f, id));
      if (fileName === undefined) {
        diagnostics.push({
          ruleId: "FLOW-VER-03",
          severity: "warning",
          message: `X-RFC trailer names ${id} but no RFC file under ${RFC_DIR} matches — counted as patch`,
        });
        rfcs.push({ id, versionBump: null });
        continue;
      }
      const parsed = await readAndParseRfc(rfcDirPath, fileName);
      // The filename match is a prefix heuristic — a trailer like RFC-148
      // would otherwise bind rfc-1488-*'s bump. The frontmatter id is
      // authoritative; a mismatch counts as missing.
      const frontmatterId =
        parsed && "parsed" in parsed
          ? String(parsed.parsed.frontmatter["id"] ?? "").trim().toUpperCase()
          : "";
      if (!parsed || !("parsed" in parsed) || frontmatterId !== id) {
        diagnostics.push({
          ruleId: "FLOW-VER-03",
          severity: "warning",
          message: `could not read ${id} (${fileName}) — counted as patch`,
        });
        rfcs.push({ id, versionBump: null });
        continue;
      }
      const raw = parsed.parsed.frontmatter["versionBump"];
      const bump = typeof raw === "string" && VALID_BUMPS.has(raw) ? (raw as ReleaseLevel) : null;
      if (bump !== null) level = maxLevel(level, bump);
      rfcs.push({ id, versionBump: typeof raw === "string" ? raw : null });
    }
  }

  const nextVersion =
    level !== "none" && lastVersion !== null
      ? formatVersion(bumpVersion(lastVersion, level as Exclude<ReleaseLevel, "none">))
      : null;

  return { line: line.id, level, rfcs, nextVersion, diagnostics };
}

