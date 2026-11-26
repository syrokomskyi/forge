/*
<MODULE_CONTRACT>
<purpose>
Plugin SDK types (Werkstatt RFC-1648) — the platform boundary for in-process
executable plugins: manifest contract, command module contract, and the typed
PluginContext ports through which ALL platform interaction flows. Plugins never
touch raw node capabilities.
</purpose>
<non-goals><item>No loader or enforcement logic — contracts only.</item></non-goals>
<CHANGE_SUMMARY><item>RFC-1648 (WP-5): initial SDK contracts.</item></CHANGE_SUMMARY>
*/

export interface PluginManifest {
  schema: "forge:plugin-manifest/v1";
  /** e.g. "forge-typescript" — npm name minus scope. */
  id: string;
  version: string;
  /** Required semver range — violation refuses load, fail-closed. */
  forgeRange: string;
  capabilities: {
    filesystem?: "none" | "read" | "readwrite";
    network?: boolean;
    /* Binary allowlist form is the hardened grant: spawning a side-effecting binary
       is equivalent to trusting the plugin with those effects — the manifest surface
       stays honest about WHICH binaries. boolean true = unrestricted (fully-trusted,
       legacy form); false/absent = no spawn. */
    processSpawn?: boolean | string[];
    gitMutation?: boolean;
    envKeys?: string[];
    /* forge's own state space (.git/forge/) lives outside the workspace sandbox in
       worktrees — access is a distinct grant, never a widening of filesystem. */
    forgeState?: "none" | "read";
    /* The primary checkout's state lives outside the workspace sandbox in
       worktrees — releases/, .werkstatt/, missions/archive are shared across
       worktrees by design (resolveWorkshopPaths primaryRoot parity). One coarse
       space mirroring the filesystem grant's whole-root granularity: measured
       extraction evidence showed every primary-state command spanning 2-3
       narrow domains, so per-domain spaces multiply grants without improving
       honesty (plugins run in-process — capabilities are audit boundaries). */
    primaryState?: "none" | "read" | "readwrite";
  };
  registers: {
    commands?: string[];
    skills?: string;
    contractNodes?: string[];
    hooks?: string[];
  };
  pluginDependencies?: Record<string, string>;
}

export interface CommandResult {
  status: "pass" | "fail" | "error";
  violations?: Array<{ ruleId: string; message: string; severity: string; file?: string }>;
  message?: string;
  data?: Record<string, unknown>;
}

export interface CommandModule {
  /** Namespaced, e.g. "typescript.validate". */
  id: string;
  scope: "repo" | "workspace" | "system";
  description: string;
  /** zod schema — closed flag vocabulary. */
  flagsSchema?: unknown;
  run(ctx: PluginContext, args: Record<string, unknown>): Promise<CommandResult>;
}

/** Lifecycle hooks — closed list in v1; new hook points require core minor versions. */
export type LifecycleHook = "onActivate" | "onDeactivate" | "beforeIntegrate" | "afterIntegrate";
export const LIFECYCLE_HOOKS: readonly LifecycleHook[] = ["onActivate", "onDeactivate", "beforeIntegrate", "afterIntegrate"];

/**
 * Hook module — self-describing like CommandModule: the default export names
 * the hook it implements and carries the handler. `registers.hooks` entries are
 * module paths relative to the plugin dir; fail-closed: the module's declared
 * hook must be in the closed vocabulary, and duplicate hook implementations
 * within one plugin refuse registration.
 */
export interface HookModule {
  hook: LifecycleHook;
  run(ctx: PluginContext, payload: HookPayload): Promise<void>;
}

/** Payload passed to lifecycle hooks — the integration payload carries the unit id and outcome. */
export interface HookPayload {
  unitId?: string;
  outcome?: string;
  data?: Record<string, unknown>;
}

// ---- SDK ports — the ONLY platform access surface for plugin code. ----

export interface WorkspaceIOPort {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /* Binary write — artifact archives and release copies are gzip bytes; routing
     them through the string writeFile would corrupt them through utf8 encoding. */
  writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string, pattern?: string): Promise<string[]>;
  /* Symlink primitives — atomic deploy swaps and artifact layouts are link-based;
     readFile follows links and can never observe the link itself. */
  readlink(path: string): Promise<string>;
  symlink(target: string, linkPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFileBytes(path: string): Promise<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<{ size: number; mtimeMs: number; isDirectory: boolean }>;
  /* Engine-parity directory read (10.6.0) — mechanical-port extractions consume
     typed entries, unlike list's bare names. Shape matches the engine's
     workspace-io DirEntry exactly so copied helpers need zero edits. */
  readdir(path: string): Promise<{ name: string; isFile: boolean; isDirectory: boolean }[]>;
  /* Recursive — writeFile already creates parents; this verb exists for empty
     directories the engine materializes explicitly. */
  mkdir(path: string): Promise<void>;
}

export interface EvidenceAccessPort {
  consult(nodeId: string, inputDigest: string): Promise<{ hit: boolean; verdict?: unknown }>;
}

export interface ContractRegistryPort {
  registerNode(node: unknown): { ok: true } | { ok: false; errors: string[] };
}

export interface BindingsResolverPort {
  get<T = unknown>(key: string): T | undefined;
  require<T = unknown>(key: string): T;
}

export interface GitPort {
  exec(args: string[]): Promise<string>;
}

export interface ProcessPort {
  spawn(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface NetworkPort {
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }>;
}

export interface LoggerPort {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface PathResolverPort {
  resolve(...parts: string[]): string;
  root(): string;
}

export interface PluginContext {
  workspace: WorkspaceIOPort;
  evidence: EvidenceAccessPort;
  contracts: ContractRegistryPort;
  bindings: BindingsResolverPort;
  git: GitPort;
  process: ProcessPort;
  network: NetworkPort;
  log: LoggerPort;
  paths: PathResolverPort;
  env: EnvPort;
  forgeState: ForgeStatePort;
  /* WorkspaceIO-shaped port rooted at the primary checkout root.
     Shares the workspace port's method surface exactly; the root difference is
     the whole point — methods deny with CapabilityViolation when the grant is
     insufficient, read methods degrade to absent-shape when no git state exists. */
  primaryState: WorkspaceIOPort;
}

/* The journal record shape is open-ended by design — the flow machinery evolves
   the schema; the measured discriminator is `event` (never `kind`). */
export interface JournalRecord {
  at?: string;
  event?: string;
  branch?: string;
  sha?: string;
  detail?: string;
  [key: string]: unknown;
}

/* Host-implemented reads of forge's own state space — plugins never observe
   gitdir layout, matching the evidence.consult pattern. */
export interface ForgeStatePort {
  journal: {
    /* Last count records, oldest-first; empty when no journal exists. */
    tail(count: number): Promise<JournalRecord[]>;
    /* Total line count — cheaper than reading when only existence matters. */
    size(): Promise<number>;
  };
}

/* Env access is allowlist-enforced: the manifest's envKeys declares exactly which
   variables the plugin may read — secrets-adjacent access stays transparent and
   auditable at the manifest surface, never a blanket process.env passthrough. */
export interface EnvPort {
  /** Declared key → value or undefined; undeclared key → CapabilityViolation. */
  get(key: string): string | undefined;
  /** Whether the key is declared in the manifest — no leakage of presence vs value. */
  declared(key: string): boolean;
}

/** Typed incompatibility error — fail-closed, no degraded modes. */
export class PluginLoadError extends Error {
  readonly kind: "forgerange-violation" | "manifest-invalid" | "capability-unknown" | "dependency-conflict" | "registration-refused";
  readonly pluginId?: string;
  constructor(
    kind: "forgerange-violation" | "manifest-invalid" | "capability-unknown" | "dependency-conflict" | "registration-refused",
    message: string,
    pluginId?: string,
  ) {
    super(message);
    this.name = "PluginLoadError";
    this.kind = kind;
    this.pluginId = pluginId;
  }
}

export class CapabilityViolation extends Error {
  readonly capability: string;
  readonly pluginId: string;
  constructor(capability: string, pluginId: string, detail: string) {
    super(`capability violation: plugin "${pluginId}" has no ${capability} grant — ${detail}`);
    this.name = "CapabilityViolation";
    this.capability = capability;
    this.pluginId = pluginId;
  }
}
