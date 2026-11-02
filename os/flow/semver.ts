/*
<MODULE_CONTRACT>
<purpose>Strict three-integer semver for release lines (RFC-1488) — parse,
compare and bump `X.Y.Z` versions with no pre-release/build segments: release
tags are `vX.Y.Z` and `<package>@X.Y.Z`, nothing else ever matches.</purpose>
<non-goals>
  <item>No loose semver (pre-release, build metadata, ranges) — the release-line grammar is fixed.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Strict `^\d+\.\d+\.\d+$` — a pre-release or build suffix would silently break the tag-name match, so it is a parse failure, never normalized.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1488: step 1 — strict X.Y.Z parse/compare/bump</item>
  <item>RFC-1488: step 1 — semver helper + release-line discovery (extract.config.yaml workspace globs)</item>
</CHANGE_SUMMARY>
*/

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export type ReleaseLevel = "none" | "patch" | "minor" | "major";

/**
 * Parse a strict `X.Y.Z` version — three non-negative integers, no leading
 * `v`, no pre-release or build suffix. Returns null on anything else.
 */
export function parseVersion(raw: string): SemVer | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
  };
}

/** Format a parsed version back to `X.Y.Z`. */
export function formatVersion(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** Numeric compare: -1 / 0 / +1. */
export function compareVersions(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** Bump `version` one level: patch → Z+1; minor → Y+1, Z=0; major → X+1, Y=Z=0. */
export function bumpVersion(v: SemVer, level: Exclude<ReleaseLevel, "none">): SemVer {
  switch (level) {
    case "major":
      return { major: v.major + 1, minor: 0, patch: 0 };
    case "minor":
      return { major: v.major, minor: v.minor + 1, patch: 0 };
    case "patch":
      return { major: v.major, minor: v.minor, patch: v.patch + 1 };
  }
}

/** Ordering of release levels for max() — `none` ranks below every real level. */
export function levelRank(level: ReleaseLevel): number {
  switch (level) {
    case "none":
      return 0;
    case "patch":
      return 1;
    case "minor":
      return 2;
    case "major":
      return 3;
  }
}

export function maxLevel(a: ReleaseLevel, b: ReleaseLevel): ReleaseLevel {
  return levelRank(a) >= levelRank(b) ? a : b;
}
