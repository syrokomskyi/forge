/*
<MODULE_CONTRACT>
<purpose>
Independent acceptance-verifier check for RFC-1391 (ac4-cardinality-mismatch-error) — authored inside
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
  <item>RFC-1391 r1 verification: independent check ac4-cardinality-mismatch-error.</item>
  <item>RFC-1391: commit independent verifier checks + independent probes + round-1 pass report

Round-0 verdict counterexamples (CX-1: emit dead for proof-probe RFCs),
fixed in 1342fe21a; round-1 verdict pass — 47/47 checks, AC-1..AC-10 all
verified on the real implementation surface, non-vacuity re-verified by
mutation.</item>
</CHANGE_SUMMARY>
*/

// RFC-1391 AC-4 — "IF the `exhaustive` runner enumerates a count different
// from `domain.cardinality`, THEN proof.check SHALL return verdict `error`."
// RFC design: "a domain silently shrunk by a refactor cannot pass."
//
// Independent check: REAL `runProofCheckCommand`/`runProofCheck` driving a REAL
// `pnpm exec vitest run` subprocess against verifier fixture entries, plus the
// injected-spawn seam executing the REAL `exhaustive()` report writer
// in-process for the refuted/counterexample branch.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runProofCheckCommand } from "../../../formal/handlers/proof-check.ts";
import {
  exhaustive,
  FORGE_PROOF_REPORT_ENV,
  runProofCheck,
  type SpawnFn,
} from "../../../../src/formal/index.ts";
import type { ForgeCommandInput } from "../../../../src/types.ts";
import { ctx, exhaustiveSpec, FORGE_ROOT, put, tmpWorkspace } from "./support.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const input = (flags: Record<string, unknown>): ForgeCommandInput =>
  ({ argv: [], flags }) as unknown as ForgeCommandInput;

const ENTRY = "os/rfc/verifier/rfc-1391/fixtures/small-domain.proof.test.ts"; // enumerates 3

function writeForgeSpec(rel: string, body: string): void {
  put(FORGE_ROOT, rel, body);
  cleanups.push(() => rmSync(join(FORGE_ROOT, rel), { force: true }));
}

describe("AC-4: enumerated count ≠ domain.cardinality → error", () => {
  it("entry enumerates 3 but the spec declares cardinality 4 → error, exit != 0 (real vitest)", async () => {
    const specRel = "os/rfc/verifier/rfc-1391/fixtures/proof-shrunk.proof.yaml";
    writeForgeSpec(
      specRel,
      exhaustiveSpec({ id: "PROOF-ac4-shrunk", entry: ENTRY, cardinality: 4 }),
    );

    const res = await runProofCheckCommand(input({ spec: specRel }), ctx(FORGE_ROOT));

    expect(res.exitCode).not.toBe(0);
    const v = res.data?.verdict;
    expect(v?.verdict).toBe("error");
    expect(v?.enumerated).toBe(3);
    expect(v?.message).toContain("cardinality 4");
    expect(v?.message).toContain("enumerated 3");
  }, 120_000);

  it("exhaustive spec without domain.cardinality → error", async () => {
    const { dir, cleanup } = tmpWorkspace("rfc1391-ac4-nodomain-");
    cleanups.push(cleanup);
    put(dir, "specs/domain.proof.test.ts", "// entry\n");
    put(dir, "specs/domain.proof.yaml", exhaustiveSpec({ id: "PROOF-ac4-nodomain", domain: null }));

    const res = await runProofCheckCommand(input({ spec: "specs/domain.proof.yaml" }), ctx(dir));
    expect(res.exitCode).not.toBe(0);
    expect(res.data?.verdict?.verdict).toBe("error");
    expect(res.data?.verdict?.message).toContain("domain.cardinality");
  });

  it("entry that produces no report → error (never a silent pass, real vitest)", async () => {
    const specRel = "os/rfc/verifier/rfc-1391/fixtures/proof-no-report.proof.yaml";
    writeForgeSpec(
      specRel,
      exhaustiveSpec({
        id: "PROOF-ac4-noreport",
        entry: "os/rfc/verifier/rfc-1391/fixtures/no-report.proof.test.ts",
        cardinality: 3,
      }),
    );

    const res = await runProofCheckCommand(input({ spec: specRel }), ctx(FORGE_ROOT));
    expect(res.exitCode).not.toBe(0);
    expect(res.data?.verdict?.verdict).toBe("error");
    expect(res.data?.verdict?.message).toContain("no readable report");
  }, 120_000);
});

describe("exhaustive verdict branches (real report writer via spawn seam)", () => {
  // Only the process boundary is stubbed: the REAL exhaustive() helper runs
  // in-process and writes the REAL FORGE_PROOF_REPORT payload the runner reads.
  const spawnWithRealExhaustive = (
    domain: string[],
    check: (i: string) => true | string,
  ): SpawnFn =>
    async (_argv, opts) => {
      const reportPath = opts.env?.[FORGE_PROOF_REPORT_ENV];
      if (reportPath) {
        process.env[FORGE_PROOF_REPORT_ENV] = reportPath;
        try {
          exhaustive(domain, check);
        } finally {
          delete process.env[FORGE_PROOF_REPORT_ENV];
        }
      }
      return { exitCode: 0, timedOut: false, spawnError: null, stdout: "", stderr: "" };
    };

  it("count mismatch via the real exhaustive report writer → error", async () => {
    const { dir, cleanup } = tmpWorkspace("rfc1391-ac4-inj-");
    cleanups.push(cleanup);
    put(dir, "specs/domain.proof.test.ts", "// entry\n");
    put(dir, "specs/domain.proof.yaml", exhaustiveSpec({ id: "PROOF-ac4-inj", cardinality: 5 }));

    const v = await runProofCheck({
      workspaceRoot: dir,
      specRelPath: "specs/domain.proof.yaml",
      spawnFn: spawnWithRealExhaustive(["a", "b", "c"], () => true),
    });
    expect(v.verdict).toBe("error");
    expect(v.enumerated).toBe(3);
    expect(v.message).toContain("cardinality 5");
  });

  it("matching count with violations → refuted + counterexample under .cache/proofs/", async () => {
    const { dir, cleanup } = tmpWorkspace("rfc1391-ac4-refuted-");
    cleanups.push(cleanup);
    put(dir, "specs/domain.proof.test.ts", "// entry\n");
    put(
      dir,
      "specs/domain.proof.yaml",
      exhaustiveSpec({ id: "PROOF-ac4-refuted", cardinality: 3 }),
    );

    const v = await runProofCheck({
      workspaceRoot: dir,
      specRelPath: "specs/domain.proof.yaml",
      spawnFn: spawnWithRealExhaustive(["a", "b", "c"], (i) =>
        i === "b" ? "predicate violated" : true,
      ),
    });
    expect(v.verdict).toBe("refuted");
    expect(v.enumerated).toBe(3);
    // RFC failure modes: "the counterexample path is printed and recorded".
    expect(v.counterexample).toBeDefined();
    expect(v.counterexample).toContain(".cache/proofs/");
    const cexPath = join(dir, v.counterexample!);
    expect(existsSync(cexPath)).toBe(true);
    const failures = JSON.parse(readFileSync(cexPath, "utf8")) as Array<{
      input: unknown;
      reason: string;
    }>;
    expect(failures.length).toBe(1);
    expect(failures[0]?.input).toBe("b");
    expect(failures[0]?.reason).toBe("predicate violated");
  });
});
