/*
<MODULE_CONTRACT>
<purpose>
RFC-1391: unit surface for the built-in `exhaustive` runner — full enumeration,
refutation with counterexamples, refusal of sampled/async/non-deterministic
domains, FORGE_PROOF_REPORT mode, and the cardinality count gate (AC-4).
</purpose>
<non-goals>
  <item>Do not cover CLI verdicts/exit codes — os/formal proof-check tests own AC-1..AC-3.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1391: exhaustive runner tests incl. AC-4 cardinality-mismatch error surface.</item>
  <item>RFC-1391: make the formal verification tier checker-bound (RFC-1391)</item>
</CHANGE_SUMMARY>
*/

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exhaustive,
  ExhaustiveDomainError,
  ExhaustiveRefutedError,
  exhaustiveVerdict,
  FORGE_PROOF_REPORT_ENV,
} from "./exhaustive.ts";

const savedReportEnv = process.env[FORGE_PROOF_REPORT_ENV];
const tmpRoots: string[] = [];

afterEach(() => {
  if (savedReportEnv === undefined) delete process.env[FORGE_PROOF_REPORT_ENV];
  else process.env[FORGE_PROOF_REPORT_ENV] = savedReportEnv;
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe("exhaustive (RFC-1391)", () => {
  it("enumerates every input and returns the full count", () => {
    const seen: number[] = [];
    const result = exhaustive([1, 2, 3, 4], (n) => {
      seen.push(n);
      return n < 10 ? true : "too big";
    });
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(result.enumerated).toBe(4);
    expect(result.failures).toEqual([]);
  });

  it("throws ExhaustiveRefutedError with the counterexample under vitest", () => {
    let err: unknown;
    try {
      exhaustive([1, 2, 3], (n) => (n !== 2 ? true : "two is excluded"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExhaustiveRefutedError);
    const refuted = err as ExhaustiveRefutedError;
    expect(refuted.failures).toEqual([{ input: 2, reason: "two is excluded" }]);
    expect(refuted.message).toContain("1/3");
  });

  it("rejects a fast-check-shaped arbitrary — sampling is not exhaustive", () => {
    const arbitrary = { generate: () => ({}), map: () => arbitrary, filter: () => arbitrary };
    expect(() => exhaustive(arbitrary as never, () => true)).toThrow(ExhaustiveDomainError);
  });

  it("rejects non-iterables and async iterables", () => {
    expect(() => exhaustive(42 as never, () => true)).toThrow(ExhaustiveDomainError);
    const asyncDomain = {
      async *[Symbol.asyncIterator]() {
        yield 1;
      },
    };
    expect(() => exhaustive(asyncDomain as never, () => true)).toThrow(ExhaustiveDomainError);
  });

  it("rejects a one-shot iterable — second enumeration cannot reproduce the domain", () => {
    function* once() {
      yield 1;
      yield 2;
    }
    expect(() => exhaustive(once(), () => true)).toThrow(ExhaustiveDomainError);
    expect(() => exhaustive(once(), () => true)).toThrow(/re-enumeration yielded 0/);
  });

  it("reports error when the enumerated count differs from the declared cardinality", () => {
    const result = { enumerated: 4, failures: [] };
    const verdict = exhaustiveVerdict(result, 5);
    expect(verdict.verdict).toBe("error");
    expect(verdict.message).toContain("cardinality 5");
  });

  it("reports refuted when failures exist and proved when clean at the right count", () => {
    expect(
      exhaustiveVerdict({ enumerated: 2, failures: [{ input: "x", reason: "bad" }] }, 2).verdict,
    ).toBe("refuted");
    expect(exhaustiveVerdict({ enumerated: 2, failures: [] }, 2).verdict).toBe("proved");
  });

  it("writes {enumerated, failures} to FORGE_PROOF_REPORT without throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-exhaustive-"));
    tmpRoots.push(root);
    const reportPath = join(root, "nested", "report.json");
    process.env[FORGE_PROOF_REPORT_ENV] = reportPath;

    const result = exhaustive([1, 2], (n) => (n === 2 ? "two fails" : true));
    expect(result.failures).toHaveLength(1);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      enumerated: number;
      failures: { input: number; reason: string }[];
    };
    expect(report.enumerated).toBe(2);
    expect(report.failures).toEqual([{ input: 2, reason: "two fails" }]);
  });
});
