/*
<MODULE_CONTRACT>
<purpose>Barrel export for the forge system module (RFC-1508) — module factory,
system-map loader/validator and schemas for reuse by RFC-1509..1511.</purpose>
<non-goals>
  <item>Do not add logic here — re-exports only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1508: step 3 — system module barrel export</item>
  <item>RFC-1508: implement RFC-1508 — system profile, system map schemas and system.map.validate</item>
</CHANGE_SUMMARY>
*/

export { createForgeSystemModule } from "./system.module.ts";
export {
  assertSystemRepository,
  edgeVerdict,
  loadSystemMap,
  validateSystemMap,
  SYSTEM_DIR,
  SYSTEM_CONFIG_FILE,
  SYSTEM_PRODUCTS_FILE,
  SYSTEM_EDGES_FILE,
  SYSTEM_LOCAL_FILE,
} from "./repo.ts";
export type { EdgeVerdict, SystemMap, SystemMapLoadResult } from "./repo.ts";
export {
  edgeEntrySchema,
  productEntrySchema,
  productsLocalSchema,
  systemConfigSchema,
  systemEdgesSchema,
  systemProductsSchema,
  SYSTEM_ID_PATTERN,
} from "./schemas.ts";
export type {
  EdgeEntry,
  ProductEntry,
  ProductsLocal,
  SystemConfig,
  SystemEdges,
  SystemProducts,
} from "./schemas.ts";
