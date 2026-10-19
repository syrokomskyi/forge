/*
<MODULE_CONTRACT>
<purpose>RFC-1336: authority module barrel — re-exports the module factory.</purpose>
<non-goals>
  <item>Do not add handler logic — that lives in handlers/.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1336: initial barrel.</item>
  <item>RFC-1336: step 1: forge authority module — delegation registry schema + resolver, four authority.* commands, optional Ed25519 signing</item>
</CHANGE_SUMMARY>
*/

export { createForgeAuthorityModule } from "./authority.module.ts";
