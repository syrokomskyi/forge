/*
<MODULE_CONTRACT>
<purpose>
Independent acceptance-verifier check for RFC-1391 (ac10-operating-model-policy) — authored inside
rfc.verify.workspace by the clean-context verifier, not by the implementer.
Derives its expectation from the RFC text and the observable behavior of the
real handlers/runner it exercises.
</purpose>
<non-goals>
  <item>Do not treat as implementer-authored evidence — its expectationSource is independent.</item>
  <item>Do not edit to fit the code — a failure here is a counterexample, fix the implementation.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1391 r1 verification: independent check ac10-operating-model-policy.</item>
  <item>RFC-1391: commit independent verifier checks + independent probes + round-1 pass report

Round-0 verdict counterexamples (CX-1: emit dead for proof-probe RFCs),
fixed in 1342fe21a; round-1 verdict pass — 47/47 checks, AC-1..AC-10 all
verified on the real implementation surface, non-vacuity re-verified by
mutation.</item>
</CHANGE_SUMMARY>
*/

// RFC-1391 AC-10 — "The agent operating model SHALL state that only a
// mechanical checker verdict counts as formal-tier evidence."
// RFC design: an agent-written argument, a random-sampling property test, or
// an unavailable checker must never be accepted as formal evidence — the
// operating model text is the enforcement surface agents read.
//
// Independent check: the canonical source file under packages/forge/skills/
// carries the policy, and the synced .agents mirror is byte-identical (the
// documented sync contract — drift would silently un-teach agents).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EXPORT_ROOT, FORGE_ROOT } from "./support.ts";

const SRC = join(FORGE_ROOT, "skills/_shared/agent-operating-model.md");
const MIRROR = join(EXPORT_ROOT, ".agents/skills/_shared/agent-operating-model.md");

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("AC-10: operating model binds formal evidence to a mechanical checker verdict", () => {
  it("the source operating model states the policy", () => {
    const text = readFileSync(SRC, "utf8");
    // The load-bearing claim: mechanical-verdict-only formal evidence.
    expect(text).toContain("Only a mechanical checker verdict");
    // It must name the instrument and the bound spec schema.
    expect(text).toContain("proof.check");
    expect(text).toContain("proved");
    expect(text).toContain("forge/proof-spec@1");
    // And it must exclude the non-mechanical substitutes the RFC calls out.
    expect(text).toMatch(/never does|never counts/i);
  });

  it("the .agents mirror is byte-identical to the source (sync contract)", () => {
    expect(sha(MIRROR)).toBe(sha(SRC));
  });
});
