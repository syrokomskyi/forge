/*
<MODULE_CONTRACT>
<purpose>
RFC-1391: the built-in `exhaustive` proof runner — enumerates a finite,
deterministic domain and applies a check function to every element. Under
vitest it throws on any failure (the `*.proof.test.ts` entry doubles as an
ordinary test); under `proof.check` (FORGE_PROOF_REPORT set) it writes
`{enumerated, failures}` to the report path instead of asserting, so the
caller derives the verdict from the report — never from an exit code alone.
</purpose>
<non-goals>
  <item>Do not sample — a proof covers every declared input; probabilistic checks are property tests, not formal evidence.</item>
  <item>Do not spawn the entry or compare cardinality — proof-check.ts owns execution and the count gate.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Two-pass enumeration: a domain not iterable twice with equal counts is non-deterministic and refused.</item>
  <item>Report mode suppresses the throw — a refuted run still writes its counterexample report.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1391: exhaustive runner + exhaustiveVerdict count/failure gate.</item>
  <item>RFC-1391: make the formal verification tier checker-bound (RFC-1391)</item>
  <item>RFC-1391: close RFC-1391 review r1 findings — evidence freshness, config classification, contract guards

REVIEW-CODE-2026-10-24-04 (warning): a stale .cache/proofs report could
fabricate proved; forge.yaml now resolves inside runProofCheck so a malformed
config is error not unavailable, and both surfaces share one path; {entry} is
required in formal.tools.command; spec/entry paths are confined to the
workspace; the exhaustive entry dispatches per packageManager; proved runs
record log, counterexample stays the refuted-path record.</item>
  <item>RFC-1485: sweep compass headers — forge-src + forge root eslint</item>
</CHANGE_SUMMARY>
*/

import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "../utils/sync-fs.ts";

/** Env var proof.check sets — when present the runner writes its report there. */
export const FORGE_PROOF_REPORT_ENV = "FORGE_PROOF_REPORT";

/** Version pin for the built-in exhaustive runner — proof specs declare this in `toolVersion`. */
export const EXHAUSTIVE_TOOL_VERSION = "1";

export interface ExhaustiveFailure<I = unknown> {
  input: I;
  reason: string;
}

export interface ExhaustiveResult<I = unknown> {
  /** Number of domain inputs enumerated (first pass). */
  enumerated: number;
  failures: ExhaustiveFailure<I>[];
}

/** Returns a passing bool or a failure reason. `true` = input satisfies the property. */
export type ExhaustiveCheck<I> = (input: I) => true | string;

/** Domain source rejected — not a twice-iterable finite input set. */
export class ExhaustiveDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExhaustiveDomainError";
  }
}

/** One or more inputs violated the property (vitest assertion path). */
export class ExhaustiveRefutedError extends Error {
  readonly failures: ExhaustiveFailure[];
  constructor(message: string, failures: ExhaustiveFailure[]) {
    super(message);
    this.name = "ExhaustiveRefutedError";
    this.failures = failures;
  }
}

function serialize(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s === undefined ? String(input) : s;
  } catch {
    return String(input);
  }
}

/** Duck-typed fast-check Arbitrary — has `generate`/`map`/`filter` but no iterator. */
function looksLikeArbitrary(domain: unknown): boolean {
  if (domain === null || typeof domain !== "object") return false;
  const d = domain as Record<string, unknown>;
  return typeof d["generate"] === "function" && typeof d["map"] === "function";
}

/**
 * Enumerate `domain` fully and apply `check` to every input.
 *
 * Throws `ExhaustiveDomainError` for non-iterables, fast-check arbitraries,
 * async iterables, and domains whose second enumeration yields a different
 * count. Returns the result object; under vitest (no FORGE_PROOF_REPORT)
 * non-empty failures throw `ExhaustiveRefutedError`; under proof.check the
 * report is written and the result returned for the caller to judge.
 */
export function exhaustive<I>(domain: Iterable<I>, check: ExhaustiveCheck<I>): ExhaustiveResult<I> {
  if (looksLikeArbitrary(domain)) {
    throw new ExhaustiveDomainError(
      "domain looks like a fast-check Arbitrary — sampled generation is not exhaustive enumeration",
    );
  }
  const iterable = domain as unknown as Record<symbol, unknown> | null | undefined;
  if (
    iterable == null ||
    typeof iterable[Symbol.iterator] !== "function" ||
    typeof iterable[Symbol.asyncIterator] === "function"
  ) {
    throw new ExhaustiveDomainError(
      "domain is not a synchronous iterable — async streams and unbounded sources cannot be enumerated exhaustively",
    );
  }

  const first = Array.from(domain);
  const failures: ExhaustiveFailure<I>[] = [];
  for (const input of first) {
    const outcome = check(input);
    if (outcome !== true) {
      failures.push({
        input,
        reason: typeof outcome === "string" ? outcome : "check returned false",
      });
    }
  }

  // Determinism guard — the declared domain must re-enumerate to the same
  // count; a one-shot generator yields 0 here, a seeded source a drifted set.
  const second = Array.from(domain);
  if (second.length !== first.length) {
    throw new ExhaustiveDomainError(
      `domain re-enumeration yielded ${second.length} inputs vs first-pass ${first.length} — non-deterministic iterable`,
    );
  }

  const result: ExhaustiveResult<I> = { enumerated: first.length, failures };

  const reportPath = process.env[FORGE_PROOF_REPORT_ENV];
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(
      reportPath,
      JSON.stringify({ enumerated: result.enumerated, failures }, null, 2) + "\n",
    );
    return result;
  }

  if (failures.length > 0) {
    const preview = failures
      .slice(0, 5)
      .map((f) => `  ${serialize(f.input)} — ${f.reason}`)
      .join("\n");
    throw new ExhaustiveRefutedError(
      `exhaustive check refuted: ${failures.length}/${result.enumerated} inputs failed\n${preview}`,
      failures,
    );
  }
  return result;
}

/** Verdict for a completed exhaustive run — shared by vitest entries and proof.check. */
export function exhaustiveVerdict(
  result: ExhaustiveResult,
  declaredCardinality: number,
): { verdict: "proved" | "refuted" | "error"; message: string } {
  if (result.enumerated !== declaredCardinality) {
    return {
      verdict: "error",
      message: `enumerated ${result.enumerated} inputs but the spec declares cardinality ${declaredCardinality} — the domain silently shrank or grew`,
    };
  }
  if (result.failures.length > 0) {
    const first = result.failures[0]!;
    return {
      verdict: "refuted",
      message: `${result.failures.length}/${result.enumerated} inputs violated the theorem — first counterexample: ${serialize(first.input)} (${first.reason})`,
    };
  }
  return { verdict: "proved", message: `all ${result.enumerated} inputs satisfy the theorem` };
}
