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
    processSpawn?: boolean;
    gitMutation?: boolean;
    envKeys?: string[];
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

// ---- SDK ports — the ONLY platform access surface for plugin code. ----

export interface WorkspaceIOPort {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string, pattern?: string): Promise<string[]>;
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
}

/** Typed incompatibility error — fail-closed, no degraded modes. */
export class PluginLoadError extends Error {
  constructor(
    public readonly kind: "forgerange-violation" | "manifest-invalid" | "capability-unknown" | "dependency-conflict" | "registration-refused",
    message: string,
    public readonly pluginId?: string,
  ) {
    super(message);
    this.name = "PluginLoadError";
  }
}

export class CapabilityViolation extends Error {
  constructor(
    public readonly capability: string,
    public readonly pluginId: string,
    detail: string,
  ) {
    super(`capability violation: plugin "${pluginId}" has no ${capability} grant — ${detail}`);
    this.name = "CapabilityViolation";
  }
}
