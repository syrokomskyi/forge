/*
<MODULE_CONTRACT>
<purpose>Public surface of the forge correctness contour (RFC-1578): module
factory, manifest contracts, and the validator core.</purpose>
<non-goals>
  <item>No logic — re-exports only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1578: initial exports.</item>
  <item>RFC-1579: correctness.audit core for the werkstatt ecosystem.commit early run.</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
</CHANGE_SUMMARY>
*/

export { createForgeCorrectnessModule } from "./correctness.module.ts";
export * from "./manifest-schema.ts";
export { validateCorrectnessManifest, evaluateCapture } from "./handlers/validate.ts";
export { readCorrectnessSettings, normalizeCheckRef, normalizeRelPath } from "./workspace.ts";
export { runCorrectnessAudit, type AuditOptions, type AuditOutcome } from "./audit/run.ts";
export { isAuditRelevant } from "./audit/snapshot.ts";
export type { AuditFinding, AuditResult, AuditCheckId } from "./audit/types.ts";
