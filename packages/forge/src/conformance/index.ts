/*
<MODULE_CONTRACT>
<purpose>Shared golden-conformance execution path for declared contract producers (RFC-1365): runProducerConformance executes the emit → mirror → consumer legs against an mkdtemp bundle dir with per-leg failure attribution, and consumerAvailable backs the test-side describe.skipIf guard for an absent consumer checkout.</purpose>
<non-goals>
  <item>Do not import @warpgogol/* packages — this module is autonomous (FORGE-AUTONOMY-01).</item>
  <item>Do not vendor or re-implement consumer validation rules — the consumer argv is the authority.</item>
  <item>Do not author producer fixtures — emit argv is producer-owned domain data.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1365: step 1 — contractProducers schema + conformance execution path</item>
  <item>RFC-1365: step 2 — forge.conformance.run/validate commands + dual-surface registration</item>
  <item>RFC-1365: compass header fix — drop forbidden keywords/responsibilities tags, expand purpose</item>
  <item>RFC-1365: review round 1 — CONF-03 rescoped producer-side (Q-9), producers[] json shape, crash guard + leg output, transport attribution, env semantics, writes declared, regen sweep</item>
  <item>RFC-1539: package-sourced specs and published consumer validators in Forge</item>
  <history>RFC-1365</history>
</CHANGE_SUMMARY>
*/

import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { existsSync, mkdtempSync, readdirSync, rmSync, spawn } from "../utils/sync-fs.ts";
import type { ContractProducerEntry } from "../config/forge-config.ts";

/** Captured leg output is tail-truncated to this many bytes (RFC-1365). */
export const CONFORMANCE_OUTPUT_TAIL_BYTES = 64 * 1024;
/** Default per-leg timeout matching the pipelines conformance precedent. */
export const CONFORMANCE_DEFAULT_TIMEOUT_MS = 240_000;
/** Env var exported to leg subprocesses so argv can locate the bundle dir. */
export const CONFORMANCE_BUNDLE_DIR_ENV = "FORGE_CONFORMANCE_BUNDLE_DIR";

const BUNDLE_PLACEHOLDER = "{bundle}";

/** Alias of the schema type — single declaration lives in forge-config.ts. */
export type ContractProducerDecl = ContractProducerEntry;

export type ConformanceLeg = "emit" | "mirror" | "consumer";

export interface ConformanceLegResult {
  leg: ConformanceLeg;
  status: "pass" | "fail" | "skip";
  exitCode?: number;
  durationMs: number;
  output?: string;
  truncated?: boolean;
  /** Present when the failure is transport, not a process verdict. */
  transport?: "spawn-error" | "timeout";
  /** Spawn error message (ENOENT, EACCES, …) when transport === "spawn-error". */
  errorDetail?: string;
}

export interface ConformanceVerdict {
  producer: string;
  status: "pass" | "fail" | "skip";
  failedLeg?: ConformanceLeg;
  legs: ConformanceLegResult[];
  diagnostics: string[];
}

/** True when the declared consumer checkout exists on this machine. */
export function consumerAvailable(root: string, repoRoot: string = process.cwd()): boolean {
  return existsSync(resolveConsumerRoot(root, repoRoot));
}

function resolveConsumerRoot(root: string, repoRoot: string): string {
  return isAbsolute(root) ? root : resolve(repoRoot, root);
}

function substituteBundle(argv: string[], bundleDir: string): string[] {
  return argv.map((arg) => arg.split(BUNDLE_PLACEHOLDER).join(bundleDir));
}

interface LegOutcome {
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  output: string;
  truncated: boolean;
}

/** Spawn an argv-array leg — shell-free per DNA-89 — with timeout + tail-bounded capture. */
function runLegProcess(
  argv: string[],
  cwd: string,
  bundleDir: string,
  timeoutMs: number,
): Promise<LegOutcome> {
  return new Promise((resolvePromise) => {
    let output = "";
    let truncated = false;
    let settled = false;
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, [CONFORMANCE_BUNDLE_DIR_ENV]: bundleDir },
      shell: false,
    });
    const append = (chunk: Buffer | string) => {
      const combined = output + chunk.toString();
      if (combined.length > CONFORMANCE_OUTPUT_TAIL_BYTES) truncated = true;
      output = combined.slice(-CONFORMANCE_OUTPUT_TAIL_BYTES);
    };
    const finish = (outcome: Omit<LegOutcome, "output" | "truncated">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...outcome, output, truncated });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ exitCode: null, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      finish({ exitCode: null, timedOut: false, spawnError: err.message });
    });
    child.on("close", (code) => {
      finish({ exitCode: code, timedOut: false });
    });
  });
}

async function executeLeg(
  leg: ConformanceLeg,
  argv: string[],
  cwd: string,
  bundleDir: string,
  timeoutMs: number,
): Promise<ConformanceLegResult> {
  const started = Date.now();
  const outcome = await runLegProcess(substituteBundle(argv, bundleDir), cwd, bundleDir, timeoutMs);
  const durationMs = Date.now() - started;
  if (outcome.spawnError !== undefined || outcome.timedOut || outcome.exitCode !== 0) {
    return {
      leg,
      status: "fail",
      exitCode: outcome.exitCode ?? undefined,
      durationMs,
      output: outcome.output || undefined,
      truncated: outcome.truncated || undefined,
      transport:
        outcome.spawnError !== undefined ? "spawn-error" : outcome.timedOut ? "timeout" : undefined,
      errorDetail: outcome.spawnError,
    };
  }
  return {
    leg,
    status: "pass",
    exitCode: 0,
    durationMs,
    output: outcome.output || undefined,
    truncated: outcome.truncated || undefined,
  };
}

/**
 * Run the golden-conformance legs for one declared producer: emit the bundle
 * into a fresh tmpdir, re-check it with the optional same-input mirror, then
 * invoke the authoritative consumer validator inside the consumer checkout.
 * The tmpdir is removed in `finally`; nothing is written into the repo.
 */
/**
 * RFC-1539: absolute path of a published validator's bin inside the producer
 * repository (`<repoRoot>/node_modules/.bin/<name>`, `.cmd` shim on win32), or
 * null when it is not installed.
 */
export function resolvePackageConsumerBin(repoRoot: string, name: string): string | null {
  const base = join(repoRoot, "node_modules", ".bin", name);
  const candidates = process.platform === "win32" ? [`${base}.cmd`, base] : [base];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

export async function runProducerConformance(
  decl: ContractProducerDecl,
  opts: { repoRoot: string; requireConsumer?: boolean },
): Promise<ConformanceVerdict> {
  const bundleDir = mkdtempSync(join(tmpdir(), "conformance-"));
  const legs: ConformanceLegResult[] = [];
  const diagnostics: string[] = [];
  const verdict = (
    status: ConformanceVerdict["status"],
    failedLeg?: ConformanceLeg,
  ): ConformanceVerdict => ({
    producer: decl.id,
    status,
    failedLeg,
    legs,
    diagnostics,
  });
  try {
    // --- emit leg: producer argv writes the bundle into the tmpdir ---
    let leg = await executeLeg(
      "emit",
      decl.emit.argv,
      opts.repoRoot,
      bundleDir,
      CONFORMANCE_DEFAULT_TIMEOUT_MS,
    );
    if (leg.status === "pass") {
      let entries: number | null = null;
      try {
        entries = readdirSync(bundleDir).length;
      } catch (err) {
        diagnostics.push(
          `emit completed but the bundle dir is unreadable: ${(err as Error).message}`,
        );
      }
      if (entries !== null && entries === 0) {
        diagnostics.push(
          "emit completed but left the bundle dir empty — bundle shape is the consumer's authority, existence is the emit leg's contract",
        );
      }
      if (entries === null || entries === 0) {
        leg = { ...leg, status: "fail" };
      }
    }
    legs.push(leg);
    if (leg.status === "fail") {
      if (diagnostics.length === 0) {
        diagnostics.push(
          leg.transport === "spawn-error"
            ? `emit argv spawn failed: ${leg.errorDetail ?? "unknown spawn error"}`
            : leg.transport === "timeout"
              ? `emit argv timed out after ${CONFORMANCE_DEFAULT_TIMEOUT_MS}ms`
              : `emit argv exited ${leg.exitCode ?? "unknown"}`,
        );
      }
      return verdict("fail", "emit");
    }

    // --- mirror leg: same-input producer-side re-check (optional) ---
    if (decl.mirror) {
      leg = await executeLeg(
        "mirror",
        decl.mirror.argv,
        opts.repoRoot,
        bundleDir,
        CONFORMANCE_DEFAULT_TIMEOUT_MS,
      );
      legs.push(leg);
      if (leg.status === "fail") {
        diagnostics.push(
          leg.transport === "spawn-error"
            ? `mirror argv spawn failed: ${leg.errorDetail ?? "unknown spawn error"}`
            : leg.transport === "timeout"
              ? `mirror argv timed out after ${CONFORMANCE_DEFAULT_TIMEOUT_MS}ms`
              : `mirror exited ${leg.exitCode} — mirror-stricter-than-consumer drift or broken mirror; consumer leg not run`,
        );
        return verdict("fail", "mirror");
      }
    }

    // --- consumer leg, package form (RFC-1539): the published validator's bin, never skipped ---
    if (decl.consumer.package !== undefined) {
      const [bin, ...rest] = decl.consumer.validator.argv;
      const binPath = resolvePackageConsumerBin(opts.repoRoot, bin);
      if (binPath === null) {
        legs.push({ leg: "consumer", status: "fail", durationMs: 0 });
        diagnostics.push(
          `consumer-missing: consumer.package ${decl.consumer.package} is not installed or has no bin "${bin}" in node_modules/.bin — a package consumer never self-skips (RFC-1539)`,
        );
        return verdict("fail", "consumer");
      }
      leg = await executeLeg(
        "consumer",
        [binPath, ...rest],
        opts.repoRoot,
        bundleDir,
        decl.consumer.validator.timeoutMs ?? CONFORMANCE_DEFAULT_TIMEOUT_MS,
      );
      legs.push(leg);
      if (leg.status === "fail") {
        diagnostics.push(
          leg.transport === "spawn-error"
            ? `consumer validator spawn failed: ${leg.errorDetail ?? "unknown spawn error"} — transport failure, not a bundle verdict`
            : leg.transport === "timeout"
              ? `consumer validator timed out after ${decl.consumer.validator.timeoutMs ?? CONFORMANCE_DEFAULT_TIMEOUT_MS}ms — transport failure, not a bundle verdict`
              : `consumer validator ${decl.consumer.package} exited ${leg.exitCode} — see captured output`,
        );
        return verdict("fail", "consumer");
      }
      return verdict("pass", undefined);
    }

    // --- consumer leg: the authoritative validator in the sibling checkout ---
    const consumerRoot = resolveConsumerRoot(decl.consumer.root, opts.repoRoot);
    if (!existsSync(consumerRoot)) {
      if (opts.requireConsumer) {
        legs.push({ leg: "consumer", status: "fail", durationMs: 0 });
        diagnostics.push(`consumer-missing: declared consumer.root absent: ${consumerRoot}`);
        return verdict("fail", "consumer");
      }
      legs.push({ leg: "consumer", status: "skip", durationMs: 0 });
      diagnostics.push(
        `consumer.root absent on this machine — consumer leg skipped (${consumerRoot}); use --require-consumer or FORGE_CONFORMANCE_REQUIRE=1 to fail instead`,
      );
      return verdict("skip", undefined);
    }
    leg = await executeLeg(
      "consumer",
      decl.consumer.validator.argv,
      consumerRoot,
      bundleDir,
      decl.consumer.validator.timeoutMs ?? CONFORMANCE_DEFAULT_TIMEOUT_MS,
    );
    legs.push(leg);
    if (leg.status === "fail") {
      diagnostics.push(
        leg.transport === "spawn-error"
          ? `consumer validator spawn failed: ${leg.errorDetail ?? "unknown spawn error"} — transport failure, not a bundle verdict`
          : leg.transport === "timeout"
            ? `consumer validator timed out after ${decl.consumer.validator.timeoutMs ?? CONFORMANCE_DEFAULT_TIMEOUT_MS}ms — transport failure, not a bundle verdict`
            : `consumer validator exited ${leg.exitCode} — see captured output`,
      );
      return verdict("fail", "consumer");
    }
    return verdict("pass", undefined);
  } finally {
    try {
      rmSync(bundleDir, { recursive: true, force: true });
    } catch {
      // cleanup failure (EPERM/EBUSY/orphaned grandchildren) must not mask the verdict
    }
  }
}
