/*
<MODULE_CONTRACT>
<purpose>
Independent acceptance-verifier check for RFC-1391 (ac2-unavailable-nonzero) — authored inside
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
  <item>RFC-1391 r1 verification: independent check ac2-unavailable-nonzero.</item>
  <item>RFC-1391: commit independent verifier checks + independent probes + round-1 pass report

Round-0 verdict counterexamples (CX-1: emit dead for proof-probe RFCs),
fixed in 1342fe21a; round-1 verdict pass — 47/47 checks, AC-1..AC-10 all
verified on the real implementation surface, non-vacuity re-verified by
mutation.</item>
</CHANGE_SUMMARY>
*/

// RFC-1391 AC-2 — "IF the configured tool executable is not installed, THEN
// proof.check SHALL return verdict `unavailable` with a non-zero exit code."
// RFC design adds: exit 1 WITH the install hint from forge.yaml — "a missing
// tool would silently produce no evidence instead of failing closed."
//
// Independent check: REAL `runProofCheckCommand` + real process spawn (ENOENT)
// over a tmp workspace; plus the undeclared-tool branch.

import { afterEach, describe, expect, it } from "vitest";

import { runProofCheckCommand } from "../../../formal/handlers/proof-check.ts";
import type { ForgeCommandInput } from "../../../../src/types.ts";
import {
  ctx,
  externalSpec,
  forgeYaml,
  put,
  TLC_MISSING_EXE_TOOLS,
  tmpWorkspace,
} from "./support.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const input = (flags: Record<string, unknown>): ForgeCommandInput =>
  ({ argv: [], flags }) as unknown as ForgeCommandInput;

describe("AC-2: missing checker → unavailable, non-zero exit", () => {
  it("configured tool whose executable is absent → unavailable + install hint, exit != 0", async () => {
    const { dir, cleanup } = tmpWorkspace("rfc1391-ac2-enoent-");
    cleanups.push(cleanup);
    put(dir, "forge.yaml", forgeYaml(TLC_MISSING_EXE_TOOLS));
    put(dir, "specs/claims.tla", "---- MODULE Claims ----\n====\n");
    put(dir, "specs/claims.proof.yaml", externalSpec({ tool: "tlc" }));

    const res = await runProofCheckCommand(
      input({ spec: "specs/claims.proof.yaml" }),
      ctx(dir),
    );

    expect(res.exitCode).not.toBe(0);
    expect(res.data?.status).toBe("fail");
    const v = res.data?.verdict;
    expect(v?.verdict).toBe("unavailable");
    // RFC failure mode: "exit 1 with the install hint from forge.yaml".
    expect(v?.message).toContain("brew install tlc2tools (fixture hint)");
    // No checker ran — observed version stays null per the contract.
    expect(v?.toolVersion).toBeNull();
  });

  it("tool absent from forge.yaml formal.tools → unavailable, exit != 0", async () => {
    const { dir, cleanup } = tmpWorkspace("rfc1391-ac2-undeclared-");
    cleanups.push(cleanup);
    put(dir, "forge.yaml", forgeYaml("formal:\n  tools: {}\n"));
    put(dir, "specs/claims.tla", "---- MODULE Claims ----\n====\n");
    put(dir, "specs/claims.proof.yaml", externalSpec({ tool: "tlc" }));

    const res = await runProofCheckCommand(
      input({ spec: "specs/claims.proof.yaml" }),
      ctx(dir),
    );

    expect(res.exitCode).not.toBe(0);
    const v = res.data?.verdict;
    expect(v?.verdict).toBe("unavailable");
    expect(v?.message).toContain("not declared in forge.yaml");
    expect(res.summary).toContain("unavailable");
  });

  it("unavailable is never reported as pass — command status stays fail", async () => {
    const { dir, cleanup } = tmpWorkspace("rfc1391-ac2-status-");
    cleanups.push(cleanup);
    put(dir, "forge.yaml", forgeYaml(TLC_MISSING_EXE_TOOLS));
    put(dir, "specs/claims.tla", "x\n");
    put(dir, "specs/claims.proof.yaml", externalSpec({ tool: "tlc" }));

    const res = await runProofCheckCommand(
      input({ spec: "specs/claims.proof.yaml" }),
      ctx(dir),
    );
    // Failing-closed contract: pass ⟺ proved only.
    expect(res.data?.status).toBe("fail");
    expect(res.exitCode === 0).toBe(false);
  });
});
