/*
<MODULE_CONTRACT>
<purpose>os/agent barrel — re-exports the forgeAgentModule and delegate handlers for kernel/module-map resolution and engine-side tests.</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1464: barrel re-exports</item>
  <item>RFC-1464: delegate mechanical task classes to cheap tier — agent.delegate, tiers.validate, invoke adapters</item>
  <item>RFC-1485: sweep compass headers — forge-os-tail</item>
</CHANGE_SUMMARY>
*/

export { forgeAgentModule } from "./agent.module.ts";
export { runAgentDelegate, loadDelegable } from "./handlers/agent-delegate.ts";
export { runAgentTiersValidate } from "./handlers/agent-tiers-validate.ts";
export { invokeCheapTier, loadBinding, validateBindingShape } from "./invoke-adapter.ts";
