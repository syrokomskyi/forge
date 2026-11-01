/*
<MODULE_CONTRACT>
<purpose>Define the Zod metadata schema for knowledge entries with layer-specific refinements (RFC-0660).</purpose>
<non-goals>
  <item>Do not parse markdown — that is handled by parse.ts.</item>
  <item>Do not serialize — that is handled by serialize.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0660: initial knowledge entry metadata schema with L0/L1/L2 layer-specific refinements.</item>
  <item>RFC-0663: added promotedFrom field for shared-layer provenance tracking.</item>
  <item>RFC-1468: bind authz-relevant knowledge to authoritative sources — knowledge.rebuild + knowledge.authz.probe, KAUTHZ-01..03</item>
  <item>RFC-1481: accept upstream K-NNNN and consumer-local L-K-NNNN entry IDs and references.</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

export type KnowledgeLayer = "L0" | "L1" | "L2";
export type KnowledgeEntryStatus = "active" | "stale" | "superseded" | "archived";

const ENTRY_ID_PATTERN = /^(?:L-)?K-\d{4}$/;
const PROMOTED_TO_PATTERN = /^shared\/(?:L-)?K-\d{4}$/;
const PROMOTED_FROM_PATTERN = /^[a-z0-9-]+\/(?:L-)?K-\d{4}$/;

const baseMetaSchema = z.object({
  id: z.string().regex(ENTRY_ID_PATTERN, "id must match ^(?:L-)?K-\\d{4}$"),
  layer: z.enum(["L0", "L1", "L2"]),
  created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "created must be YYYY-MM-DD"),
  lastConfirmedAt: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
  confirmations: z.number().int().min(0).optional(),
  expiresAt: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
  supersedes: z.array(z.string().regex(ENTRY_ID_PATTERN)).optional(),
  promotedTo: z.union([z.string().regex(PROMOTED_TO_PATTERN), z.null()]).optional(),
  promotedFrom: z.array(z.string().regex(PROMOTED_FROM_PATTERN)).optional(),
  status: z.enum(["active", "stale", "superseded", "archived"]),
  // RFC-1468: closed class enum — authz-relevant entries must name their
  // authoritative source(s); factual is the additive default.
  class: z.enum(["factual", "authz-relevant"]).optional(),
  authorityRefs: z.array(z.string().min(1)).optional(),
});

export const knowledgeEntryMetaSchema = baseMetaSchema.superRefine((data, ctx) => {
  if (data.layer === "L0" || data.layer === "L1") {
    if (data.confirmations !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `confirmations is forbidden on ${data.layer} entries`,
        path: ["confirmations"],
      });
    }
    if (data.lastConfirmedAt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `lastConfirmedAt is forbidden on ${data.layer} entries`,
        path: ["lastConfirmedAt"],
      });
    }
  }

  if (data.layer === "L2") {
    if (data.confirmations === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "confirmations is required on L2 entries",
        path: ["confirmations"],
      });
    }
    if (data.lastConfirmedAt === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "lastConfirmedAt is required on L2 entries",
        path: ["lastConfirmedAt"],
      });
    }
  }
});

export type KnowledgeClass = "factual" | "authz-relevant";

export interface KnowledgeEntryMeta {
  id: string;
  layer: KnowledgeLayer;
  class?: KnowledgeClass;
  authorityRefs?: string[];
  created: string;
  lastConfirmedAt?: string | null;
  confirmations?: number;
  expiresAt?: string | null;
  supersedes?: string[];
  promotedTo?: string | null;
  promotedFrom?: string[];
  status: KnowledgeEntryStatus;
}

export interface KnowledgeEntry {
  meta: KnowledgeEntryMeta;
  title: string;
  body: string;
  lineStart: number;
}

export interface LegacySection {
  text: string;
  lineStart: number;
}

export interface ParseIssue {
  line: number;
  message: string;
  entryId?: string;
}

export interface ParsedKnowledgeFile {
  path: string;
  layer: KnowledgeLayer | null;
  preamble: string;
  entries: KnowledgeEntry[];
  legacySections: LegacySection[];
  parseIssues: ParseIssue[];
  isKnowledgeAdjacent: boolean;
}
