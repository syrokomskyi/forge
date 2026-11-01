/*
<MODULE_CONTRACT>
<purpose>Barrel for forgeContextModule — re-exports the context module registration and the index-build/context-assemble/slate-eval handler entry points.</purpose>
<non-goals>
  <item>Command declarations and IO — those live in context.module.ts and the handlers; this file only re-exports.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-os-context</item>
</CHANGE_SUMMARY>
*/

export { forgeContextModule } from "./context.module.ts";
export { runIndexBuild } from "./handlers/index-build.ts";
export { runContextAssemble } from "./handlers/context-assemble.ts";
export { runSlateEval } from "./handlers/context-slate-eval.ts";
