/*
<MODULE_CONTRACT>
<purpose>TypeScript contracts for the forge pinned-files protection system (RFC-0733).
Defines the manifest, entry, violation, and result types used by pinned.init,
pinned.validate, and the shared pre-check utility.</purpose>
<non-goals>
  <item>Does not implement validation logic — use pinned-check.ts and pinned-validate.ts.</item>
  <item>Does not implement manifest creation — use pinned-init.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0733: initial pinned-files type contracts — PinnedEntry, PinnedManifest, PinnedViolation, PinnedValidateOptions, PinnedValidateResult.</item>
</CHANGE_SUMMARY>
*/

export type PinnedMode = "protect" | "freeze";

export type PinnedOperation = "delete" | "move" | "modify";

export interface PinnedEntry {
  path: string;
  mode: PinnedMode;
  reason: string;
}

export interface PinnedManifest {
  pinned: PinnedEntry[];
}

export interface PinnedViolation {
  path: string;
  mode: PinnedMode;
  operation: PinnedOperation;
  reason: string;
}

export type PinnedValidateMode = "staged" | "ci";

export interface PinnedValidateOptions {
  allowPinnedOverride?: string[];
  mode?: PinnedValidateMode;
  json?: boolean;
}

export interface PinnedValidateResult {
  command: "pinned.validate";
  status: "pass" | "fail";
  violations: PinnedViolation[];
  overrides: string[];
}
