/*
<MODULE_CONTRACT>
<purpose>Canonical forge runtime types — autonomous, no @warpgogol/* dependencies.
Structurally compatible with @warpgogol/site-kernel types so that forge modules
can be registered in a Warpgogol kernel without direct dependency.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/site-kernel or any @warpgogol/* package.</item>
  <item>Do not add Warpgogol-specific fields to ForgeRuntimeContext — keep it minimal and portable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1360: step 2 — env-input declaration sweep (59 commands)

Declare every reachable env read on its owning command across engine/site/
forge (fresh full-registry replay worklist: 151 ENV-INPUT-01, 60 commands).
ForgeCommandMetadata gains the mirrored envInputs contract field. The
npm_execpath ambient read in open-source-page.ts is removed for a
deterministic PATH spawn (DNA-105) — undeclarable name class, ledger Q-9.</item>
  <item>RFC-1366: kernel resolves mission workpieceEnv + KERNEL-ENV-01 gate on required envInputs</item>
  <item>RFC-1461: declare rules[] severity via CommandRuleDecl workspace-wide (RFC-1461)</item>
  <item>RFC-1463: composite gates report complete violation sets and self-ensure prerequisites — ensure/compositeGate metadata, executor ensure runner, blockedBy skip tracking, ENSURE-01..04 + GATE-CMP-01, runCompositeGate</item>
  <item>RFC-1486: review r1 — committed-state adoption gate, uncommitted-hook committedness, step-failure trail, idempotency declaration, lazy asset resolution</item>
  <history>RFC-0518, RFC-1097, RFC-1147, RFC-1231, RFC-1306, RFC-1354</history>
</CHANGE_SUMMARY>
*/

// RFC-1152: WorkspaceIO port types — declared locally so the standalone npm
// build needs no @warpgogol/* package (ADR-0019). Structurally identical to
// @warpgogol/werkstatt-shared/kernel/workspace-io — kernel callers passing a
// real WorkspaceIO (context.io) are assignable both ways.

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Extra environment variables merged over `process.env` for the child. */
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * A directory entry in a port-neutral shape — no `node:fs` `Dirent` leaks
 * through the port, so command modules never need to import `node:fs` just to
 * type a listing. `isFile`/`isDirectory` are plain booleans (not methods).
 */
export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

/** Port-neutral `stat` result — no `node:fs` `Stats` leaks through the port. */
export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  mtimeMs: number;
  size: number;
}

export interface WorkspaceIO {
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  glob(pattern: string, opts?: { cwd?: string }): Promise<string[]>;
  /** List a directory's immediate entries. Read-only; throws if the path is not a directory. */
  readdir(path: string): Promise<DirEntry[]>;
  /** File metadata in a port-neutral shape. Throws when the path does not exist. */
  stat(path: string): Promise<FileStat>;
  /** Resolve symlinks to the canonical absolute path. Read-only. */
  realpath(path: string): Promise<string>;
  /** Atomic by contract (rfc-0258). */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /** Append content to a file, creating it (and parent dirs) when absent. */
  appendFile(path: string, content: string | Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
  copyFile(src: string, dst: string): Promise<void>;
  /** Create a unique temporary directory under `prefix`; returns its path. */
  mkdtemp(prefix: string): Promise<string>;
  exec(command: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  /**
   * RFC-1176: `true` only on the read-only adapter (`mutatesState: false`
   * commands). Best-effort bookkeeping writes must be skipped with
   * `if (!io.readonly)` instead of attempting a mutation that throws
   * KERNEL-META-01 — the throw stays as the enforcement floor for
   * undeclared mutations. Undefined on real and recording adapters.
   */
  readonly readonly?: boolean;
}

/**
 * RFC-0960: Declared generated artifact specification on a kernel command.
 * Lives on `ForgeCommandMetadata.generates[]` and is the source of truth
 * for the derived generator ownership map.
 */
export interface GeneratedArtifactSpec {
  /** Workpiece-relative path or glob, e.g. "src/content/system-health.generated.yaml". */
  path: string;
  /** Skip absence checks (RFC-0636 semantics) — e.g. produced only in build.post. */
  conditional?: boolean;
  /** Pipeline phase that produces it: informs which validator phase may assert existence. */
  phase: "build.prepare" | "build.post" | "on-demand";
  /**
   * Override the default markerPolicy derivation. Default: public/** → "registry-only",
   * everything else → "embedded". Set explicitly only for edge cases (e.g. .cache/pdf/**).
   */
  markerPolicy?: "embedded" | "registry-only";
  /**
   * Committed bytes contain non-deterministic fields (Ed25519 proofs, real-time
   * created/generatedAt timestamps, build durations) — byte-compare against a
   * dryRun render can never pass. generated.drift.validate skips volatile
   * artifacts; existence/staleness/signature checks still apply elsewhere.
   */
  volatile?: boolean;
}

// ---------------------------------------------------------------------------
// Command input / output
// ---------------------------------------------------------------------------

export type ForgeFlagValue = boolean | string | string[];

export interface ForgeCommandInput {
  argv: string[];
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
  /**
   * Filesystem-scoped mutation capability — structurally mirrors
   * KernelCommandMetadata. Delegated `executeKernelCommand` calls attribute
   * their writes to the callee, whose own declaration owns those paths; a
   * read-only orchestrator stays `mutatesState: false` and MUST NOT
   * re-declare the callee's writes (single writer per path).
   */
  mutatesState?: boolean;
  /**
   * RFC-1176: permits `io.exec` on the read-only adapter — the command
   * declares `mutatesState: false` but legitimately shells out for
   * read-only probes. Structurally mirrors KernelCommandMetadata.
   */
  execOnReadOnly?: boolean;
  /**
   * RFC-1176: flag names whose truthy presence upgrades this invocation to
   * a real (or `--dry-run` recording) adapter. Structurally mirrors
   * KernelCommandMetadata.
   */
  mutatingFlags?: string[];
  /**
   * RFC-1327: rerun-safety class for mutating commands — structurally
   * mirrors KernelCommandMetadata. `rerun-safe` requires a sibling
   * `*.rerun.test.ts` (command.idempotency.validate IDEMP-02); meaningful
   * only with `mutatesState: true`.
   */
  idempotency?: "rerun-safe" | "resume-only" | "not-idempotent";
  /** RFC-1327: explains the class — required for `not-idempotent`. */
  idempotencyNote?: string;
  /**
   * RFC-1303: environment variable names whose values this command reads
   * (`process.env.*` reachable from its handler). Names only
   * (`^[A-Z_][A-Z0-9_]*$`); declared inputs are hashed — never the raw
   * values — into the result-cache key. Undeclared env reads on a cacheable
   * command emit ENV-INPUT-01 (error); on non-cacheable commands, a warning.
   * RFC-1366: `required: true` entries are enforced by KERNEL-ENV-01.
   * Structurally mirrors KernelCommandMetadata.
   */
  envInputs?: Array<{ name: string; required: boolean }>;
  /**
   * RFC-0960/0810: repo-relative path to the implementing module file —
   * propagated into generator ownership entries (OWN-XCHECK-03 requires it
   * on every command that declares generates[]).
   */
  modulePath?: string;
  /** The command performs network egress (remote APIs, git push, DHT). Informational manifest metadata. */
  requiresNetwork?: boolean;
  acceptsAllFlag?: boolean;
  /** RFC-0963: validation contract this command belongs to (e.g. "content", "seo"). */
  contract?: string;
  /** RFC-0963: rules this validator can emit, with declared severity. Empty for non-emitting validators. */
  rules?: CommandRuleDecl[];
  timeoutMs?: number;
  expectedDurationMs?: number;
  longRunning?: boolean;
  cacheable?: boolean;
  hidden?: boolean;
  /**
   * RFC-1463: declared deterministic prerequisites — the executor runs each
   * target inside pre-flight before the first check. Structurally mirrors
   * KernelCommandMetadata; targets must be read-only or rerun-safe.
   */
  ensure?: Array<{ command: string; when?: string }>;
  /**
   * RFC-1463: named resolvers for ensure[].when — structurally mirrors
   * KernelCommandMetadata. An unresolvable when is a declaration failure.
   */
  ensureConditions?: Record<string, (input: ForgeCommandInput) => boolean>;
  /**
   * RFC-1463: marks the command as a composite gate — it must emit the
   * complete violation set in one invocation (GATE-CMP-01 lints the
   * wiring). Structurally mirrors KernelCommandMetadata.
   */
  compositeGate?: boolean;
  /**
   * RFC-0518: declarative gate metadata. Optional. Structurally compatible
   * with GateMetadata from @warpgogol/site-kernel. Does NOT affect execution.
   */
  gate?: GateMetadata;
  /**
   * RFC-1243: coverage declaration for commands with no mechanical invocation
   * record. Structurally mirrors KernelCommandMetadata.
   */
  coverage?: "operator" | "ci" | "delegated";
  coverageNote?: string;
}

// ---------------------------------------------------------------------------
// RFC-0518: declarative gate metadata (structurally compatible with @warpgogol/site-kernel)
// ---------------------------------------------------------------------------

export type GateSeverity = "error" | "warning" | "mixed";
export type GatePhase = "author" | "postbuild" | "workspace" | "mission" | "release";

/** RFC-1461: declared severity for a rule id — structural mirror of the kernel type (FORGE-AUTONOMY-01). */
export type CommandRuleSeverity = "error" | "warning";

/** RFC-1461: `rules[]` entry — rule id plus its declared emission severity. */
export interface CommandRuleDecl {
  id: string;
  severity: CommandRuleSeverity;
}

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
  rules?: CommandRuleDecl[];
  blocks?: string[];
}

export interface ForgeRegisteredCommandInfo extends ForgeCommandMetadata {
  name: string;
  provider: "workspace";
  module?: string;
  flags?: Record<string, ForgeFlagSpec>;
  reads?: string[];
  writes?: string[];
  /** RFC-0960 generated-artifact declarations (on-demand generators). */
  generates?: GeneratedArtifactSpec[];
  hidden?: boolean;
}

export interface ForgeCommandDefinition<TData = unknown> extends ForgeCommandMetadata {
  name: string;
  flags?: Record<string, ForgeFlagSpec>;
  reads?: string[];
  writes?: string[];
  /** RFC-0960 generated-artifact declarations (on-demand generators). */
  generates?: GeneratedArtifactSpec[];
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
  /**
   * RFC-1152: optional WorkspaceIO port — populated when a kernel invokes the
   * command (writes flow through the recording adapter); absent under the
   * standalone `forge` CLI, where helpers fall back to the ambient adapter.
   */
  io?: WorkspaceIO;
  /**
   * RFC-1306: optional sibling-command invocation port — populated when the
   * command runs under a kernel host (the executor delegates by name through
   * its own entry point, so the child resolves its own flags and io adapter).
   * Absent under the standalone `forge` CLI — handlers that need it must
   * fail closed with a diagnostic, never crash on the absent port.
   */
  invoke?: ForgeInvokeCommand;
}

/**
 * RFC-1306: minimal report shape returned through `ForgeRuntimeContext.invoke`
 * — a structural subset of the kernel's execution report so a kernel-populated
 * port is assignable without any @warpgogol/* import (FORGE-AUTONOMY-01).
 */
export interface ForgeInvokeResult {
  exitCode: number;
  ok: boolean;
  data?: unknown;
  summary?: string;
  /** Workspace-relative paths the child wrote (RFC-0326 report field). */
  filesModified?: string[];
}

/** RFC-1306: signature of the kernel-populated `ForgeRuntimeContext.invoke` port. */
export type ForgeInvokeCommand = (
  commandName: string,
  flags?: Record<string, ForgeFlagValue>,
) => Promise<ForgeInvokeResult>;
