/*
<MODULE_CONTRACT>
<purpose>
Canonical directory spelling for cross-frame path comparison. Git answers
path queries (`worktree list`, `rev-parse`) in its own resolved frame —
forward slashes and the on-disk long name — while Node-side callers often
carry the user's raw path, which on Windows may be an 8.3 alias or differ
in casing. String math between the two frames silently produces `..`
escapes instead of matches; canonicalRepoDir normalizes a directory to the
native real path so comparisons mean what they look like.
</purpose>
<non-goals>
  <item>Not a symlink policy — callers that must NOT resolve symlinks keep plain path.resolve.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>realpathSync.native resolves 8.3 aliases and on-disk casing; on failure the input passes through so degrade paths stay inspectable.</item>
  <item>The `\\?\` extended-length prefix native realpath returns on Windows is stripped — plain path.relative/join math still applies to the result.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>T-0007: promoted from os/compass git-revision so os/flow worktree/registry helpers share one canonicalization.</item>
</CHANGE_SUMMARY>
*/

import { realpathSync } from "./sync-fs.ts";

/**
 * Canonical directory form for cross-source path comparisons. On Windows a
 * tempdir may arrive as an 8.3 alias (`...\RUNNER~1\...`) while git reports
 * the long form from `--show-toplevel` — string math between the two frames
 * silently produces `..` escapes instead of matches. The native realpath
 * resolves aliases and on-disk casing; the `\\?\` extended-length prefix it
 * returns there is stripped so plain path.relative math still applies.
 */
export function canonicalRepoDir(dir: string): string {
  let real: string;
  try {
    real = realpathSync.native(dir);
  } catch {
    try {
      real = realpathSync(dir);
    } catch {
      return dir;
    }
  }
  if (real.startsWith("\\\\?\\UNC\\")) return `\\\\${real.slice(8)}`;
  if (real.startsWith("\\\\?\\")) return real.slice(4);
  return real;
}
