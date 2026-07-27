/*
<MODULE_CONTRACT>
<purpose>Expose the forge core kernel module through a stable package subpath.</purpose>
<non-goals>
  <item>Do not implement handler logic.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial core module barrel.</item>
</CHANGE_SUMMARY>
*/

export { forgeCoreModule } from "./core.module.ts";
