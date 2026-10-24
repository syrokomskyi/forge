/*
<MODULE_CONTRACT>
<purpose>
Independent acceptance-verifier check for RFC-1391 (cx1-emit-proof-envelope) — authored inside
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
  <item>RFC-1391 r1 verification: independent check cx1-emit-proof-envelope.</item>
  <item>RFC-1391: commit independent verifier checks + independent probes + round-1 pass report

Round-0 verdict counterexamples (CX-1: emit dead for proof-probe RFCs),
fixed in 1342fe21a; round-1 verdict pass — 47/47 checks, AC-1..AC-10 all
verified on the real implementation surface, non-vacuity re-verified by
mutation.</item>
</CHANGE_SUMMARY>
*/

// CX-1 counterexample candidate — RFC-1391's end-to-end evidence path:
// an RFC declaring `probe: proof` must be able to emit a verification
// envelope recording the checker's verdict, because the stamp's RFC-IMP-13
// gate reads exactly that envelope.
//
// This check asserts the CORRECT end-state through the REAL
// `runRfcVerificationEmit` handler on a real tmp git workspace (external
// checker stub via forge.yaml `formal.tools` — no vitest spawn needed).
// If the implementation is healthy it goes green; if the pre-probe freshness
// gate mis-handles the `proof` probe kind, it fails showing the actual
// skipped reason + blocking diagnostic.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { runRfcVerificationEmit } from "../../verification-evidence.ts";
import type { ForgeCommandInput } from "../../../../src/types.ts";
import {
  ctx,
  externalSpec,
  forgeYaml,
  git,
  put,
  rfcMd,
  tmpWorkspace,
  TLC_STUB_TOOLS,
} from "./support.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const input = (flags: Record<string, unknown>): ForgeCommandInput =>
  ({ argv: [], flags }) as unknown as ForgeCommandInput;

const RFC_ID = "RFC-9011";
const SPEC_REL = "specs/claims.proof.yaml";

describe("CX-1: rfc.verification.emit produces an envelope for a proof-probe RFC", () => {
  it("emitted envelope records the checker verdict for the proof probe", async () => {
    const { dir, cleanup } = tmpWorkspace("rfc1391-cx1-");
    cleanups.push(cleanup);
    git(dir, "init", "-q", "-b", "main");

    put(dir, "forge.yaml", forgeYaml(TLC_STUB_TOOLS));
    put(dir, "specs/claims.tla", "---- MODULE Claims ----\n====\n");
    put(dir, SPEC_REL, externalSpec({ id: "PROOF-cx1", toolVersion: "2.18" }));
    put(
      dir,
      "docs/rfcs/rfc-9011-proof-emit.md",
      rfcMd({
        id: RFC_ID,
        probesYaml: `  - probe: proof\n    criterion: AC-1\n    spec: "${SPEC_REL}"\n    expectationSource: self\n`,
        criteria: [
          "AC-1: WHEN the checker accepts the spec, THE command SHALL return proved (evidence: probe:AC-1)",
        ],
      }),
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `docs: ${RFC_ID} + proof spec`);

    const res = await runRfcVerificationEmit(input({ id: RFC_ID }), ctx(dir));

    // The RFC's contract: emit writes an envelope; the proof probe's verdict
    // lands in it. Anything else (skip, block, missing file) is the defect —
    // the actual outcome is embedded in the assertion messages for the report.
    const actual = JSON.stringify(
      {
        exitCode: res.exitCode,
        status: res.data?.status,
        emitted: res.data?.emitted,
        skipped: res.data?.skipped,
        diagnostics: res.data?.diagnostics,
      },
      null,
      2,
    );
    expect(res.exitCode, `emit outcome: ${actual}`).toBe(0);
    expect(res.data?.status, `emit outcome: ${actual}`).toBe("pass");
    expect(
      res.data?.emitted?.map((e) => e.rfcId),
      `emit outcome: ${actual}`,
    ).toContain(RFC_ID);
    expect(res.data?.skipped ?? [], `emit outcome: ${actual}`).toEqual([]);

    const envPath = join(dir, "docs/rfcs/verification/rfc-9011.generated.yaml");
    expect(existsSync(envPath)).toBe(true);
    const env = yamlParse(readFileSync(envPath, "utf8")) as {
      probes: Array<{
        ok: boolean;
        proof?: { verdict: string; tool: string; toolVersion: string };
      }>;
      overall: string;
    };
    expect(env.overall).toBe("pass");
    expect(env.probes[0]!.ok).toBe(true);
    expect(env.probes[0]!.proof).toMatchObject({
      verdict: "proved",
      tool: "tlc",
      toolVersion: "2.18",
    });
  });
});
