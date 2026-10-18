// RFC-1333 AC-3, AC-4, AC-7, AC-8, AC-9.
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { RFC_IMP_11_BLOCKING } from "../../handlers/implement-stamp-origin.ts";
import type { AcceptanceVerificationReport } from "../../types.ts";

const review = readFileSync(
  new URL("../../../../skills/fo/fo-review/SKILL.md", import.meta.url),
  "utf8",
);
const impl = readFileSync(
  new URL("../../../../skills/fo/fo-idea-implement/SKILL.md", import.meta.url),
  "utf8",
);
const section = review.split(/^## Acceptance verification mode\s*$/m)[1]?.split(/^## /m)[0] ?? "";

describe("RFC-1333 skills/types", () => {
  it("AC-3: fo-review acceptance section covers inputs, minimization, isolation", () => {
    expect(section).not.toBe("");
    expect(section).toMatch(/Inputs/);
    expect(section).toMatch(/[Mm]inimi/);
    expect(section).toMatch(/isolation/);
  });
  it("AC-9: at most two fix rounds, then park", () => {
    expect(section).toMatch(/at most two fix rounds/);
    expect(section).toMatch(/park/);
  });
  it("AC-4: step 4.4b gated on verificationTier: high", () => {
    const step =
      impl.split(/^#### 4\.4b\. Independent acceptance verification/m)[1]?.split(/^#{2,4} /m)[0] ??
      "";
    expect(step).not.toBe("");
    expect(step).toMatch(/verificationTier: high/);
  });
  it("AC-7: RFC-IMP-11 blocking", () => {
    expect(RFC_IMP_11_BLOCKING).toBe(true);
  });
  it("AC-8: report type fields", () => {
    expectTypeOf<AcceptanceVerificationReport>()
      .toHaveProperty("candidateSha")
      .toEqualTypeOf<string>();
    expectTypeOf<AcceptanceVerificationReport>().toHaveProperty("round").toEqualTypeOf<0 | 1 | 2>();
    expectTypeOf<AcceptanceVerificationReport>().toHaveProperty("isolation");
    expectTypeOf<AcceptanceVerificationReport>()
      .toHaveProperty("verifierModel")
      .toEqualTypeOf<string | null>();
    expectTypeOf<AcceptanceVerificationReport>().toHaveProperty("verdict");
    expectTypeOf<AcceptanceVerificationReport>().toHaveProperty("counterexamples");
  });
});
