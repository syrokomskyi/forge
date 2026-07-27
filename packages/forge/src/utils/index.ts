/*
<MODULE_CONTRACT>
<purpose>Barrel export for forge utilities — canonical, autonomous, no @warpgogol/* dependencies.</purpose>
<non-goals>
  <item>Do not add non-utility exports here — use the appropriate forge module.</item>
  <item>Do not re-export from @warpgogol/* packages — this package must remain dependency-free.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial utility barrel: fs-atomic, generated-marker, string-utils, fs, hash.</item>
</CHANGE_SUMMARY>
*/

export { writeFileAtomic, type WriteFileAtomicOptions } from "./fs-atomic.ts";
export {
  GENERATED_MARKER,
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
