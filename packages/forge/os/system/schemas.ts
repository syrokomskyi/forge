/*
<MODULE_CONTRACT>
<purpose>Zod schemas for the Forge system map (RFC-1508): forge/system@1,
forge/system-products@1, forge/system-edges@1 and forge/system-products-local@1.
All objects are strict — unknown keys are schema violations (SYSTEM-MAP-01).</purpose>
<non-goals>
  <item>Do not enforce cross-file rules here — SYSTEM-MAP-02..05 live in repo.ts.</item>
  <item>Do not import from @warpgogol/* — forge os/ modules stay autonomous.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1508: step 2 — system map schemas (system, products, edges, products-local)</item>
  <item>RFC-1508: review r1 — contract-exact schemas: strict objects, remote/offers, folders+launcher local map, edge note + required forbidden reason</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

/** Lowercase kebab-case id shared by system and product ids. */
export const SYSTEM_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
// forge/system@1 — system/system.yaml
// ---------------------------------------------------------------------------

export const systemSchema = z
  .object({
    schema: z.literal("forge/system@1"),
    id: z.string().regex(SYSTEM_ID_PATTERN),
    name: z.string().min(1),
    owners: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type System = z.infer<typeof systemSchema>;

// ---------------------------------------------------------------------------
// forge/system-products@1 — system/products.yaml
// ---------------------------------------------------------------------------

export const systemProductSchema = z
  .object({
    id: z.string().regex(SYSTEM_ID_PATTERN),
    remote: z.string().min(1),
    /** Contract ids this product offers to consumers (package or spec ids). */
    offers: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type SystemProduct = z.infer<typeof systemProductSchema>;

export const systemProductsSchema = z
  .object({
    schema: z.literal("forge/system-products@1"),
    products: z.array(systemProductSchema),
  })
  .strict();
export type SystemProducts = z.infer<typeof systemProductsSchema>;

// ---------------------------------------------------------------------------
// forge/system-edges@1 — system/edges.yaml
// ---------------------------------------------------------------------------

export const systemEdgeSchema = z
  .object({
    consumer: z.string().min(1),
    contract: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();
export type SystemEdge = z.infer<typeof systemEdgeSchema>;

/** A forbidden edge must carry its justification. */
export const systemForbiddenEdgeSchema = systemEdgeSchema.extend({
  reason: z.string().min(1),
});
export type SystemForbiddenEdge = z.infer<typeof systemForbiddenEdgeSchema>;

export const systemEdgesSchema = z
  .object({
    schema: z.literal("forge/system-edges@1"),
    allowed: z.array(systemEdgeSchema).default([]),
    forbidden: z.array(systemForbiddenEdgeSchema).default([]),
  })
  .strict();
export type SystemEdges = z.infer<typeof systemEdgesSchema>;

// ---------------------------------------------------------------------------
// forge/system-products-local@1 — system/products.local.yaml (gitignored, optional)
// ---------------------------------------------------------------------------

export const systemProductsLocalSchema = z
  .object({
    schema: z.literal("forge/system-products-local@1"),
    /** product id -> local checkout folder, absolute or relative to the repository root. */
    folders: z.record(z.string(), z.string().min(1)),
    /** Product-side launcher invoked by RFC-1509 dispatch ({worktree}/{task} substitution). */
    launcher: z
      .object({ argv: z.array(z.string().min(1)).min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type SystemProductsLocal = z.infer<typeof systemProductsLocalSchema>;
