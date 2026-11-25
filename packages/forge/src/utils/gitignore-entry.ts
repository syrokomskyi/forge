/*
<MODULE_CONTRACT>
<purpose>Ensure a .gitignore entry exists — idempotent, line-exact, append-only.
Generated-artifact writers (skills tree, forge state) use this so generated
output never counts as worktree dirt. Never reorders or rewrites existing lines.</purpose>
<CHANGE_SUMMARY><item>RFC-1648 WP-5-depth: initial — skills-tree untracking support.</item></CHANGE_SUMMARY>
*/

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/** Ensure `entry` appears as a line in `<workspaceRoot>/.gitignore`; returns true when added. */
export function ensureGitignoreEntry(workspaceRoot: string, entry: string): boolean {
  const gitignorePath = join(workspaceRoot, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${entry}\n`, "utf8");
    return true;
  }
  const existing = readFileSync(gitignorePath, "utf8");
  if (existing.split("\n").some((line) => line.trim() === entry)) return false;
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(gitignorePath, `${sep}${entry}\n`, "utf8");
  return true;
}
