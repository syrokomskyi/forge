/*
<MODULE_CONTRACT>
<purpose>Expose the forge Compass kernel module through a stable package subpath.</purpose>
<non-goals>
  <item>Do not implement compass handler logic.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial compass module barrel.</item>
</CHANGE_SUMMARY>
*/

export { forgeCompassModule } from "./compass.module.ts";
