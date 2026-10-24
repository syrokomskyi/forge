/*
<MODULE_CONTRACT>
<purpose>
RFC-1391: forge/proof-spec@1 — the declarative proof-spec contract for
`probe: proof` acceptance probes and `proof.check`. A spec names the pinned
checker, the entry file, the exact theorem, its assumptions, and the model/code
boundary; evidence binds to the spec and entry bytes via sha256.
</purpose>
<non-goals>
  <item>Do not execute checkers — os/formal/handlers/proof-check.ts owns tool resolution and verdicts.</item>
  <item>Do not weaken invariants or detect spec drift — weakening detection belongs to RFC-1392.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>`.strict()` — unknown keys are rejected: a proof spec is evidence, so silent stripping would hide author typos.</item>
  <item>`domain.cardinality` stays schema-optional (external checkers need no declared domain); the `exhaustive` runner errors on its absence.</item>
  <item>`assumptions`, `trustedBase`, and `unverifiedBoundaries` are each `.min(1)` — a spec claiming to prove the whole system is refused by shape, not review.</item>
  <item>`tool` is the closed ProofTool enum — the set grows only by RFC, so a spec can never name a runner nobody implemented.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1391: forge/proof-spec@1 schema, ProofSpec/ProofTool/ProofVerdict/ProofCheckResult types.</item>
  <item>RFC-1391: make the formal verification tier checker-bound (RFC-1391)</item>
  <item>RFC-1391: close RFC-1391 review r1 findings — evidence freshness, config classification, contract guards

REVIEW-CODE-2026-10-24-04 (warning): a stale .cache/proofs report could
fabricate proved; forge.yaml now resolves inside runProofCheck so a malformed
config is error not unavailable, and both surfaces share one path; {entry} is
required in formal.tools.command; spec/entry paths are confined to the
workspace; the exhaustive entry dispatches per packageManager; proved runs
record log, counterexample stays the refuted-path record.</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

/** Schema identifier for the proof-spec contract. */
export const PROOF_SPEC_SCHEMA_ID = "forge/proof-spec@1";

/**
 * Closed checker set (RFC-1391). `exhaustive` is the built-in forge runner;
 * the rest are external checkers resolved from forge.yaml `formal.tools`.
 * Grows only by RFC.
 */
export const PROOF_TOOLS = ["tlc", "apalache", "dafny", "lean", "verus", "exhaustive"] as const;
export type ProofTool = (typeof PROOF_TOOLS)[number];

/** Verdicts a proof.check run may return. `proved` is the only passing verdict. */
export type ProofVerdict = "proved" | "refuted" | "unavailable" | "error";

/**
 * RFC-1391 proof spec. `tool` names either the built-in `exhaustive` runner or
 * a `formal.tools.<tool>` entry in the workshop's forge.yaml. `entry` is a
 * workspace-relative file the checker proves against (a `*.proof.test.ts` for
 * `exhaustive`; a spec module for external tools).
 */
export const proofSpecSchema = z
  .object({
    schema: z.literal(PROOF_SPEC_SCHEMA_ID),
    /** Spec id — names counterexample/log artifacts under .cache/proofs/. */
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "spec id must be a file-safe token"),
    /** Invariant ids (RFC-1390) this proof discharges — structural back-link. */
    invariantRefs: z.array(z.string().min(1)),
    /** The single statement the checker is asked to prove. */
    statement: z.string().min(1),
    /** Checker name — `exhaustive` (built-in) or a forge.yaml `formal.tools` key. */
    tool: z.enum(PROOF_TOOLS),
    /** Exact version string the checker must report; mismatch → `error`. */
    toolVersion: z.string().min(1),
    /** Workspace-relative entry file the checker proves against. */
    entry: z.string().min(1),
    /** Theorem, lemma, invariant, or test name inside `entry`. */
    target: z.string().min(1),
    /**
     * Declared domain the proof covers; `exhaustive` requires `cardinality`
     * for the enumerated-count gate.
     */
    domain: z
      .object({
        description: z.string().min(1),
        cardinality: z.number().int().positive(),
      })
      .optional(),
    /**
     * Declared assumptions the proof relies on. An empty list is a shape
     * failure — "no assumptions" is itself an assumption and must be written
     * as such (e.g. "no assumptions — closed model").
     */
    assumptions: z.array(z.string().min(1)).min(1),
    /** What is trusted but not re-verified — checker, runtime, harness. */
    trustedBase: z.array(z.string().min(1)).min(1),
    /**
     * Explicit model/code gaps this proof does NOT cover — must be non-empty
     * so the spec can never read as a whole-system claim.
     */
    unverifiedBoundaries: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type ProofSpec = z.infer<typeof proofSpecSchema>;

/**
 * Result of a single proof.check run — carried on the probe result and
 * recorded on the verification envelope for `proof` probes.
 */
export interface ProofCheckResult {
  specId: string;
  tool: string;
  /** The version actually observed — `null` when no checker ran. */
  toolVersion: string | null;
  verdict: ProofVerdict;
  /** Human-readable verdict explanation (never empty). */
  message: string;
  /** sha256 of the spec file bytes — binds the verdict to this spec. */
  specSha256: string;
  /** sha256 of the entry file bytes — binds the verdict to the implementation. */
  entrySha256: string;
  /** `exhaustive` only: number of domain inputs actually enumerated. */
  enumerated?: number;
  /** Workspace-relative path to the persisted counterexample — the refuted-path record. */
  counterexample?: string;
  /** Workspace-relative path to the persisted checker log (proved/error diagnostics). */
  log?: string;
  /** Wall time of the check run (ms). */
  durationMs: number;
}
