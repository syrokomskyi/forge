/*
<MODULE_CONTRACT>
<purpose>
Independent acceptance-verifier check for RFC-1391 (ac1-proved-exit-0) — authored inside
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
  <item>RFC-1391 r1 verification: independent check ac1-proved-exit-0.</item>
  <item>RFC-1391: commit independent verifier checks + independent probes + round-1 pass report

Round-0 verdict counterexamples (CX-1: emit dead for proof-probe RFCs),
fixed in 1342fe21a; round-1 verdict pass — 47/47 checks, AC-1..AC-10 all
verified on the real implementation surface, non-vacuity re-verified by
mutation.</item>
</CHANGE_SUMMARY>
*/

// RFC-1391 AC-1 — "WHEN proof.check runs a spec whose checker accepts the
// target at the pinned version, THE command SHALL return verdict `proved`
// with exit code 0."
//
// Independent check: the REAL command handler `runProofCheckCommand` and the
// shared REAL runner `runProofCheck`, exercised over two surfaces the RFC
// defines — (a) an external checker resolved from forge.yaml `formal.tools`
// (a `node -e` stub subprocess, real spawn, real version-pin evaluation) and
// (b) the built-in `exhaustive` tool end-to-end through a REAL nested
// `pnpm exec vitest run` subprocess that executes a verifier-authored
// *.proof.test.ts entry and writes the real FORGE_PROOF_REPORT file.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runProofCheckCommand } from "../../../formal/handlers/proof-check.ts";
import { runProofCheck, EXHAUSTIVE_TOOL_VERSION } from "../../../../src/formal/index.ts";
import type { ForgeCommandInput } from "../../../../src/types.ts";
import {
  ctx,
  exhaustiveSpec,
  externalSpec,
  FORGE_ROOT,
  forgeYaml,
  put,
  TLC_STUB_TOOLS,
  tmpWorkspace,
} from "./support.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function input(flags: Record<string, unknown>): ForgeCommandInput {
  return { argv: [], flags } as unknown as ForgeCommandInput;
}

describe("AC-1: proved verdict → exit code 0", () => {
  it("external checker stub accepted at the pinned version → proved, exit 0", async () => {
    const { dir, cleanup } = tmpWorkspace("rfc1391-ac1-ext-");
    cleanups.push(cleanup);
    put(dir, "forge.yaml", forgeYaml(TLC_STUB_TOOLS));
    put(dir, "specs/claims.tla", "---- MODULE Claims ----\n====\n");
    put(dir, "specs/claims.proof.yaml", externalSpec({ toolVersion: "2.18" }));

    const res = await runProofCheckCommand(input({ spec: "specs/claims.proof.yaml" }), ctx(dir));

    expect(res.exitCode).toBe(0);
    expect(res.data?.status).toBe("pass");
    expect(res.data?.spec).toBe("specs/claims.proof.yaml");
    const v = res.data?.verdict;
    expect(v?.verdict).toBe("proved");
    // Version-pin evidence: the observed version is recorded and bound.
    expect(v?.tool).toBe("tlc");
    expect(v?.toolVersion).toBe("2.18");
    // Evidence binds to bytes: both shas present per the RFC contract.
    expect(v?.specSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v?.entrySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v?.specId).toBe("PROOF-verify-external");
  });

  it("exhaustive runner proves a matching domain end-to-end (real vitest subprocess)", async () => {
    // workspaceRoot = packages/forge so `pnpm exec vitest run <entry>` spawns
    // against the real include set; entry is the verifier fixture enumerating 3.
    const specRel = "os/rfc/verifier/rfc-1391/fixtures/proof-small-domain.proof.yaml";
    put(
      FORGE_ROOT,
      specRel,
      exhaustiveSpec({
        id: "PROOF-ac1-small-domain",
        entry: "os/rfc/verifier/rfc-1391/fixtures/small-domain.proof.test.ts",
        cardinality: 3,
      }),
    );
    cleanups.push(() => {
      try {
        rmSync(join(FORGE_ROOT, specRel), { force: true });
      } catch {
        /* best effort */
      }
    });

    const res = await runProofCheckCommand(input({ spec: specRel }), ctx(FORGE_ROOT));

    expect(res.exitCode).toBe(0);
    const v = res.data?.verdict;
    expect(v?.verdict).toBe("proved");
    expect(v?.tool).toBe("exhaustive");
    expect(v?.toolVersion).toBe(EXHAUSTIVE_TOOL_VERSION);
    expect(v?.enumerated).toBe(3);
    // The real report file was produced under .cache/proofs/.
    const report = join(FORGE_ROOT, ".cache", "proofs", "PROOF-ac1-small-domain.report.json");
    expect(existsSync(report)).toBe(true);
    const parsed = JSON.parse(readFileSync(report, "utf8")) as {
      enumerated: number;
      failures: unknown[];
    };
    expect(parsed.enumerated).toBe(3);
    expect(parsed.failures).toEqual([]);
  }, 120_000);

  it("shared runner returns the same proved verdict shape for the exhaustive path", async () => {
    const specRel = "os/rfc/verifier/rfc-1391/fixtures/proof-small-domain-2.proof.yaml";
    put(
      FORGE_ROOT,
      specRel,
      exhaustiveSpec({
        id: "PROOF-ac1-small-domain-2",
        entry: "os/rfc/verifier/rfc-1391/fixtures/small-domain.proof.test.ts",
        cardinality: 3,
      }),
    );
    cleanups.push(() => {
      try {
        rmSync(join(FORGE_ROOT, specRel), { force: true });
      } catch {
        /* best effort */
      }
    });
    const v = await runProofCheck({ workspaceRoot: FORGE_ROOT, specRelPath: specRel });
    expect(v.verdict).toBe("proved");
    expect(v.enumerated).toBe(3);
    expect(v.entrySha256).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);
});
