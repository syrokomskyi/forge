/*
<MODULE_CONTRACT>
<purpose>
Independent acceptance-verifier check for RFC-1391 (ac7-v46-empty-assumptions) — authored inside
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
  <item>RFC-1391 r1 verification: independent check ac7-v46-empty-assumptions.</item>
  <item>RFC-1391: commit independent verifier checks + independent probes + round-1 pass report

Round-0 verdict counterexamples (CX-1: emit dead for proof-probe RFCs),
fixed in 1342fe21a; round-1 verdict pass — 47/47 checks, AC-1..AC-10 all
verified on the real implementation surface, non-vacuity re-verified by
mutation.</item>
</CHANGE_SUMMARY>
*/

// RFC-1391 AC-7 — "WHEN a proof spec has an empty `assumptions` list (or an
// invalid spec), THEN rfc.validate SHALL report V-46." RFC design: the schema
// requires non-empty assumptions/trustedBase/unverifiedBoundaries — an empty
// trust declaration is evidence garbage.
//
// Independent check: the REAL `runRfcValidate` handler over a tmp workspace —
// an accepted RFC declaring a `probe: proof` bound to a spec file we control.
// Cases: empty assumptions → V-46 error naming `assumptions`; missing spec on
// an accepted RFC → V-46 error; missing spec on a draft → V-46 warning;
// valid spec → no V-46 at all.

import { afterEach, describe, expect, it } from "vitest";

import { runRfcValidate } from "../../handlers/validate.ts";
import type { ForgeCommandInput } from "../../../../src/types.ts";
import { ctx, exhaustiveSpec, put, rfcMd, tmpWorkspace } from "./support.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const input = (flags: Record<string, unknown>): ForgeCommandInput =>
  ({ argv: [], flags }) as unknown as ForgeCommandInput;

const RFC_ID = "RFC-9009";
const SPEC_REL = "specs/claims.proof.yaml";
const PROBE = `  - probe: proof
    criterion: AC-1
    spec: "${SPEC_REL}"
    expectationSource: self
`;
const CRITERIA = [
  "AC-1: WHEN the checker accepts the spec, THE command SHALL return proved (evidence: probe:AC-1)",
];

const specWithEmptyAssumptions = `schema: forge/proof-spec@1
id: PROOF-ac7
invariantRefs: [INV-ac7-01]
statement: "the trust surface is empty"
tool: exhaustive
toolVersion: "1"
entry: "specs/claims.ts"
target: "claims"
domain:
  description: "bounded"
  cardinality: 3
assumptions: []
trustedBase:
  - "the runner"
unverifiedBoundaries:
  - "nothing"
`;

function setupRfc(opts: { status?: string; specBody?: string }): { dir: string } {
  const { dir, cleanup } = tmpWorkspace("rfc1391-ac7-");
  cleanups.push(cleanup);
  put(dir, "docs/rfcs/rfc-9009-empty-assumptions.md", rfcMd({
    id: RFC_ID,
    status: opts.status ?? "accepted",
    probesYaml: PROBE,
    criteria: CRITERIA,
  }));
  if (opts.specBody !== undefined) put(dir, SPEC_REL, opts.specBody);
  return { dir };
}

const v46 = async (dir: string) => {
  const res = await runRfcValidate(input({ id: RFC_ID }), ctx(dir));
  return { res, hits: (res.data?.violations ?? []).filter((v) => v.rule === "V-46") };
};

describe("AC-7: rfc.validate reports V-46 on invalid proof specs", () => {
  it("empty `assumptions: []` → V-46 error naming the assumptions field", async () => {
    const { dir } = setupRfc({ specBody: specWithEmptyAssumptions });
    const { hits } = await v46(dir);
    expect(hits.length).toBe(1);
    expect(hits[0]!.severity).toBe("error");
    expect(hits[0]!.message).toContain("assumptions");
  });

  it("missing spec on an accepted RFC → V-46 error", async () => {
    const { dir } = setupRfc({});
    const { hits } = await v46(dir);
    expect(hits.length).toBe(1);
    expect(hits[0]!.severity).toBe("error");
    expect(hits[0]!.message).toContain("missing");
  });

  it("missing spec on a draft RFC → V-46 downgraded to warning", async () => {
    const { dir } = setupRfc({ status: "draft" });
    const { hits } = await v46(dir);
    expect(hits.length).toBe(1);
    expect(hits[0]!.severity).toBe("warning");
  });

  it("control: a spec satisfying forge/proof-spec@1 → zero V-46 violations", async () => {
    const { dir } = setupRfc({ specBody: exhaustiveSpec({ id: "PROOF-ac7-ok" }) });
    const { hits } = await v46(dir);
    expect(hits).toEqual([]);
  });
});
