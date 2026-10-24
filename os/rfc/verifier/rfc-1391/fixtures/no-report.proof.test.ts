/*
<MODULE_CONTRACT>
<purpose>
no-report.proof.test.ts — RFC-1391 verifier fixture: a proof entry that never
calls exhaustive(), so the run produces no report and the verdict must be
`error` (never `proved`, never `refuted`).
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1391 r1 verification: shared verifier support module.</item>
  <item>RFC-1391: commit independent verifier checks + independent probes + round-1 pass report

Round-0 verdict counterexamples (CX-1: emit dead for proof-probe RFCs),
fixed in 1342fe21a; round-1 verdict pass — 47/47 checks, AC-1..AC-10 all
verified on the real implementation surface, non-vacuity re-verified by
mutation.</item>
  <item>RFC-1391: close RFC-1391 review r1 findings — evidence freshness, config classification, contract guards

REVIEW-CODE-2026-10-24-04 (warning): a stale .cache/proofs report could
fabricate proved; forge.yaml now resolves inside runProofCheck so a malformed
config is error not unavailable, and both surfaces share one path; {entry} is
required in formal.tools.command; spec/entry paths are confined to the
workspace; the exhaustive entry dispatches per packageManager; proved runs
record log, counterexample stays the refuted-path record.</item>
</CHANGE_SUMMARY>
*/

// RFC-1391 verifier fixture — an entry that NEVER calls exhaustive(), so a
// proof.check run produces no FORGE_PROOF_REPORT payload (the runner must
// surface that as an `error`, never a pass). Verifier-authored.
import { it } from "vitest";

it("does nothing", () => {
  // Deliberately empty — the point is the absence of an exhaustive() call.
});
