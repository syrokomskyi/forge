/*
<MODULE_CONTRACT>
<purpose>
RFC-1152 (Wave 4): ambient async-fs shim for werkstatt-typescript model helpers
that need real Dirent semantics (isSymbolicLink) the WorkspaceIO DirEntry port
does not carry. Centralizes ambient async fs so callers stop importing
node:fs/promises directly (kernel-io-lint).
</purpose>
<non-goals>
  <item>Port plumbing — workspace-model is a pure library surface with no kernel context; async fs here is ambient by design.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Ambient fs is structural — workspace-model helpers need Dirent semantics the port lacks.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1152 Wave 4: initial ambient async fs shim.</item>
</CHANGE_SUMMARY>
*/

export { readFile, readdir } from "node:fs/promises";
