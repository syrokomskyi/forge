/*
<MODULE_CONTRACT>
<purpose>Zod schemas for the Forge system map (RFC-1508): forge/system@1,
forge/system-products@1, forge/system-edges@1 and forge/system-products-local@1.</purpose>
<non-goals>
  <item>Do not enforce cross-file rules here — SYSTEM-MAP-02..05 live in repo.ts.</item>
  <item>Do not import from @warpgogol/* — forge os/ modules stay autonomous.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1508: step 2 — system map schemas (system, products, edges, products-local)</item>
  <item>RFC-1508: implement RFC-1508 — system profile, system map schemas and system.map.validate</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

/** Lowercase kebab-case id shared by system, product and edge consumer ids. */
export const SYSTEM_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
// forge/system@1 — system/system.yaml
// ---------------------------------------------------------------------------

export const systemConfigSchema = z.object({
  schema: z.literal("forge/system@1"),
  id: z.string().regex(SYSTEM_ID_PATTERN, "system id must be lowercase kebab-case"),
  name: z.string().min(1),
  owners: z.array(z.string().min(1)).min(1),
  notes: z.string().optional(),
});
export type SystemConfig = z.infer<typeof systemConfigSchema>;

// ---------------------------------------------------------------------------
// forge/system-products@1 — system/products.yaml
// ---------------------------------------------------------------------------

export const productEntrySchema = z.object({
  id: z.string().regex(SYSTEM_ID_PATTERN, "product id must be lowercase kebab-case"),
  name: z.string().min(1),
  url: z.string().min(1),
  offers: z.array(z.string().min(1)).default([]),
});
export type ProductEntry = z.infer<typeof productEntrySchema>;

export const systemProductsSchema = z.object({
  schema: z.literal("forge/system-products@1"),
  products: z.array(productEntrySchema).default([]),
});
export type SystemProducts = z.infer<typeof systemProductsSchema>;

// ---------------------------------------------------------------------------
// forge/system-edges@1 — system/edges.yaml
// ---------------------------------------------------------------------------

export const edgeEntrySchema = z.object({
  consumer: z
    .string()
    .regex(SYSTEM_ID_PATTERN, "edge consumer must be a lowercase kebab-case product id"),
  contract: z.string().min(1),
});
export type EdgeEntry = z.infer<typeof edgeEntrySchema>;

export const systemEdgesSchema = z.object({
  schema: z.literal("forge/system-edges@1"),
  allowed: z.array(edgeEntrySchema).default([]),
  forbidden: z.array(edgeEntrySchema).default([]),
});
export type SystemEdges = z.infer<typeof systemEdgesSchema>;

// ---------------------------------------------------------------------------
// forge/system-products-local@1 — system/products.local.yaml (gitignored, optional)
// ---------------------------------------------------------------------------

export const productsLocalSchema = z.object({
  schema: z.literal("forge/system-products-local@1"),
  products: z.array(z.string().regex(SYSTEM_ID_PATTERN)).default([]),
});
export type ProductsLocal = z.infer<typeof productsLocalSchema>;
