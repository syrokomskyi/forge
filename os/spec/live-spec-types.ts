/*
<MODULE_CONTRACT>
<purpose>Living feature spec types — contracts for living specs, delta operations,
merge results, and validation (RFC-0711).</purpose>
<non-goals>
  <item>Do not implement merge/list/show/validate logic here — only type definitions.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0711: initial living spec types — LivingSpec, DeltaOperation, DeltaConflict, merge/list/show/validate result types.</item>
  <item>RFC-1230: added already-merged to SpecLiveMergeResult.operation; added SpecLiveRebuildResult for spec.live.rebuild.</item>
  <item>RFC-1230: review findings — scoped droppedSections to namespaced headings, warn on unreadable spec, fail-fast merge on corrupt frontmatter, CHANGE_SUMMARY dedupe</item>
  <item>RFC-1234: LivingSpecViolation gains optional severity field (absent = error; errors drive exit code); uniqueRfcs contract comment states deduplicated-history semantics.</item>
</CHANGE_SUMMARY>
*/

export interface LivingSpecHistoryEntry {
  rfc: string;
  mergedAt: string;
  operation: "created" | "modified" | "removed";
}

export interface LivingSpec {
  domain: string;
  title: string;
  lastMergedRfc: string;
  updatedAt: string;
  createdAt: string;
  history: LivingSpecHistoryEntry[];
  body: string;
}

export interface SpecLiveMergeInput {
  id: string;
}

export interface DeltaOperation {
  type: "added" | "modified" | "removed";
  heading: string;
  rfc: string;
}

export interface DeltaConflict {
  heading: string;
  existingRfc: string;
  newRfc: string;
  resolution: "pending" | "resolved";
}

export interface SpecLiveMergeResult {
  command: "spec.live.merge";
  domain: string;
  operation: "created" | "modified" | "already-merged";
  deltas: DeltaOperation[];
  conflicts: DeltaConflict[];
  dryRun: boolean;
}

export interface SpecLiveRebuildResult {
  command: "spec.live.rebuild";
  domain: string;
  operation: "rebuilt" | "unchanged" | "skipped";
  /** Unique RFC ids present in the deduplicated history — unreadable or
   * not-implemented ids are still counted; the replayed count is
   * uniqueRfcs − unreadableRfcs.length. */
  uniqueRfcs: number;
  droppedHistoryEntries: number;
  droppedSections: number;
  unreadableRfcs: string[];
  dryRun: boolean;
}

export interface SpecLiveListEntry {
  domain: string;
  title: string;
  lastMergedRfc: string;
  updatedAt: string;
  historyCount: number;
}

export interface SpecLiveListResult {
  command: "spec.live.list";
  status: "ok";
  livingSpecs: SpecLiveListEntry[];
}

export interface SpecLiveShowResult {
  command: "spec.live.show";
  status: "ok";
  domain: string;
  title: string;
  lastMergedRfc: string;
  updatedAt: string;
  createdAt: string;
  history: LivingSpecHistoryEntry[];
  body: string;
}

export interface LivingSpecViolation {
  rule: string;
  message: string;
  domain?: string;
  /** Absent === "error"; only error-severity violations drive a non-zero
   * exit code (RFC-1234). */
  severity?: "error" | "warning";
}

export interface SpecLiveValidateResult {
  command: "spec.live.validate";
  status: "pass" | "fail";
  violations: LivingSpecViolation[];
  specsChecked: number;
}
