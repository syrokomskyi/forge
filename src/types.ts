/*
<MODULE_CONTRACT>
<purpose>Canonical forge runtime types — autonomous, no @gogol/* dependencies.
Structurally compatible with @gogol/site-kernel types so that forge modules
can be registered in a WGogol kernel without direct dependency.</purpose>
<non-goals>
  <item>Do not import from @gogol/site-kernel or any @gogol/* package.</item>
  <item>Do not add WGogol-specific fields to ForgeRuntimeContext — keep it minimal and portable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial canonical forge types: ForgeCommandInput, ForgeCommandResult, ForgeRuntimeContext, ForgeFlagSpec, Diagnostic, CommandRegistry, ForgeLogger.</item>
  <item>RFC-0518: add GateMetadata, GateSeverity, GatePhase, GateConditional types and optional gate field to ForgeCommandMetadata (structurally compatible with @gogol/site-kernel).</item>
</CHANGE_SUMMARY>
*/

// ---------------------------------------------------------------------------
// Command input / output
// ---------------------------------------------------------------------------

export type ForgeFlagValue = boolean | string | string[];

export interface ForgeCommandInput {
  argv: string[];
  args: string[];
  flags: Record<string, ForgeFlagValue>;
}

export interface ForgeCommandTiming {
  durationMs?: number;
  startedAt?: string;
  endedAt?: string;
}

export interface ForgeNextStep {
  action: string;
  kind: "required" | "optional";
}

export interface ForgeCommandResult<TData = unknown> {
  data?: TData;
  nextSteps?: ForgeNextStep[];
  exitCode?: number;
  summary?: string;
  timing?: ForgeCommandTiming;
}

// ---------------------------------------------------------------------------
// Flag specs (RFC-0260 lineage)
// ---------------------------------------------------------------------------

export interface ForgeFlagSpec {
  kind: "boolean" | "string" | "string[]";
  required?: boolean;
  default?: ForgeFlagValue;
  description: string;
}

// ---------------------------------------------------------------------------
// Command metadata / definition
// ---------------------------------------------------------------------------

export type ForgeCommandScope = "app" | "workspace";

export interface ForgeCommandMetadata {
  description: string;
  scope: ForgeCommandScope;
  mutatesState?: boolean;
  requiresNetwork?: boolean;
  supportsAllSites?: boolean;
  timeoutMs?: number;
  expectedDurationMs?: number;
  longRunning?: boolean;
  cacheable?: boolean;
  /**
   * RFC-0518: declarative gate metadata. Optional. Structurally compatible
   * with GateMetadata from @gogol/site-kernel. Does NOT affect execution.
   */
  gate?: GateMetadata;
}

// ---------------------------------------------------------------------------
// RFC-0518: declarative gate metadata (structurally compatible with @gogol/site-kernel)
// ---------------------------------------------------------------------------

export type GateSeverity = "error" | "warning" | "mixed";
export type GatePhase = "author" | "postbuild" | "workspace" | "mission" | "release";

export interface GateConditional {
  kind: "entitlement" | "flag" | "config";
  ref: string;
  description: string;
}

export interface GateMetadata {
  severity: GateSeverity;
  phase: GatePhase;
  conditional?: GateConditional;
  surfaces?: string[];
  rules?: string[];
  blocks?: string[];
}

export interface ForgeRegisteredCommandInfo extends ForgeCommandMetadata {
  name: string;
  provider: "workspace" | "site";
  siteName?: string;
  module?: string;
  flags?: Record<string, ForgeFlagSpec>;
  reads?: string[];
  writes?: string[];
}

export interface ForgeCommandDefinition<TData = unknown> extends ForgeCommandMetadata {
  name: string;
  flags?: Record<string, ForgeFlagSpec>;
  reads?: string[];
  writes?: string[];
  execute(
    input: ForgeCommandInput,
    context: ForgeRuntimeContext,
  ): Promise<void | ForgeCommandResult<TData>> | void | ForgeCommandResult<TData>;
}

// ---------------------------------------------------------------------------
// Diagnostic (RFC-0203 lineage)
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface DiagnosticEvidence {
  kind: "rule" | "rendered" | "source" | "config" | "cache" | "runtime";
  ruleFile?: string;
  ruleId?: string;
  file?: string;
  url?: string;
  snippet?: string;
}

export interface Diagnostic {
  ruleId: string;
  severity: DiagnosticSeverity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  fixHint?: string;
  evidence?: DiagnosticEvidence[];
  data?: Record<string, unknown>;
  id?: string;
  blockId?: string;
  suggestion?: string;
}

export interface CheckResult {
  command: string;
  status: "pass" | "warn" | "fail";
  diagnostics: Diagnostic[];
  summary: { error: number; warning: number; info: number };
}

// ---------------------------------------------------------------------------
// Logger — minimal, structurally compatible with KernelLogger
// ---------------------------------------------------------------------------

export interface ForgeLogger {
  section(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
  success(message: string, details?: unknown): void;
}

// ---------------------------------------------------------------------------
// CommandRegistry — interface injection for command discovery
// ---------------------------------------------------------------------------

export interface CommandRegistry {
  listCommandNames(): string[];
  listCommands(): ForgeRegisteredCommandInfo[];
  getCommand(name: string): ForgeCommandDefinition | undefined;
}

// ---------------------------------------------------------------------------
// Runtime context — minimal, portable
// ---------------------------------------------------------------------------

export type ForgeOutputFormat = "pretty" | "json";

export interface ForgeSiteContext {
  name: string;
  directory: string;
  toolsDirectory: string;
  configPath?: string;
  packageName?: string;
}

export interface ForgeRuntimeContext {
  workspaceRoot: string;
  logger: ForgeLogger;
  dryRun: boolean;
  outputFormat: ForgeOutputFormat;
  /**
   * Optional command registry — provided by the runner (forge CLI or site-kernel).
   * Forge commands that need to discover other commands (e.g. rfc lifecycle validation)
   * access this through the context instead of importing a kernel-specific function.
   */
  commandRegistry?: CommandRegistry;
  /** Optional target site/app context — provided when running in app-scoped mode. */
  site?: ForgeSiteContext;
  /** True only when --site <name> was passed explicitly by the caller. */
  siteExplicit?: boolean;
  /**
   * Optional forge root override — provided when a command is called from
   * another command (e.g. forge.create delegates to forge.init and forge.scaffold
   * in a new directory where resolveForgeRoot would fail). When set, handlers
   * use this instead of calling resolveForgeRoot(workspaceRoot).
   */
  forgeRoot?: string;
}
