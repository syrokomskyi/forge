/*
<MODULE_CONTRACT>
<purpose>Barrel export for the rfc domain — types, constants, module, and handlers.</purpose>
<non-goals>
  <item>Do not implement RFC logic here; delegate to handlers.js and rfc.module.js.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Backfilled complete Compass header (MODULE_MAP, CHANGE_SUMMARY) for compliance.</item>
</CHANGE_SUMMARY>
*/

export { forgeRfcModule } from "./rfc.module.ts";
export {
  listRfcFiles,
  parseRfcFile,
  readAndParseRfc,
  rfcFileMatchesId,
  getRfcStatusById,
  loadRfcStatusMap,
  type ParsedRfc,
} from "./frontmatter-io.ts";
export {
  runRfcList,
  runRfcCreate,
  runRfcValidate,
  runRfcCommandLifecycleValidate,
  runRfcCheck,
} from "./handlers.ts";
export { runRfcImplementStamp } from "./handlers/implement-stamp.ts";
export { runRfcAcceptanceRun, runProbe, validateAcceptanceShape } from "./acceptance.ts";
export { runRfcVerificationEmit, buildEvidenceEnvelope } from "./verification-evidence.ts";
export { runRfcDnaTraceValidate, runRfcDnaTraceGenerate, buildDnaTrace } from "./dna-trace.ts";
export type { DnaTraceEntry, DnaTraceResult } from "./dna-trace.ts";
export { collectDecisionLog, scoreDecisions, runRfcDecisionLogGenerate } from "./decision-log.ts";
export { runRfcSupersedePropose } from "./handlers/supersede-propose.ts";
export { runRfcArchive } from "./handlers/archive.ts";
export {
  evaluateAcceptanceCriteria,
  extractAcceptanceCriteriaSection,
  type AcceptanceCriteriaEvaluation,
} from "./handlers/validate-rules.ts";
export type {
  RfcArchiveResult,
  ArchiveMove as RfcArchiveMove,
  ArchiveSkip as RfcArchiveSkip,
} from "./handlers/archive.ts";
export type {
  DecisionLogEntry,
  DecisionLogEntryKind,
  DecisionLogResult,
  ConsultedDecision,
  RfcSupersedeProposeResult,
} from "./types.ts";
export type {
  RfcImplementStampData,
  RfcImplementStampRule,
  RfcImplementStampViolation,
  RfcImplementStampResult,
} from "./types.ts";
export type {
  RfcStatus,
  RfcKind,
  RfcScope,
  RfcCommands,
  RfcFrontmatter,
  RfcListEntry,
  RfcListResult,
  RfcCreateResult,
  RfcValidationViolation,
  RfcValidationResult,
  RfcCommandLifecycleViolation,
  RfcCommandLifecycleValidationResult,
  RfcCheckViolation,
  RfcCheckResult,
  AcceptanceProbe,
  ProbeResult,
  RfcAcceptanceRunResult,
  VerificationEvidence,
  VerificationEvidenceProbeRecord,
  RfcVerificationEmitResult,
} from "./types.ts";
export {
  RFC_STATUSES,
  RFC_KINDS,
  RFC_SCOPES,
  RFC_DIR,
  RFC_TEMPLATE_FILE,
  RFC_ID_PATTERN,
  RFC_FULL_REQUIRED_SECTIONS,
  RFC_METADATA_CUTOFF,
} from "./types.ts";
