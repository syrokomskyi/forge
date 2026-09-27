/*
<MODULE_CONTRACT>
<purpose>
RFC-1152 (Wave 2a): sync ambient filesystem shim for forge helpers that cannot
take the async WorkspaceIO port without a signature ripple (module-evaluation
consts like FORGE_SKILLS, sync validators). Centralizes ambient sync fs so
migrated modules stop importing node:fs directly — the excluded ambient layer
stays the default for the standalone forge CLI.
</purpose>
<non-goals>
  <item>Do not add async variants — async codepaths use resolveIo from utils/io.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Sync helpers stay ambient — WorkspaceIO is async-only; forcing async would ripple signatures across the forge CLI surface.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1152 Wave 2a: initial sync fs shim for forge ambient layer.</item>
</CHANGE_SUMMARY>
*/

export type { Dirent, Stats } from "node:fs";
export {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  lstatSync,
  rmSync,
  cpSync,
  renameSync,
  unlinkSync,
  copyFileSync,
  realpathSync,
  chmodSync,
} from "node:fs";
export { execSync, execFileSync } from "node:child_process";
// Async process primitives for the forge ambient layer — os/ handlers spawn
// git/npm/pnpm; these stay ambient (identical to execSync carve-out).
export { exec, execFile, spawn } from "node:child_process";
