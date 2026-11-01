/*
<MODULE_CONTRACT>
<purpose>authority index barrel — re-exports createForgeAuthorityModule for the delegation-registry module (RFC-1336).</purpose>
<non-goals>
  <item>Do not add handler logic — that lives in handlers/.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1336: initial barrel.</item>
  <item>RFC-1336: step 1: forge authority module — delegation registry schema + resolver, four authority.* commands, optional Ed25519 signing</item>
  <item>RFC-1485: sweep compass headers — forge-os-tail</item>
</CHANGE_SUMMARY>
*/

export { createForgeAuthorityModule } from "./authority.module.ts";
