/*
<MODULE_CONTRACT>
<purpose>Public index entrypoint for @warpgogol/forge — exports ForgeModule types, canonical types, utilities, skill schema, registry, validators, onboarding, and OS modules.</purpose>
<non-goals>
  <item>Do not export internal implementation details — only public API.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial public exports for forge package.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — packages/forge + services clean

Sweep batch 2: real KEY_DECISIONS on 10 files, expanded purposes (CONTRACT-02/PURPOSE-02), headers on mission/index + gen-upstreams, sanitizeItemText in summary.record (literal Compass tags corrupted history), excludedPaths for wrangler types, test-fixtures testPattern. forge+services now 0 diagnostics under --mode error.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
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
  EDITABLE_GENERATED_MARKER,
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
  resolveTerminology,
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

// Knowledge module (RFC-0660)
export {
  parseKnowledgeFile,
  serializeKnowledgeFile,
  knowledgeEntryMetaSchema,
  type KnowledgeLayer,
  type KnowledgeEntryStatus,
  type KnowledgeEntryMeta,
  type KnowledgeEntry,
  type LegacySection,
  type ParseIssue,
  type ParsedKnowledgeFile,
} from "./knowledge/index.ts";

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
export { scaffoldMemoryLayer, type MemoryScaffoldResult } from "./onboarding/memory-scaffold.ts";

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

// Plugin manifest (RFC-0941, RFC-0943)
export {
  forgePluginManifestSchema,
  type ForgePluginManifest,
} from "./plugin/forge-plugin-manifest.ts";

// Compass contract types (RFC-0943)
export type {
  CompassContractBlockSpec,
  CompassContractRequiredTag,
  CompassContractExtensionPoint,
  CompassContractRegistry,
  CompassContractRegistryEntry,
  CompassContractValidationDiagnostic,
} from "./compass/types.ts";

// OS modules
export { createForgeCoreModule } from "../os/core/core.module.ts";
export { createForgeRfcModule } from "../os/rfc/rfc.module.ts";
export { createForgeWorkflowModule } from "../os/workflow/workflow.module.ts";
export { createForgeNamingModule } from "../os/naming/naming.module.ts";
export { forgeCompassModule } from "../os/compass/compass.module.ts";
export { forgeWerkstattModule } from "../os/werkstatt/werkstatt.module.ts";
export { createForgeSpecModule } from "../os/spec/spec.module.ts";
export { createForgeAdrModule } from "../os/adr/adr.module.ts";
export { createForgePlanModule } from "../os/plan/plan.module.ts";
export { createForgeAuditModule } from "../os/audit/audit.module.ts";
export { createForgeMissionModule } from "../os/mission/mission.module.ts";
export { createForgeExplorationModule } from "../os/exploration/exploration.module.ts";
export { createForgeNotesModule } from "../os/notes/notes.module.ts";
export { createForgeProgramModule } from "../os/program/program.module.ts";
export { forgePluginModule } from "../os/plugin/plugin.module.ts";
