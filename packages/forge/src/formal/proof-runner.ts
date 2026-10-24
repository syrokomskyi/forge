/*
<MODULE_CONTRACT>
<purpose>
RFC-1391: the shared proof-check execution path — loads a forge/proof-spec@1
file, resolves the declared tool (built-in `exhaustive` or a forge.yaml
`formal.tools` entry), pins the tool version, runs the proof, and returns a
ProofCheckResult verdict (proved/refuted/unavailable/error). Consumed by the
`proof.check` command and by `probe: proof` acceptance-probe execution so both
surfaces share one verdict path.
</purpose>
<non-goals>
  <item>Do not decide stamp outcomes — implement-stamp's RFC-IMP-13 consumes these verdicts.</item>
  <item>Do not install or vendor checkers — external tools stay operator-provided via forge.yaml.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>specSha256/entrySha256 are computed whenever the files are readable — evidence binds to bytes for every verdict, including error/unavailable.</item>
  <item>`exhaustive` runs the entry through vitest with FORGE_PROOF_REPORT — the report file, not the exit code, carries the verdict so an incidental co-located test failure cannot masquerade as a refutation.</item>
  <item>External tools map exit 0 → proved, non-zero → refuted (captured output persisted), ENOENT → unavailable, version-regex miss/mismatch → error.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1391: shared runProofCheck execution path (tool resolution, version pin, report parsing, log persistence).</item>
  <item>RFC-1391: make the formal verification tier checker-bound (RFC-1391)</item>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { parse as yamlParse } from "yaml";
import type { FormalToolEntry } from "../config/forge-config.ts";
import { existsSync, mkdirSync, readFileSync, spawn, writeFileSync } from "../utils/sync-fs.ts";
import {
  EXHAUSTIVE_TOOL_VERSION,
  exhaustiveVerdict,
  FORGE_PROOF_REPORT_ENV,
  type ExhaustiveResult,
} from "./exhaustive.ts";
import { proofSpecSchema, type ProofCheckResult, type ProofSpec } from "./proof-spec.ts";

/** Default per-run bound when the caller passes no timeoutMs (RFC-1391: 30 min). */
export const PROOF_CHECK_DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** Captured checker output is tail-truncated to this many bytes in persisted logs. */
const OUTPUT_TAIL_BYTES = 64 * 1024;

export interface RunProofCheckOptions {
  workspaceRoot: string;
  /** Workspace-relative path to the forge/proof-spec@1 YAML file. */
  specRelPath: string;
  /** `formal.tools` map from forge.yaml — absent means only `exhaustive` resolves. */
  tools?: Record<string, FormalToolEntry>;
  /**
   * Per-run timeout bound (ms) — the `proof.check --timeout-ms` flag value.
   * Defaults to PROOF_CHECK_DEFAULT_TIMEOUT_MS.
   */
  timeoutMs?: number;
  /**
   * Process-spawn port — defaults to a real `spawn`. Injected by tests (the
   * exhaustive path spawns vitest, which is unresolvable from a tmp fixture
   * workspace) and by callers that virtualize execution.
   */
  spawnFn?: SpawnFn;
}

export interface SpawnOutcome {
  exitCode: number | null;
  timedOut: boolean;
  /** Set when the executable could not be spawned (ENOENT etc.). */
  spawnError: string | null;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (
  argv: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<SpawnOutcome>;

function spawnArgv(
  argv: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<SpawnOutcome> {
  return new Promise((res) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.stderr?.on("data", (d) => {
      err += String(d);
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      res({ exitCode: null, timedOut: true, spawnError: null, stdout: out, stderr: err });
    }, opts.timeoutMs);
    timer.unref?.();
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ exitCode: code, timedOut: false, spawnError: null, stdout: out, stderr: err });
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({
        exitCode: null,
        timedOut: false,
        spawnError: (e as Error).message,
        stdout: out,
        stderr: err,
      });
    });
  });
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function proofsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".cache", "proofs");
}

function tail(content: string): string {
  return content.length > OUTPUT_TAIL_BYTES ? content.slice(-OUTPUT_TAIL_BYTES) : content;
}

/** Persist captured checker output; returns the workspace-relative path or undefined. */
function persistLog(
  workspaceRoot: string,
  specId: string,
  name: string,
  content: string,
): string | undefined {
  if (!content.trim()) return undefined;
  const dir = proofsDir(workspaceRoot);
  mkdirSync(dir, { recursive: true });
  const rel = join(".cache", "proofs", `${specId}.${name}`);
  writeFileSync(join(dir, `${specId}.${name}`), tail(content));
  return rel;
}

function result(
  spec: Partial<ProofSpec>,
  fields: Pick<ProofCheckResult, "verdict" | "message"> & Partial<ProofCheckResult>,
): ProofCheckResult {
  const { specSha256 = "", entrySha256 = "", toolVersion = null, durationMs = 0, ...rest } = fields;
  return {
    specId: spec.id ?? "(invalid-spec)",
    tool: spec.tool ?? "(unknown)",
    toolVersion,
    specSha256,
    entrySha256,
    durationMs,
    ...rest,
  };
}

/**
 * Run one proof spec end-to-end. Never throws — every failure mode maps onto
 * a verdict (`error` for spec/infra failures, `unavailable` for a missing
 * checker) so callers can record evidence uniformly.
 */
export async function runProofCheck(opts: RunProofCheckOptions): Promise<ProofCheckResult> {
  const { workspaceRoot, specRelPath } = opts;
  const tools = opts.tools ?? {};
  const spawnFn = opts.spawnFn ?? spawnArgv;
  const startedAt = Date.now();
  const done = (
    spec: Partial<ProofSpec>,
    fields: Pick<ProofCheckResult, "verdict" | "message"> & Partial<ProofCheckResult>,
  ): ProofCheckResult => result(spec, { durationMs: Date.now() - startedAt, ...fields });

  const specAbsPath = resolve(workspaceRoot, specRelPath);
  let specRaw: string;
  try {
    specRaw = readFileSync(specAbsPath, "utf8");
  } catch {
    return done({}, { verdict: "error", message: `spec file not readable: ${specRelPath}` });
  }
  const specSha256 = sha256Hex(specRaw);

  let spec: ProofSpec;
  try {
    const parsed = proofSpecSchema.safeParse(yamlParse(specRaw));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return done(
        {},
        {
          verdict: "error",
          message: `spec fails forge/proof-spec@1: ${issue ? `${issue.path.join(".") || "(root)"} — ${issue.message}` : "unknown"}`,
          specSha256,
        },
      );
    }
    spec = parsed.data;
  } catch (e) {
    return done(
      {},
      {
        verdict: "error",
        message: `spec file is not valid YAML: ${(e as Error).message}`,
        specSha256,
      },
    );
  }

  const entryAbsPath = resolve(workspaceRoot, spec.entry);
  let entrySha256 = "";
  if (existsSync(entryAbsPath)) {
    entrySha256 = sha256Hex(readFileSync(entryAbsPath, "utf8"));
  } else {
    return done(spec, {
      verdict: "error",
      message: `entry file not found: ${spec.entry}`,
      specSha256,
    });
  }

  const timeoutMs = opts.timeoutMs ?? PROOF_CHECK_DEFAULT_TIMEOUT_MS;

  if (spec.tool === "exhaustive") {
    if (spec.toolVersion !== EXHAUSTIVE_TOOL_VERSION) {
      return done(spec, {
        verdict: "error",
        message: `exhaustive runner reports version ${EXHAUSTIVE_TOOL_VERSION}, spec pins ${spec.toolVersion}`,
        specSha256,
        entrySha256,
        toolVersion: EXHAUSTIVE_TOOL_VERSION,
      });
    }
    const cardinality = spec.domain?.cardinality;
    if (cardinality === undefined) {
      return done(spec, {
        verdict: "error",
        message: "tool exhaustive requires domain.cardinality in the spec",
        specSha256,
        entrySha256,
        toolVersion: EXHAUSTIVE_TOOL_VERSION,
      });
    }
    const reportRel = join(".cache", "proofs", `${spec.id}.report.json`);
    const reportAbs = join(workspaceRoot, reportRel);
    const outcome = await spawnFn(["pnpm", "exec", "vitest", "run", entryAbsPath], {
      cwd: workspaceRoot,
      timeoutMs,
      env: { ...process.env, [FORGE_PROOF_REPORT_ENV]: reportAbs },
    });
    if (outcome.timedOut) {
      return done(spec, {
        verdict: "error",
        message: `exhaustive entry timed out after ${timeoutMs}ms`,
        specSha256,
        entrySha256,
        toolVersion: EXHAUSTIVE_TOOL_VERSION,
      });
    }
    let report: ExhaustiveResult | null = null;
    try {
      report = JSON.parse(readFileSync(reportAbs, "utf8")) as ExhaustiveResult;
    } catch {
      report = null;
    }
    if (report === null || typeof report.enumerated !== "number") {
      const log = persistLog(
        workspaceRoot,
        spec.id,
        "log",
        `${outcome.stdout}\n${outcome.stderr}\nexitCode=${String(outcome.exitCode)}`,
      );
      return done(spec, {
        verdict: "error",
        message: `entry produced no readable report (exit ${String(outcome.exitCode ?? "spawn-error")}) — the exhaustive() call may have thrown`,
        specSha256,
        entrySha256,
        toolVersion: EXHAUSTIVE_TOOL_VERSION,
        ...(log ? { counterexample: log } : {}),
      });
    }
    const v = exhaustiveVerdict(report, cardinality);
    const counterexample =
      v.verdict === "refuted"
        ? persistLog(
            workspaceRoot,
            spec.id,
            "counterexample.json",
            JSON.stringify(report.failures, null, 2),
          )
        : undefined;
    return done(spec, {
      verdict: v.verdict,
      message: v.message,
      specSha256,
      entrySha256,
      toolVersion: EXHAUSTIVE_TOOL_VERSION,
      enumerated: report.enumerated,
      ...(counterexample ? { counterexample } : {}),
    });
  }

  // External tool — must be declared in forge.yaml formal.tools.
  const tool = tools[spec.tool];
  if (!tool) {
    return done(spec, {
      verdict: "unavailable",
      message: `tool "${spec.tool}" is not declared in forge.yaml formal.tools — configure it or use the built-in "exhaustive"`,
      specSha256,
      entrySha256,
    });
  }
  const versionRun = await spawnFn(tool.versionCommand, {
    cwd: workspaceRoot,
    timeoutMs,
  });
  if (versionRun.spawnError !== null || versionRun.timedOut) {
    return done(spec, {
      verdict: "unavailable",
      message:
        `cannot run versionCommand for "${spec.tool}": ${versionRun.spawnError ?? "timed out"}` +
        (tool.installHint ? ` — ${tool.installHint}` : ""),
      specSha256,
      entrySha256,
    });
  }
  const versionMatch = new RegExp(tool.versionPattern).exec(
    versionRun.stdout + "\n" + versionRun.stderr,
  );
  if (!versionMatch) {
    return done(spec, {
      verdict: "error",
      message: `versionPattern ${tool.versionPattern} matched nothing in versionCommand output`,
      specSha256,
      entrySha256,
    });
  }
  const observedVersion = (versionMatch[1] ?? versionMatch[0]).trim();
  if (observedVersion !== spec.toolVersion) {
    return done(spec, {
      verdict: "error",
      message: `installed "${spec.tool}" reports version "${observedVersion}", spec pins "${spec.toolVersion}"`,
      specSha256,
      entrySha256,
      toolVersion: observedVersion,
    });
  }

  const argv = tool.command.map((a) => (a === "{entry}" ? entryAbsPath : a));
  const run = await spawnFn(argv, { cwd: workspaceRoot, timeoutMs });
  if (run.spawnError !== null) {
    return done(spec, {
      verdict: "unavailable",
      message:
        `cannot run command for "${spec.tool}": ${run.spawnError}` +
        (tool.installHint ? ` — ${tool.installHint}` : ""),
      specSha256,
      entrySha256,
      toolVersion: observedVersion,
    });
  }
  if (run.timedOut) {
    return done(spec, {
      verdict: "error",
      message: `"${spec.tool}" timed out after ${timeoutMs}ms`,
      specSha256,
      entrySha256,
      toolVersion: observedVersion,
    });
  }
  const log = persistLog(
    workspaceRoot,
    spec.id,
    "log",
    `${run.stdout}\n${run.stderr}\nexitCode=${String(run.exitCode)}`,
  );
  if (run.exitCode === 0) {
    return done(spec, {
      verdict: "proved",
      message: `"${spec.tool}" accepted the proof (exit 0)`,
      specSha256,
      entrySha256,
      toolVersion: observedVersion,
      ...(log ? { counterexample: log } : {}),
    });
  }
  return done(spec, {
    verdict: "refuted",
    message: `"${spec.tool}" rejected the proof (exit ${String(run.exitCode)})`,
    specSha256,
    entrySha256,
    toolVersion: observedVersion,
    ...(log ? { counterexample: log } : {}),
  });
}
