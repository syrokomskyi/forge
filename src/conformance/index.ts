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
  <item>RFC-1365: initial conformance execution path — emit/mirror/consumer legs, tail-bounded output, skip/require verdicts.</item>
  <item>RFC-1365: step 1 — contractProducers schema + conformance execution path</item>
  <item>RFC-1365: step 2 — forge.conformance.run/validate commands + dual-surface registration</item>
  <item>RFC-1365: compass header fix — drop forbidden keywords/responsibilities tags, expand purpose</item>
</CHANGE_SUMMARY>
*/

import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { existsSync, mkdtempSync, readdirSync, rmSync, spawn } from "../utils/sync-fs.ts";

/** Captured leg output is tail-truncated to this many bytes (RFC-1365). */
export const CONFORMANCE_OUTPUT_TAIL_BYTES = 64 * 1024;
/** Default per-leg timeout matching the pipelines conformance precedent. */
export const CONFORMANCE_DEFAULT_TIMEOUT_MS = 240_000;
/** Env var exported to leg subprocesses so argv can locate the bundle dir. */
export const CONFORMANCE_BUNDLE_DIR_ENV = "FORGE_CONFORMANCE_BUNDLE_DIR";

const BUNDLE_PLACEHOLDER = "{bundle}";

export interface ContractProducerDecl {
  id: string;
  emit: { argv: string[] };
  mirror?: { argv: string[] };
  consumer: {
    root: string;
    validator: { argv: string[]; timeoutMs?: number };
  };
  test?: string;
}

export type ConformanceLeg = "emit" | "mirror" | "consumer";

export interface ConformanceLegResult {
  leg: ConformanceLeg;
  status: "pass" | "fail" | "skip";
  exitCode?: number;
  durationMs: number;
  output?: string;
  truncated?: boolean;
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
    if (leg.status === "pass" && readdirSync(bundleDir).length === 0) {
      leg = { ...leg, status: "fail" };
      diagnostics.push(
        "emit completed but left the bundle dir empty — bundle shape is the consumer's authority, existence is the emit leg's contract",
      );
    }
    legs.push(leg);
    if (leg.status === "fail") {
      if (diagnostics.length === 0) {
        diagnostics.push(`emit argv exited ${leg.exitCode ?? "spawn-error/timeout"}`);
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
          `mirror exited ${leg.exitCode ?? "spawn-error/timeout"} — mirror-stricter-than-consumer drift or broken mirror; consumer leg not run`,
        );
        return verdict("fail", "mirror");
      }
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
        leg.exitCode === undefined
          ? "consumer validator transport failure (spawn error or timeout) — not a bundle verdict"
          : `consumer validator exited ${leg.exitCode} — see captured output`,
      );
      return verdict("fail", "consumer");
    }
    return verdict("pass", undefined);
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
}
