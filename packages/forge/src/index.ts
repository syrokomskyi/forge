/*
<MODULE_CONTRACT>
<purpose>Public entrypoint for @warpgogol/forge — exports ForgeModule types, canonical types, utilities, skill schema, registry, validators, onboarding, and OS modules.</purpose>
<non-goals>
  <item>Do not export internal implementation details — only public API.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial public exports for forge package.</item>
  <item>Forge autonomy refactor: add canonical types and utils exports.</item>
</CHANGE_SUMMARY>
*/

// Canonical types
export type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeCommandTiming,
  ForgeNextStep,
  ForgeFlagValue,
  ForgeFlagSpec,
  ForgeCommandMetadata,
  ForgeRegisteredCommandInfo,
  ForgeCommandDefinition,
  ForgeCommandScope,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticEvidence,
  CheckResult,
  ForgeLogger,
  CommandRegistry,
  ForgeRuntimeContext,
  ForgeSiteContext,
  ForgeOutputFormat,
  GateMetadata,
  GateSeverity,
  GatePhase,
  GateConditional,
} from "./types.ts";

// Canonical utilities
export {
  writeFileAtomic,
  type WriteFileAtomicOptions,
  GENERATED_MARKER,
  hasGeneratedMarker,
  stripGeneratedMarker,
  buildGeneratedHeader,
  isGeneratedMarkerTextCandidate,
  type GeneratedHeaderInput,
  type StripGeneratedMarkerResult,
  toKebabCase,
  collectFiles,
  fileExists,
  type CollectFilesOptions,
  byteHash,
} from "./utils/index.ts";

// ForgeModule types
export type { ForgeModule, ForgeModuleRegistry, ForgePipelineStep } from "./forge-module.ts";

// Skill schema
export { skillFrontmatterSchema, type SkillFrontmatter } from "./skill-schema.ts";

// Skill registry
export { FORGE_SKILLS, type ForgeSkillEntry } from "./registry.ts";

// Forge config (RFC-0391)
export {
  forgeConfigSchema,
  forgeBindingsSchema,
  defaultForgeConfig,
  loadForgeConfig,
  resolveForgeRoot,
  resolveBinding,
  FORGE_CLI_BINDING_DEFAULTS,
  PM_RUNNER_MAP,
  resolvePmRunner,
  applyCliBindingDefaults,
  resolvePackageManager,
  type ForgeConfig,
  type ForgeBindings,
  type ForgeCliBindingDefault,
  type ForgePackageManager,
  type ForgeMigrationAdapter,
} from "./config/forge-config.ts";

// Stack profiles (RFC-0392, RFC-0638)
export {
  stackProfileSchema,
  loadStackProfile,
  listStackProfiles,
  detectStack,
  type StackProfile,
  type ProfileFile,
} from "./profiles/stack-profile.ts";

// Profile domain fields (RFC-0638)
export {
  stackProfileDomainFieldsSchema,
  profileArtifactSchema,
  profileWorkspaceTypeSchema,
  profileInvariantSchema,
  UNIVERSAL_TERMINOLOGY_KEYS,
  TERMINOLOGY_DEFAULTS,
  type StackProfileDomainFields,
  type ProfileArtifact,
  type ProfileWorkspaceType,
  type ProfileInvariant,
} from "./profiles/profile-schema.ts";

// Validators
export { runSkillValidate } from "./validators/skill-validate.ts";
export { runPortValidate } from "./validators/port-validate.ts";

// CLI output rendering (RFC-0542)
export { renderNextSteps, renderIdeRecommendation, generateHelp } from "./cli-output.ts";

// Onboarding
export { runInit } from "./onboarding/init.ts";
export { runScaffold } from "./onboarding/scaffold.ts";
export { runDoctor } from "./onboarding/doctor.ts";
export { runAgentsGenerate } from "./onboarding/agents-generate.ts";
export { runScaffoldProject } from "./onboarding/scaffold-project.ts";

// Migration adapters (RFC-0546)
export type {
  MigrationAdapter,
  AdapterAnalysis,
  MigrationResult,
  Conflict,
} from "./migration-adapters/types.ts";
export { FORGE_PROTECTED_PATHS, DEFAULT_EXCLUDE_PATTERNS } from "./migration-adapters/types.ts";
export {
  nodeTypescriptPnpmAdapter,
  phaserPnpmAdapter,
  getAdapters,
  detectAdapter,
  detectAdapters,
} from "./migration-adapters/index.ts";

// OS modules
export { forgeCoreModule } from "../os/core/core.module.ts";
export { forgeRfcModule } from "../os/rfc/rfc.module.ts";
export { forgeWorkflowModule } from "../os/workflow/workflow.module.ts";
export { forgeNamingModule } from "../os/naming/naming.module.ts";
export { forgeCompassModule } from "../os/compass/compass.module.ts";
export { forgeWerkstattModule } from "../os/werkstatt/werkstatt.module.ts";
export { forgeSpecModule } from "../os/spec/spec.module.ts";
export { forgeAdrModule } from "../os/adr/adr.module.ts";
export { forgePlanModule } from "../os/plan/plan.module.ts";
export { forgeAuditModule } from "../os/audit/audit.module.ts";
export { forgeMissionModule } from "../os/mission/mission.module.ts";
