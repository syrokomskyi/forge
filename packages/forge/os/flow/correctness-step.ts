/*
<MODULE_CONTRACT>
<purpose>RFC-1580: the flow.integrate correctness step — spawn the PRIMARY
checkout's forge install (`<primary>/node_modules/.bin/forge correctness.gate
--base <sha> --json`) with cwd = the session worktree, after
hooks/integration-gate.sh passed and before the fast-forward, and translate
the result into a FLOW-INT-18 refusal or warning.</purpose>
<non-goals>
  <item>Never runs the gate in-process — the code under review must not judge its own gate (RFC-1538 deviation, deliberate).</item>
  <item>Never decides a weakening — `--accept-weakening` is an operator flag passed through verbatim.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Refuse on missing binary/spawn/parse/gate failure; "Unknown command" degrades — refusal would deadlock the installing upgrade.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
  <item>RFC-1580: close review REVIEW-CODE-2026-11-13-04 findings

F1 bootstrap degrade only on an exact unknown-command stderr line with no JSON; F2 review records count only from a verifier-trailer commit naming them; F3 any frozen substrate change or dropped capture is a weakening, declared L3 needs loaded captures; F4 requirement origin needs acceptance before --base; F5 anchor events only for L2+ runs; F6 proof oracles via proof.check only, non-self; F7 bundle naming; F8/F9 limitations; F10 every anchor copy; F11 base entry refs; F12 unreadable base manifest refuses; F13 dirty worktree warning; F14 source/statement diffs; F15 process-group kill; F16 run root cleanup; F20 review dir stripped, blob hashes. Regression tests for spoofing, plain-commit review, L3, requirement origin, rewording, timeout, formal tier, rebind, real-gate pass, accept-weakening. DEV-1..DEV-6 recorded in the RFC.</item>
  <item>RFC-1580: close review REVIEW-CODE-2026-11-13-05 findings

N1 bootstrap degrade only while the base has not adopted the contour (a forge downgrade refuses); N2 L3 on data/lifecycle counts at its attested level; N3 anchor events bound to the attested handle; N4 new support-glob files are frozen additions; N5/N6 isolated sessions may touch anchor files and only frozen forge.yaml keys; N7 RFC body amended; N8 regression tests; N9 run root in finally and grandchildren reaped; N10 every declared capture loaded. DEV-7 recorded; DEV-5 narrowed pending operator confirmation.</item>
  <item>RFC-1615: close round-21 counterexamples — YAML-loader adoption check, absent-vs-unreadable base reads</item>
  <item>RFC-1615: close round-22 counterexamples — adoption means any armed contour element</item>
  <history>RFC-1580</history>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { Diagnostic, WorkspaceIO } from "../../src/types.ts";

export interface CorrectnessStepResult {
  status: "pass" | "fail" | "exempt" | "not-run";
  bundlePath: string | null;
  acceptedWeakening: string | null;
  refusal?: { message: string; fixHint: string };
  warning?: Diagnostic;
}

interface GateJson {
  status?: string;
  bundlePath?: string;
  acceptedWeakening?: string | null;
  violations?: { rule: string; severity: string; message: string }[];
}

function parseJson(stdout: string): GateJson | null {
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as GateJson & { data?: GateJson };
    return parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
  } catch {
    return null;
  }
}

/**
 * Whether forge.yaml at the integration base adopted the correctness
 * contour. Three verdicts, never a boolean collapse:
 * - "adopted" — a manifest binding or a `correctness:` section parses (the
 *   gate itself binds through the full YAML loader in `sideFrom`, so a line
 *   regex misses quoted keys, flow style, and space-before-colon spellings
 *   the loader accepts — CX-130);
 * - "not-adopted" — forge.yaml is absent at base or parses without either
 *   declaration (legit bootstrap degrade);
 * - "unreadable" — the file exists but a git read or exec failed; absent ≠
 *   unreadable, a failure must never launder as "not adopted" (CX-131).
 */
async function baseAdoptedGate(
  io: WorkspaceIO,
  worktree: string,
  base: string,
): Promise<"adopted" | "not-adopted" | "unreadable"> {
  try {
    // Existence first: `ls-tree` answers 0/empty for a missing file on a
    // valid rev but non-zero on a bad rev / corrupt tree / spawn failure.
    const ls = await io.exec("git", ["ls-tree", base, "--", "forge.yaml"], { cwd: worktree });
    if (ls.exitCode !== 0) return "unreadable";
    if (!ls.stdout.trim()) return "not-adopted";
    const shown = await io.exec("git", ["show", `${base}:forge.yaml`], { cwd: worktree });
    if (shown.exitCode !== 0) return "unreadable";
    let doc: unknown;
    try {
      doc = parseYaml(shown.stdout);
    } catch {
      // An unparseable base forge.yaml cannot prove the contour absent.
      return "adopted";
    }
    // Prototype parity with sideFrom's isPlainMap: anything that is not a
    // plain map (scalars, arrays, and tagged roots — !!set/!!omap/!!timestamp/
    // !!binary parse to Set/Map/Date/Uint8Array, all `typeof "object"`)
    // makes the base forge.yaml unreadable to the gate itself, so the
    // contour is armed, never "not adopted" (CX-132).
    const proto = doc === null || typeof doc !== "object" ? null : Object.getPrototypeOf(doc);
    if (doc === null || typeof doc !== "object" || (proto !== Object.prototype && proto !== null))
      return "adopted";
    const rec = doc as Record<string, unknown>;
    const bindings = rec["bindings"] as Record<string, unknown> | undefined;
    const bPaths = bindings?.["paths"] as Record<string, unknown> | undefined;
    const bCommands = bindings?.["commands"] as Record<string, unknown> | undefined;
    // Every judged binding row arms CORR-GATE-02 even without a manifest
    // contour — removing a bound checkRun/reviewsDir/rfcsDir/invariantsFile
    // is a weakening the gate refuses (CX-134).
    const bound =
      bPaths?.["correctnessManifest"] != null ||
      bPaths?.["oracleReviewsDir"] != null ||
      bPaths?.["invariantsFile"] != null ||
      bPaths?.["compassDocs"] != null ||
      bCommands?.["checkRun"] != null ||
      (rec["paths"] as Record<string, unknown> | undefined)?.["rfcsDir"] != null;
    // A declared `correctness:` or `policy:` section is a contour the gate
    // arms — `policy:` alone freezes hooks/workflows/pinned files, and a
    // malformed declaration refuses deny-by-default (CX-133).
    const declared = rec["correctness"] !== undefined || rec["policy"] !== undefined;
    return bound || declared ? "adopted" : "not-adopted";
  } catch {
    // An io.exec throw (spawn failure) is an unreadable read, not a verdict.
    return "unreadable";
  }
}

export async function runCorrectnessStep(
  io: WorkspaceIO,
  opts: { primary: string; worktree: string; base: string; acceptWeakening?: string },
): Promise<CorrectnessStepResult> {
  const bin = join(opts.primary, "node_modules", ".bin", "forge");
  const notRun = (message: string, fixHint: string): CorrectnessStepResult => ({
    status: "not-run",
    bundlePath: null,
    acceptedWeakening: null,
    refusal: { message, fixHint },
  });
  if (!(await io.exists(bin))) {
    return notRun(
      `the primary install's forge binary is missing (${bin}) — the correctness gate cannot run`,
      `run pnpm install in ${opts.primary}; the gate always runs from the primary checkout`,
    );
  }
  const args = ["correctness.gate", "--base", opts.base, "--json"];
  if (opts.acceptWeakening) args.push("--accept-weakening", opts.acceptWeakening);
  let result: { exitCode: number | null; stdout: string; stderr: string };
  try {
    result = await io.exec(bin, args, { cwd: opts.worktree });
  } catch (err) {
    return notRun(
      `could not start ${bin}: ${(err as Error).message}`,
      "repair the primary install, then re-run",
    );
  }
  const text = `${result.stdout}\n${result.stderr}`;
  const data = parseJson(result.stdout);
  // Bootstrap degrade only when the gate never ran: no JSON at all, a failing
  // exit, and a whole stderr line that is exactly the CLI's unknown-command
  // notice. Gate output echoes session-controlled text (exemption refs, check
  // names), so the phrase anywhere else must never switch the gate off.
  const unknownCommand =
    data === null &&
    result.exitCode !== 0 &&
    !result.stdout.includes("{") &&
    result.stderr
      .split("\n")
      .some((line) => /^\s*(?:✖\s*)?Unknown command: correctness\.gate\s*$/.test(line));
  const adopted = unknownCommand ? await baseAdoptedGate(io, opts.worktree, opts.base) : null;
  if (adopted === "adopted") {
    return notRun(
      "the primary install's forge does not know correctness.gate, but the base revision already adopted the correctness contour — a forge downgrade must not drop the gate",
      `restore an @warpgogol/forge with correctness.gate in ${opts.primary} (pnpm install), then re-run`,
    );
  }
  if (adopted === "unreadable") {
    return notRun(
      "the primary install's forge does not know correctness.gate and forge.yaml at the integration base could not be read — the contour's adoption cannot be proven absent, so the gate must not degrade",
      `fix the git read of ${opts.base}:forge.yaml (or restore an @warpgogol/forge with correctness.gate in ${opts.primary}), then re-run`,
    );
  }
  if (unknownCommand) {
    return {
      status: "not-run",
      bundlePath: null,
      acceptedWeakening: null,
      warning: {
        ruleId: "FLOW-INT-18",
        severity: "warning",
        message: `the primary install's forge predates correctness.gate (RFC-1580) — the correctness gate did not run for this integration`,
        fixHint: `upgrade @warpgogol/forge in ${opts.primary} (pnpm install after this integration lands) so later integrations are gated`,
      },
    };
  }
  if (data === null) {
    return notRun(
      `correctness.gate printed no JSON result (exit ${result.exitCode}): ${text.trim().split("\n").slice(-3).join(" | ")}`,
      "re-run the gate by hand from the session worktree to see its output",
    );
  }
  const bundlePath = data.bundlePath ?? null;
  if (result.exitCode !== 0 || data.status === "fail") {
    const errors = (data.violations ?? []).filter((v) => v.severity === "error");
    const detail = errors
      .slice(0, 8)
      .map((v) => `${v.rule} ${v.message}`)
      .join("; ");
    const mixed = errors.some((v) => /mixed-weakening/.test(v.message));
    return {
      status: "fail",
      bundlePath,
      acceptedWeakening: null,
      refusal: {
        message: `correctness.gate refused the integration${mixed ? " (mixed-weakening)" : ""}: ${detail}${errors.length > 8 ? ` …and ${errors.length - 8} more` : ""}${bundlePath ? ` — bundle ${bundlePath}` : ""}`,
        fixHint:
          'fix the named entries/oracles; a weakening lands only in an isolated session via flow.integrate --accept-weakening "<reason>" (operator decision)',
      },
    };
  }
  return {
    status: data.status === "exempt" ? "exempt" : "pass",
    bundlePath,
    acceptedWeakening: data.acceptedWeakening ?? null,
  };
}

export const CORRECTNESS_WEAKENING_TRAILER = "X-Correctness-Weakening";
