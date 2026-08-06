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
  operation: "created" | "modified";
  deltas: DeltaOperation[];
  conflicts: DeltaConflict[];
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
}

export interface SpecLiveValidateResult {
  command: "spec.live.validate";
  status: "pass" | "fail";
  violations: LivingSpecViolation[];
  specsChecked: number;
}
