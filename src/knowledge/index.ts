/*
<MODULE_CONTRACT>
<purpose>Barrel export for the knowledge module — parser, serializer, schema, and types (RFC-0660).</purpose>
<non-goals>
  <item>Do not re-export from @warpgogol/* — forge src/ is portable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0660: initial knowledge module barrel export.</item>
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
  computeLayerBudgets,
  resolveKnowledgeBudgets,
  DEFAULT_KNOWLEDGE_BUDGETS,
  type KnowledgeBudgets,
  type LayerBudgetReport,
} from "./budgets.ts";
