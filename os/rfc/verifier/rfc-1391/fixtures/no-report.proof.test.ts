/*
<MODULE_CONTRACT>
<purpose>
Shared fixture builders for the RFC-1391 independent verifier checks —
tmp-workspace and runtime-context helpers only. Nothing here re-implements
production logic; expectations live in the *.acceptance.test.ts files.
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1391 r1 verification: shared verifier support module.</item>
  <item>RFC-1391: commit independent verifier checks + independent probes + round-1 pass report

Round-0 verdict counterexamples (CX-1: emit dead for proof-probe RFCs),
fixed in 1342fe21a; round-1 verdict pass — 47/47 checks, AC-1..AC-10 all
verified on the real implementation surface, non-vacuity re-verified by
mutation.</item>
</CHANGE_SUMMARY>
*/

// RFC-1391 verifier fixture — an entry that NEVER calls exhaustive(), so a
// proof.check run produces no FORGE_PROOF_REPORT payload (the runner must
// surface that as an `error`, never a pass). Verifier-authored.
import { it } from "vitest";

it("does nothing", () => {
  // Deliberately empty — the point is the absence of an exhaustive() call.
});
