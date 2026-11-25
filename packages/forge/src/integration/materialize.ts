/*
<MODULE_CONTRACT>
<purpose>
Candidate tree materialization (Werkstatt RFC-1647) — the contract graph evaluates
the exact content that would integrate. The frozen candidate tree object is
expanded into an ephemeral filesystem root via git archive; callers own cleanup.
</purpose>
<non-goals>
  <item>No caching of materializations — evaluation frequency is human-scale.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1647 (WP-4): initial materializer.</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MaterializedTree {
  root: string;
  cleanup(): void;
}

/** Expand a git tree object into a fresh ephemeral directory. */
export function materializeTree(repoDir: string, treeDigest: string): MaterializedTree {
  const root = mkdtempSync(join(tmpdir(), "forge-candidate-"));
  // git archive writes a tar of the tree to stdout — expand in place.
  execFileSync("sh", ["-c", `git archive "${treeDigest}" | tar -x -C "${root}"`], {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
