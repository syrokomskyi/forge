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
