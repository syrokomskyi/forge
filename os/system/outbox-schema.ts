/*
<MODULE_CONTRACT>
<purpose>Product outbox schemas for dependency-contract requests (RFC-1510):
the forge/outbox@1 entry file at docs/outbox/&lt;id&gt;.yaml plus the scan-side
OutboxProposal row. An entry names a contract and never a system or serving
product — the system matches needs to offers, not the other way around.</purpose>
<non-goals>
  <item>No handler or store logic — schema and proposal types only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1510: step 2 — forge/outbox@1 schema and OutboxProposal row</item>
  <item>RFC-1510: implement RFC-1510 — product outbox for dependency-contract requests</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

export const OUTBOX_DIR = "docs/outbox";
export const OUTBOX_ID_RE = /^OB-\d{4}$/;

export const outboxEntrySchema = z
  .object({
    schema: z.literal("forge/outbox@1"),
    id: z.string().regex(OUTBOX_ID_RE),
    contract: z.string().min(1),
    need: z.string().min(1),
    why: z.string().min(1),
    state: z.enum(["open", "served", "withdrawn"]),
  })
  .strict();

export type OutboxEntry = z.infer<typeof outboxEntrySchema>;

/** One row of the system.outbox.scan projection. */
export interface OutboxProposal {
  /** The asking product. */
  product: string;
  /** Entry id, e.g. OB-0003. */
  entry: string;
  contract: string;
  /** Offering product, null when no product offers the contract. */
  target: string | null;
  verdict: "allowed" | "forbidden" | "undeclared" | "own-contract";
  /** Existing or created task for this entry. */
  taskId: string | null;
}
