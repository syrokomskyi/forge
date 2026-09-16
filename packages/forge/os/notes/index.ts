/*
<MODULE_CONTRACT>
<purpose>Notes module index — re-export createForgeNotesModule and the note validator handlers for the forge kernel.</purpose>
<non-goals>
  <item>Do not implement note logic here — handlers and the module registration live in sibling files.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0808: initial notes module index.</item>
  <item>RFC-1097: sweep — packages/forge + services clean

Sweep batch 2: real KEY_DECISIONS on 10 files, expanded purposes (CONTRACT-02/PURPOSE-02), headers on mission/index + gen-upstreams, sanitizeItemText in summary.record (literal Compass tags corrupted history), excludedPaths for wrangler types, test-fixtures testPattern. forge+services now 0 diagnostics under --mode error.</item>
</CHANGE_SUMMARY>
*/

export { createForgeNotesModule } from "./notes.module.ts";
