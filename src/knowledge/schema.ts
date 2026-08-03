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
</CHANGE_SUMMARY>
*/

import { z } from "zod";

export type KnowledgeLayer = "L0" | "L1" | "L2";
export type KnowledgeEntryStatus = "active" | "stale" | "superseded" | "archived";

const ENTRY_ID_PATTERN = /^K-\d{4}$/;
const PROMOTED_TO_PATTERN = /^shared\/K-\d{4}$/;

const baseMetaSchema = z.object({
  id: z.string().regex(ENTRY_ID_PATTERN, "id must match ^K-\\d{4}$"),
  layer: z.enum(["L0", "L1", "L2"]),
  created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "created must be YYYY-MM-DD"),
  lastConfirmedAt: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
  confirmations: z.number().int().min(0).optional(),
  expiresAt: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
  supersedes: z.array(z.string().regex(ENTRY_ID_PATTERN)).optional(),
  promotedTo: z.union([z.string().regex(PROMOTED_TO_PATTERN), z.null()]).optional(),
  status: z.enum(["active", "stale", "superseded", "archived"]),
});

export const knowledgeEntryMetaSchema = baseMetaSchema.superRefine((data, ctx) => {
  if (data.layer === "L0") {
    if (data.confirmations !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "confirmations is forbidden on L0 entries",
        path: ["confirmations"],
      });
    }
    if (data.lastConfirmedAt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "lastConfirmedAt is forbidden on L0 entries",
        path: ["lastConfirmedAt"],
      });
    }
  }

  if (data.layer === "L1") {
    if (data.confirmations !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "confirmations is forbidden on L1 entries",
        path: ["confirmations"],
      });
    }
    if (data.lastConfirmedAt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "lastConfirmedAt is forbidden on L1 entries",
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

export interface KnowledgeEntryMeta {
  id: string;
  layer: KnowledgeLayer;
  created: string;
  lastConfirmedAt?: string | null;
  confirmations?: number;
  expiresAt?: string | null;
  supersedes?: string[];
  promotedTo?: string | null;
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
