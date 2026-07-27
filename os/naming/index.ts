/*
<MODULE_CONTRACT>
<purpose>Expose forge naming lint command handlers through a stable package subpath.</purpose>
<non-goals>
  <item>Do not register project-specific naming commands.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial naming module barrel.</item>
</CHANGE_SUMMARY>
*/

export { forgeNamingModule } from "./naming.module.ts";
export { runNamingConventionLint } from "./naming-convention.ts";
