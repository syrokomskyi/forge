/*
<MODULE_CONTRACT>
<purpose>Version-file writes for flow.cut (RFC-1490): replace a release
line's `package.json` `"version"` field and the repo's `forge.yaml`
`syncedVersion` textually — formatting, key order and comments are
preserved — then verify the JSON result deep-equals the pre-write document
with only `version` changed. A mismatch throws VersionWriteError (the cut
maps it to FLOW-CUT-11).</purpose>
<non-goals>
  <item>No version math — semver.ts/release-level.ts decide the next version.</item>
  <item>No commits — callers stage and commit the written files.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Textual first-`"version"`-key replacement: a JSON round-trip would reformat the file; the post-write JSON deep-equal is the safety net that catches a nested `"version"` (e.g. under engines) hit by accident.</item>
  <item>`syncedVersion` is a YAML scalar — regex the whole line keeping leading indentation so comments elsewhere in forge.yaml survive.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1490: step 2 — verified textual version writes for flow.cut</item>
  <item>RFC-1490: step 2 — registry fix/port widening, FORGE_FLOW_COMMIT gitCommit helper, verified version-files writes</item>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import type { WorkspaceIO } from "../../src/types.ts";

import type { ReleaseLine } from "./release-lines.ts";

/** The verified-write contract failed — flow.cut maps this to FLOW-CUT-11. */
export class VersionWriteError extends Error {
  readonly file: string;
  constructor(file: string, detail: string) {
    super(`version write to ${file} failed verification: ${detail}`);
    this.name = "VersionWriteError";
    this.file = file;
  }
}

/**
 * Replace the FIRST `"version": "…"` key in the line's version file and
 * verify `JSON.parse(after)` deep-equals `{ ...before, version: next }`.
 * Absent file, absent/unparseable JSON, or a verification mismatch all
 * throw VersionWriteError.
 */
export async function writeLineVersion(
  worktree: string,
  line: ReleaseLine,
  nextVersion: string,
  io: WorkspaceIO,
): Promise<void> {
  if (line.versionFile === null) {
    throw new VersionWriteError("(none)", `release line '${line.id}' has no version file`);
  }
  const file = join(worktree, line.versionFile);
  if (!(await io.exists(file))) {
    throw new VersionWriteError(line.versionFile, "file does not exist");
  }
  const before = await io.readFile(file);
  let beforeDoc: Record<string, unknown>;
  try {
    beforeDoc = JSON.parse(before) as Record<string, unknown>;
  } catch (error) {
    throw new VersionWriteError(
      line.versionFile,
      `unparseable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const match = before.match(/"version"\s*:\s*"[^"]*"/);
  if (match === null || match.index === undefined) {
    throw new VersionWriteError(line.versionFile, "no top-level '\"version\"' key found");
  }
  const after = before.slice(0, match.index) + `"version": "${nextVersion}"` +
    before.slice(match.index + match[0].length);
  let afterDoc: Record<string, unknown>;
  try {
    afterDoc = JSON.parse(after) as Record<string, unknown>;
  } catch {
    throw new VersionWriteError(line.versionFile, "post-write JSON failed to parse");
  }
  const expected = JSON.stringify({ ...beforeDoc, version: nextVersion });
  if (JSON.stringify(afterDoc) !== expected) {
    throw new VersionWriteError(
      line.versionFile,
      `verified content differs — the replaced key was not the document's version field`,
    );
  }
  await io.writeFile(file, after);
}

/**
 * Replace the `syncedVersion:` scalar in forge.yaml, keeping its
 * indentation and any trailing comment. Absent file or key throws
 * VersionWriteError.
 */
export async function writeSyncedForgeVersion(
  repoRoot: string,
  nextVersion: string,
  io: WorkspaceIO,
): Promise<void> {
  const file = join(repoRoot, "forge.yaml");
  if (!(await io.exists(file))) {
    throw new VersionWriteError("forge.yaml", "file does not exist");
  }
  const before = await io.readFile(file);
  const match = before.match(/^([ \t]*)syncedVersion:\s*\S[^\n]*$/m);
  if (match === null || match.index === undefined) {
    throw new VersionWriteError("forge.yaml", "no 'syncedVersion' key found");
  }
  const after =
    before.slice(0, match.index) +
    `${match[1]}syncedVersion: ${nextVersion}` +
    before.slice(match.index + match[0].length);
  await io.writeFile(file, after);
}
