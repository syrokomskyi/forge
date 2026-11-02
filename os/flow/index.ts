/*
<MODULE_CONTRACT>
<purpose>Public release-line version reader (RFC-1493): the exported
`resolveRepositoryLineVersion(repoRoot, io)` consumers outside Forge call so
they never re-read the tag grammar. For the repository line it returns the
derived `X.Y.Z+N.&lt;head9&gt;[.dirty]` when an annotated release tag is
reachable, else the version-file value.</purpose>
<non-goals>
  <item>No package-line reporting — flow.version owns the full report.</item>
  <item>No diagnostics surface — this is a library function; failure states throw.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>One implementation — deriveLineVersion in line-version.ts is the same derivation flow.version prints (RFC-1465 canonical-reader rule).</item>
  <item>Untagged is not an error — it resolves to the version-file value; only a missing or unparsable version file throws.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1493: step 1 — public os/flow export resolveRepositoryLineVersion</item>
  <item>RFC-1493: step 1 — forge public release-line version reader</item>
</CHANGE_SUMMARY>
*/

import type { WorkspaceIO } from "../../src/types.ts";
import { deriveLineVersion } from "./line-version.ts";
import { discoverReleaseLines } from "./release-lines.ts";

export interface RepositoryLineVersion {
  /** "6.451.0+12.ab12cd34e" for a tagged line, "6.451.0" from the version file otherwise. */
  version: string;
  source: "release-tag" | "version-file";
  lastTag: string | null;
}

/**
 * Resolve the repository release line's version: the derived
 * `X.Y.Z+N.<head9>[.dirty]` anchored to the last reachable annotated `v*`
 * tag, or the root package.json `version` when the line was never tagged.
 * Throws only when the version cannot be resolved at all (missing or
 * unparsable version file on an untagged line, or HEAD unresolvable on a
 * tagged one).
 */
export async function resolveRepositoryLineVersion(
  repoRoot: string,
  io: WorkspaceIO,
): Promise<RepositoryLineVersion> {
  const { lines, diagnostics } = await discoverReleaseLines(repoRoot, io);
  const discoveryError = diagnostics.find((d) => d.severity === "error");
  if (discoveryError) {
    throw new Error(`resolveRepositoryLineVersion: ${discoveryError.message}`);
  }
  const repoLine = lines.find((line) => line.id === "repo");
  if (!repoLine) {
    throw new Error("resolveRepositoryLineVersion: no 'repo' release line discovered");
  }
  const derived = await deriveLineVersion(repoRoot, repoLine, io);
  if (derived.version === null) {
    throw new Error(
      derived.source === "version-file"
        ? "resolveRepositoryLineVersion: root package.json is missing or unparsable"
        : "resolveRepositoryLineVersion: release tag present but HEAD is unresolvable",
    );
  }
  return {
    version: derived.version,
    source: derived.source,
    lastTag: derived.lastTag?.name ?? null,
  };
}
