/*
<MODULE_CONTRACT>
<purpose>Thin re-export shim for RFC handlers split into handlers/ (RFC-0303).</purpose>
<non-goals>
  <item>Do not implement command logic here; implementations live in handlers/*.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0153: remove the C:/Temp debug write + debug-keys leak; make V-12 bidirectional; add V-16 (status/date coupling), V-17 (strict supersededBy), V-18 (related referential integrity vs DNA/AP/RFC); rfc.check skips glob/placeholder/prose paths.</item>
  <item>RFC-0303: split handlers.ts (1447 lines) into handlers/{shared,lifecycle,list-create,validate,check,index-graph}.ts.</item>
</CHANGE_SUMMARY>
*/

export { runRfcList, runRfcCreate, runRfcNextId } from "./handlers/list-create.ts";
export { runRfcValidate } from "./handlers/validate.ts";
export { runRfcCommandLifecycleValidate } from "./handlers/lifecycle.ts";
export { runRfcCheck } from "./handlers/check.ts";
export { runRfcIndexGenerate, runRfcIndexValidate, runRfcGraph } from "./handlers/index-graph.ts";
export { runRfcImplementStamp } from "./handlers/implement-stamp.ts";
