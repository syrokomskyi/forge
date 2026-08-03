/*
<MODULE_CONTRACT>
<purpose>Barrel export for the knowledge module — parser, serializer, schema, and types (RFC-0660).</purpose>
<non-goals>
  <item>Do not re-export from @warpgogol/* — forge src/ is portable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0660: initial knowledge module barrel export.</item>
  <item>RFC-0663: added promote.ts exports for cross-skill duplicate detection and promotion planning.</item>
</CHANGE_SUMMARY>
*/

export { parseKnowledgeFile } from "./parse.ts";
export { serializeKnowledgeFile } from "./serialize.ts";
export {
  knowledgeEntryMetaSchema,
  type KnowledgeLayer,
  type KnowledgeEntryStatus,
  type KnowledgeEntryMeta,
  type KnowledgeEntry,
  type LegacySection,
  type ParseIssue,
  type ParsedKnowledgeFile,
} from "./schema.ts";
export {
  planCompaction,
  executeCompaction,
  resolveRetentionDays,
  resolveStaleDays,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_STALE_DAYS,
  type CompactOptions,
  type CompactAction,
  type CompactActionKind,
  type CompactFilePlan,
  type CompactFileResult,
  type CompactReport,
} from "./compact.ts";
export {
  computeLayerBudgets,
  resolveKnowledgeBudgets,
  DEFAULT_KNOWLEDGE_BUDGETS,
  type KnowledgeBudgets,
  type LayerBudgetReport,
} from "./budgets.ts";
export {
  normalizeTitle,
  detectDuplicatePrinciples,
  planPromotion,
  type DuplicatePair,
  type PromotionPlan,
} from "./promote.ts";
