/*
<MODULE_CONTRACT>
<purpose>
  RFC-1591 — the tool-server core behind `forge agent-tools serve`. Three
  meta tools (command_search / command_describe / command_run) plus one tool
  per agentTools.front entry; command_run validates args against the
  generated schema (AGENT-TOOL-01 unknown argument, with the RFC-1514
  nearest-flag suggestion; AGENT-TOOL-02 denied command) and only then spawns
  the workshop host — `pnpm exec werkstatt run` where the bin resolves,
  `pnpm exec forge` otherwise — so every existing guard and hook applies.
  Detachable commands run with --detach and return the gate-run id.
</purpose>
<non-goals>
  <item>No privilege — the server refuses before spawning, never around the guards.</item>
  <item>No raw-argv passthrough — args is a flag-keyed object only (RFC implementation note).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
</CHANGE_SUMMARY>
*/

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AgentToolInputSchema, AgentToolDefinition, AgentToolsFile } from "./types.ts";
import { toolNameFor } from "./types.ts";

export interface AgentToolError {
  ruleId: "AGENT-TOOL-01" | "AGENT-TOOL-02" | "AGENT-TOOL-05";
  message: string;
  /** Valid property names for AGENT-TOOL-01. */
  properties?: string[];
  /** RFC-1514 nearest-flag suggestion, when within edit distance 2. */
  suggestion?: string;
}

export interface CommandRunOutcome {
  command: string;
  exitCode: number;
  /** Parsed --json envelope payload when stdout carried one. */
  output?: unknown;
  stdout: string;
  stderr: string;
  detached?: boolean;
  runId?: string;
  pid?: number;
}

export type AgentToolCallResult =
  { ok: true; result: unknown } | { ok: false; error: AgentToolError; result?: unknown };

/** Injectable spawn seam — tests assert the argv instead of running commands. */
export type CommandRunner = (argv: string[], cwd: string) => Promise<CommandRunOutcome>;

export interface AgentToolsRuntime {
  workspaceRoot: string;
  tools: AgentToolsFile;
  runner: CommandRunner;
}

// ---------------------------------------------------------------------------
// Meta tools
// ---------------------------------------------------------------------------

const SEARCH_LIMIT_DEFAULT = 20;

export const META_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: "command_search",
    command: "<meta>",
    description:
      "Search kernel commands by name and description. Returns up to `limit` " +
      "{ name, description, mutatesState } matches (default 20).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match against name and description." },
        limit: { type: "number", description: "Maximum matches (default 20)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "command_describe",
    command: "<meta>",
    description:
      "Return the JSON Schema and manifest metadata of one kernel command — " +
      "the authoritative flag surface for command_run or a shell invocation.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Kernel command name, e.g. ecosystem.commit." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "command_run",
    command: "<meta>",
    description:
      "Validate `args` against the named command's manifest schema, then run " +
      "it through the workshop host and return the --json envelope. Detachable " +
      "commands start with --detach and return the gate-run id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Kernel command name." },
        args: {
          type: "object",
          description: "Flag-keyed arguments — declared flag names only, no raw argv.",
          additionalProperties: true,
        },
      },
      required: ["name", "args"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

// ---------------------------------------------------------------------------
// RFC-1514 suggestion code (inlined — FORGE-AUTONOMY-01 forbids the engine
// import; same edit-distance-2, tie-by-lexicographic contract).
// ---------------------------------------------------------------------------

function editDistance(a: string, b: string): number {
  const n = b.length;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n]!;
}

/** Nearest declared flag within the distance threshold; ties resolve lexicographically. */
export function nearestFlagName(
  name: string,
  candidates: readonly string[],
  maxDistance = 2,
): string | undefined {
  let best: string | undefined;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    if (distance > maxDistance || distance > bestDistance) continue;
    if (distance === bestDistance && best !== undefined && candidate >= best) continue;
    bestDistance = distance;
    best = candidate;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Arg validation + argv serialization
// ---------------------------------------------------------------------------

/** Kernel argv token form (kernelArgvFromFlags contract): true → bare --name,
 *  arrays → one --name=value per element, else --name=value. */
function argvFromArgs(args: Record<string, unknown>): string[] {
  const argv: string[] = [];
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (value === true) {
      argv.push(`--${name}`);
    } else if (Array.isArray(value)) {
      for (const item of value) argv.push(`--${name}=${String(item)}`);
    } else {
      argv.push(`--${name}=${String(value)}`);
    }
  }
  return argv;
}

/** AGENT-TOOL-01 when an arg name is not a declared flag (flagsOpen schemas
 *  accept anything); returns the valid property list plus the nearest name. */
function validateArgs(
  schema: AgentToolInputSchema,
  args: Record<string, unknown>,
): AgentToolError | undefined {
  if (schema.additionalProperties === true) return undefined;
  const declared = Object.keys(schema.properties);
  for (const key of Object.keys(args)) {
    if (schema.properties[key] !== undefined) continue;
    const suggestion = nearestFlagName(key, declared);
    return {
      ruleId: "AGENT-TOOL-01",
      message: `"${key}" is not a declared flag — valid: ${declared.join(", ") || "(none)"}`,
      properties: declared,
      ...(suggestion !== undefined ? { suggestion } : {}),
    };
  }
  const missing = schema.required.filter((r) => args[r] === undefined);
  if (missing.length > 0) {
    return {
      ruleId: "AGENT-TOOL-01",
      message: `missing required flag(s): ${missing.join(", ")}`,
      properties: declared,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Runner — spawn the workshop host in the caller's working directory so every
// existing hook and guard applies.
// ---------------------------------------------------------------------------

function resolveRunnerPrefix(workspaceRoot: string): string[] {
  return existsSync(join(workspaceRoot, "node_modules", ".bin", "werkstatt"))
    ? ["pnpm", "exec", "werkstatt", "run"]
    : ["pnpm", "exec", "forge"];
}

/** Real runner: spawn the runner prefix, capture streams, parse the --json envelope. */
export function createDefaultRunner(prefix?: string[]): CommandRunner {
  return (argv, cwd) =>
    new Promise<CommandRunOutcome>((resolveRun) => {
      const [cmd, ...rest] = prefix ?? resolveRunnerPrefix(cwd);
      const child = spawn(cmd ?? "pnpm", [...rest, ...argv], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        resolveRun({
          command: argv[0] ?? "",
          exitCode: 1,
          stdout,
          stderr: `${stderr}${String(err)}`,
        });
      });
      child.on("close", (code) => {
        const output = parseJsonEnvelope(stdout);
        resolveRun({
          command: argv[0] ?? "",
          exitCode: code ?? 1,
          ...(output !== undefined ? { output } : {}),
          stdout,
          stderr,
          ...(extractRunId(output) !== undefined ? { runId: extractRunId(output) } : {}),
        });
      });
    });
}

/** First JSON object in stdout — the command's --json envelope. */
function parseJsonEnvelope(stdout: string): unknown {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Detach pointer envelope: { data: { status: "running", runId, pid, logPath } }. */
function extractRunId(output: unknown): string | undefined {
  if (output === null || typeof output !== "object") return undefined;
  const data = (output as { data?: { runId?: unknown } }).data;
  return typeof data?.runId === "string" ? data.runId : undefined;
}

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

/** Tools a client sees: the three meta tools plus one per front entry. */
export function listTools(runtime: Pick<AgentToolsRuntime, "tools">): AgentToolDefinition[] {
  return [...META_TOOL_DEFINITIONS, ...runtime.tools.front];
}

export interface SearchHit {
  name: string;
  description: string;
  mutatesState: boolean;
}

function searchCommands(
  runtime: Pick<AgentToolsRuntime, "tools">,
  query: string,
  limit: number,
): SearchHit[] {
  const q = query.toLowerCase();
  const hits: Array<{ hit: SearchHit; score: number }> = [];
  for (const [name, spec] of Object.entries(runtime.tools.commands)) {
    const nameHit = name.toLowerCase().includes(q);
    const descHit = spec.description.toLowerCase().includes(q);
    if (!nameHit && !descHit) continue;
    hits.push({
      hit: {
        name,
        description: spec.description,
        mutatesState: spec.annotations.destructiveHint,
      },
      score: nameHit ? 0 : 1,
    });
  }
  hits.sort((a, b) => a.score - b.score || a.hit.name.localeCompare(b.hit.name));
  return hits.slice(0, Math.max(0, limit)).map((h) => h.hit);
}

function describeCommand(
  runtime: Pick<AgentToolsRuntime, "tools">,
  name: string,
): AgentToolCallResult {
  const spec = runtime.tools.commands[name];
  if (spec === undefined) {
    if (runtime.tools.deny.includes(name)) {
      return {
        ok: false,
        error: {
          ruleId: "AGENT-TOOL-02",
          message: `"${name}" is on the agentTools.deny list — it is never exposed through this server`,
        },
      };
    }
    return {
      ok: false,
      error: {
        ruleId: "AGENT-TOOL-05",
        message: `unknown command "${name}" — run command_search first`,
      },
    };
  }
  return {
    ok: true,
    result: { name: toolNameFor(name), ...spec },
  };
}

async function runCommand(
  runtime: AgentToolsRuntime,
  name: string,
  args: Record<string, unknown>,
): Promise<AgentToolCallResult> {
  const spec = runtime.tools.commands[name];
  if (spec === undefined) {
    if (runtime.tools.deny.includes(name)) {
      return {
        ok: false,
        error: {
          ruleId: "AGENT-TOOL-02",
          message: `"${name}" is on the agentTools.deny list — it is never runnable through this server`,
        },
      };
    }
    return {
      ok: false,
      error: {
        ruleId: "AGENT-TOOL-05",
        message: `unknown command "${name}" — run command_search first`,
      },
    };
  }
  const argError = validateArgs(spec.inputSchema, args);
  if (argError !== undefined) {
    return { ok: false, error: argError };
  }
  const argv = [name, "--json", ...argvFromArgs(args)];
  if (spec.detachable === true) argv.push("--detach");
  const outcome = await runtime.runner(argv, runtime.workspaceRoot);
  if (spec.detachable === true) {
    return {
      ok: true,
      result: {
        detached: true,
        command: name,
        runId: outcome.runId ?? extractRunId(outcome.output),
        exitCode: outcome.exitCode,
        stdout: outcome.stdout.trim(),
        stderr: outcome.stderr.trim(),
      },
    };
  }
  const result = {
    command: name,
    exitCode: outcome.exitCode,
    output: outcome.output ?? outcome.stdout.trim(),
    stderr: outcome.stderr.trim(),
  };
  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      result,
      error: {
        ruleId: "AGENT-TOOL-05",
        message: `"${name}" exited ${outcome.exitCode}`,
      },
    };
  }
  return { ok: true, result };
}

/**
 * Dispatch one tool call. Front tools are aliases for command_run on their
 * command — an underscored front name resolves back to the command.
 */
export async function callTool(
  runtime: AgentToolsRuntime,
  toolName: string,
  args: Record<string, unknown>,
): Promise<AgentToolCallResult> {
  if (toolName === "command_search") {
    const query = typeof args["query"] === "string" ? args["query"] : "";
    const limit = typeof args["limit"] === "number" ? args["limit"] : SEARCH_LIMIT_DEFAULT;
    return { ok: true, result: { matches: searchCommands(runtime, query, limit) } };
  }
  if (toolName === "command_describe") {
    const name = typeof args["name"] === "string" ? args["name"] : "";
    return describeCommand(runtime, name);
  }
  const front = runtime.tools.front.find((t) => t.name === toolName);
  const commandName =
    toolName === "command_run"
      ? typeof args["name"] === "string"
        ? args["name"]
        : ""
      : front?.command;
  if (commandName === undefined || commandName === "") {
    return {
      ok: false,
      error: {
        ruleId: "AGENT-TOOL-05",
        message: `unknown tool "${toolName}"`,
      },
    };
  }
  const runArgs =
    toolName === "command_run"
      ? ((args["args"] as Record<string, unknown> | undefined) ?? {})
      : args;
  return runCommand(runtime, commandName, runArgs);
}
