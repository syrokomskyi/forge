/*
<MODULE_CONTRACT>
<purpose>
small-domain.proof.test.ts — RFC-1391 verifier fixture: a proof entry
enumerating exactly 3 inputs through exhaustive(), used to exercise the
proved path and the cardinality gate.
</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
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
  <item>RFC-1485: sweep compass headers — forge-os-rfc</item>
</CHANGE_SUMMARY>
*/

// RFC-1391 verifier fixture — a *.proof.test.ts entry enumerating exactly 3
// literal inputs through the REAL exhaustive runner. Verifier-authored; used
// as the `entry` of the fixture proof specs. Under vitest it asserts; under
// proof.check (FORGE_PROOF_REPORT) it writes the report consumed by the runner.
import { it } from "vitest";
import { exhaustive } from "../../../../../src/formal/index.ts";

const SMALL_DOMAIN = ["alpha", "beta", "gamma"] as const;

it("every literal input satisfies the predicate", () => {
  exhaustive(SMALL_DOMAIN, (input) =>
    typeof input === "string" && input.length > 0 ? true : "not a non-empty string",
  );
});
