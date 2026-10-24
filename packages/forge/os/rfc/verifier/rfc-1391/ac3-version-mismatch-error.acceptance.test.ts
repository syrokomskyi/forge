/*
<MODULE_CONTRACT>
<purpose>
Independent acceptance-verifier check for RFC-1391 (ac3-version-mismatch-error) — authored inside
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
  <item>RFC-1391 r1 verification: independent check ac3-version-mismatch-error.</item>
  <item>RFC-1391: commit independent verifier checks + independent probes + round-1 pass report

Round-0 verdict counterexamples (CX-1: emit dead for proof-probe RFCs),
fixed in 1342fe21a; round-1 verdict pass — 47/47 checks, AC-1..AC-10 all
verified on the real implementation surface, non-vacuity re-verified by
mutation.</item>
</CHANGE_SUMMARY>
*/

// RFC-1391 AC-3 — "IF the installed tool reports a version different from
// toolVersion, THEN proof.check SHALL return verdict `error`."
//
// Independent check: REAL `runProofCheckCommand` over a tmp workspace — the
// stub's versionCommand reports 2.18 while the spec pins 2.17 (external path),
// plus the built-in exhaustive runner's own version pin.

import { afterEach, describe, expect, it } from "vitest";

import { runProofCheckCommand } from "../../../formal/handlers/proof-check.ts";
import type { ForgeCommandInput } from "../../../../src/types.ts";
import {
  ctx,
  exhaustiveSpec,
  externalSpec,
  forgeYaml,
  put,
  TLC_STUB_TOOLS,
  tmpWorkspace,
} from "./support.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const input = (flags: Record<string, unknown>): ForgeCommandInput =>
  ({ argv: [], flags }) as unknown as ForgeCommandInput;

describe("AC-3: tool version ≠ pinned toolVersion → error", () => {
  it("external checker reports 2.18 but spec pins 2.17 → error, exit != 0", async () => {
    const { dir, cleanup } = tmpWorkspace("rfc1391-ac3-ext-");
    cleanups.push(cleanup);
    put(dir, "forge.yaml", forgeYaml(TLC_STUB_TOOLS)); // stub reports "2.18"
    put(dir, "specs/claims.tla", "---- MODULE Claims ----\n====\n");
    put(dir, "specs/claims.proof.yaml", externalSpec({ toolVersion: "2.17" }));

    const res = await runProofCheckCommand(
      input({ spec: "specs/claims.proof.yaml" }),
      ctx(dir),
    );

    expect(res.exitCode).not.toBe(0);
    expect(res.data?.status).toBe("fail");
    const v = res.data?.verdict;
    expect(v?.verdict).toBe("error");
    expect(v?.toolVersion).toBe("2.18"); // observed version recorded
    expect(v?.message).toContain("2.18");
    expect(v?.message).toContain("2.17");
  });

  it("exhaustive spec pinning a wrong toolVersion → error before any run", async () => {
    const { dir, cleanup } = tmpWorkspace("rfc1391-ac3-exh-");
    cleanups.push(cleanup);
    put(dir, "specs/domain.proof.test.ts", "// entry exists for sha binding\n");
    put(
      dir,
      "specs/domain.proof.yaml",
      exhaustiveSpec({ toolVersion: "999", cardinality: 3 }),
    );

    const res = await runProofCheckCommand(
      input({ spec: "specs/domain.proof.yaml" }),
      ctx(dir),
    );

    expect(res.exitCode).not.toBe(0);
    const v = res.data?.verdict;
    expect(v?.verdict).toBe("error");
    expect(v?.message).toContain("999");
    expect(v?.toolVersion).toBe("1"); // observed built-in version recorded
  });
});
