/*
<MODULE_CONTRACT>
<purpose>RFC-1253: canonical identifiers for the consumer-facing Compass docs corpus — schema id, document names, and the default bindings.paths.compassDocs value written by compass.docs.scaffold.</purpose>
<non-goals>
  <item>Do not read forge.yaml or resolve bindings — constants only; resolution lives in the scaffold/validate handlers.</item>
  <item>Do not add consumer- or stack-specific values (RFC-1096 boundary).</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Schema id is versioned (`@1`) so a future format bump can gate migration without reparsing content.</item>
  <item>Corpus membership = canonical six names ∪ binding-declared paths — DOC-04 marker checks key off this set, not filename shape alone.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1253: created — schema id, six-name corpus list, default binding paths.</item>
</CHANGE_SUMMARY>
*/

export const COMPASS_DOCS_SCHEMA_ID = "forge/compass-docs@1" as const;

/** The six documents a Compass corpus declares, in scaffold write order. */
export const CANONICAL_CORPUS_DOCS = [
  "requirements",
  "technology",
  "development-plan",
  "knowledge-graph",
  "verification-plan",
  "source-markup",
] as const;

export type CanonicalCorpusDoc = (typeof CANONICAL_CORPUS_DOCS)[number];

/** Default `bindings.paths.compassDocs` value — the six docs under `docs/`. */
export const DEFAULT_COMPASS_DOCS_BINDING: readonly string[] = CANONICAL_CORPUS_DOCS.map(
  (name) => `docs/${name}.xml`,
);

/** Docs whose skeleton is authored-intent (TODO + draft) rather than generated-from-state. */
export const DRAFT_SKELETON_DOCS: ReadonlySet<CanonicalCorpusDoc> = new Set<CanonicalCorpusDoc>([
  "requirements",
  "development-plan",
  "verification-plan",
]);
