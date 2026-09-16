/*
<MODULE_CONTRACT>
<purpose>Barrel index export for forge utilities — canonical, autonomous, no @warpgogol/* dependencies.</purpose>
<non-goals>
  <item>Do not add non-utility exports here — use the appropriate forge module.</item>
  <item>Do not re-export from @warpgogol/* packages — this package must remain dependency-free.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The barrel only re-exports — no logic lives here, so import cost stays flat.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into <history>, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — packages/forge + services clean

Sweep batch 2: real KEY_DECISIONS on 10 files, expanded purposes (CONTRACT-02/PURPOSE-02), headers on mission/index + gen-upstreams, sanitizeItemText in summary.record (literal Compass tags corrupted history), excludedPaths for wrangler types, test-fixtures testPattern. forge+services now 0 diagnostics under --mode error.</item>
</CHANGE_SUMMARY>
*/

export { writeFileAtomic, type WriteFileAtomicOptions } from "./fs-atomic.ts";
export { writeFileIfChanged } from "./fs-idempotent.ts";
export {
  GENERATED_MARKER,
  EDITABLE_GENERATED_MARKER,
  hasGeneratedMarker,
  stripGeneratedMarker,
  buildGeneratedHeader,
  isGeneratedMarkerTextCandidate,
  type GeneratedHeaderInput,
  type StripGeneratedMarkerResult,
} from "./generated-marker.ts";
export { toKebabCase } from "./string-utils.ts";
export { collectFiles, fileExists, type CollectFilesOptions } from "./fs.ts";
export { byteHash } from "./hash.ts";
export { trashPath } from "./fs-trash.ts";
export { trashSync } from "./fs-trash-sync.ts";
