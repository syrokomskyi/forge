/*
<MODULE_CONTRACT>
<purpose>
Independent acceptance-verifier check for RFC-1391 (ac6-formal-high-tier-gates) — authored inside
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
  <item>RFC-1391 r1 verification: independent check ac6-formal-high-tier-gates.</item>
  <item>RFC-1391: commit independent verifier checks + independent probes + round-1 pass report

Round-0 verdict counterexamples (CX-1: emit dead for proof-probe RFCs),
fixed in 1342fe21a; round-1 verdict pass — 47/47 checks, AC-1..AC-10 all
verified on the real implementation surface, non-vacuity re-verified by
mutation.</item>
</CHANGE_SUMMARY>
*/

// RFC-1391 AC-6 — "WHEN rfc.implement.stamp evaluates a `verificationTier:
// formal` RFC, THE stamp SHALL apply RFC-IMP-11 and RFC-IMP-12."
// RFC design: "Formal ⊇ high: RFC-IMP-11 and RFC-IMP-12 apply to both tiers"
// — a formal-tier RFC is never verified less strictly than a high-tier RFC.
//
// Independent check: REAL `runRfcImplementStamp` over a tmp git workspace — a
// formal-tier RFC with a `proved` proof envelope (so RFC-IMP-13 is silent)
// still blocks on RFC-IMP-11 (self-only evidence for WHEN criteria) and
// RFC-IMP-12 (no bound acceptance report). Unit checks pin both gate
// evaluators on the `formal` tier and the negative control on `standard`.

import { stringify as yamlStringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { runRfcImplementStamp } from "../../handlers/implement-stamp.ts";
import {
  evaluateAcceptanceVerificationGate,
  evaluateOriginGates,
} from "../../handlers/implement-stamp-origin.ts";
import { byteHashHex, normalizeProbes } from "../../verification-evidence.ts";
import { parseRfcFile } from "../../frontmatter-io.ts";
import type { AcceptanceProbe } from "../../types.ts";
import type { ForgeCommandInput } from "../../../../src/types.ts";
import { ctx, exhaustiveSpec, git, put, rfcMd, tmpWorkspace } from "./support.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const input = (flags: Record<string, unknown>): ForgeCommandInput =>
  ({ argv: [], flags }) as unknown as ForgeCommandInput;

const RFC_ID = "RFC-9008";
const SPEC_REL = "specs/claims.proof.yaml";
const PROOF_PROBE = `  - probe: proof
    criterion: AC-1
    spec: "${SPEC_REL}"
    expectationSource: self
`;
const CRITERIA = [
  "AC-1: WHEN the checker accepts the spec, THE command SHALL return proved (evidence: probe:AC-1)",
];

describe("AC-6: rfc.implement.stamp applies RFC-IMP-11 and RFC-IMP-12 to formal tier", () => {
  it("formal RFC with proved envelope still blocks on IMP-11 + IMP-12 (end-to-end)", async () => {
    const { dir, cleanup } = tmpWorkspace("rfc1391-ac6-");
    cleanups.push(cleanup);
    git(dir, "init", "-q", "-b", "main");

    put(dir, "specs/claims.tla", "---- MODULE Claims ----\n====\n");
    put(
      dir,
      SPEC_REL,
      exhaustiveSpec({ id: "PROOF-ac6", entry: "specs/claims.tla", cardinality: 3 }),
    );
    const rfcSource = rfcMd({
      id: RFC_ID,
      tier: "formal",
      probesYaml: PROOF_PROBE,
      criteria: CRITERIA,
    });
    put(dir, "docs/rfcs/rfc-9008-formal.md", rfcSource);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `docs: accept ${RFC_ID}`);
    git(
      dir,
      "commit",
      "-qm",
      `implement: ${RFC_ID.toLowerCase()}\n\nX-RFC: ${RFC_ID}`,
      "--allow-empty",
    );

    // Envelope recording the proved proof verdict — the strongest possible
    // evidence position a formal RFC can hold; IMP-11/12 must still apply.
    const parsed = parseRfcFile(rfcSource);
    const probes = parsed.frontmatter["acceptance"] as AcceptanceProbe[];
    const envelope = {
      rfcId: RFC_ID,
      title: `${RFC_ID} verifier fixture`,
      rfcStatus: "accepted",
      emittedAt: "2026-10-24T00:00:00.000Z",
      commit: "fixture",
      workingTreeDirty: false,
      kernelVersion: "0",
      rfcFileHash: byteHashHex(rfcSource),
      acceptanceHash: byteHashHex(normalizeProbes(probes)),
      probes: [
        {
          probe: probes[0],
          ok: true,
          detail: "proved",
          durationMs: 1,
          proof: {
            tool: "tlc",
            toolVersion: "2.18",
            verdict: "proved",
            specSha256: "a".repeat(64),
            entrySha256: "b".repeat(64),
          },
        },
      ],
      overall: "pass",
    };
    put(dir, "docs/rfcs/verification/rfc-9008.generated.yaml", yamlStringify(envelope));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `docs: ${RFC_ID} evidence envelope`);

    const implSha = git(dir, "log", "--format=%H", "--grep=implement:", "-1");
    const res = await runRfcImplementStamp(
      input({ id: RFC_ID, "implementation-commit": implSha }),
      ctx(dir),
    );

    const ruleList = (res.data?.violations ?? []).map((v) => v.rule);
    expect(res.exitCode).not.toBe(0);
    // THE acceptance criterion: both high-tier gates fire on the formal tier.
    expect(ruleList).toContain("RFC-IMP-11");
    expect(ruleList).toContain("RFC-IMP-12");
    // Sanity for the fixture's evidence position: the proof gate is satisfied.
    expect(ruleList).not.toContain("RFC-IMP-13");
    expect(ruleList).not.toContain("RFC-IMP-06");
    expect(ruleList).not.toContain("RFC-IMP-09");
  });
});

describe("AC-6 unit: tier set {high, formal} for both evaluators", () => {
  const body = `## Acceptance criteria\n\n- [x] AC-1: WHEN x happens, THE thing SHALL respond (evidence: probe:AC-1)\n`;
  const probe = {
    probe: "test",
    file: "x.test.ts",
    expect: { exitCode: 0 },
    criterion: "AC-1",
  } as AcceptanceProbe;
  const selfOrigin = {
    declared: "self" as const,
    derivedOrigin: "self" as const,
    effective: "self" as const,
    reason: [],
  };

  it("evaluateOriginGates fires RFC-IMP-11 for formal tier, not for standard", () => {
    const formal = evaluateOriginGates({
      targetId: RFC_ID,
      frontmatter: { createdAt: "2026-10-24", verificationTier: "formal" },
      body,
      probes: [probe],
      origins: [selfOrigin],
    });
    expect(formal.errors.map((e) => e.rule)).toEqual(["RFC-IMP-11"]);

    const standard = evaluateOriginGates({
      targetId: RFC_ID,
      frontmatter: { createdAt: "2026-10-24", verificationTier: "standard" },
      body,
      probes: [probe],
      origins: [selfOrigin],
    });
    expect(standard.errors).toEqual([]);
  });

  it("evaluateAcceptanceVerificationGate fires RFC-IMP-12 for formal tier, not for standard", async () => {
    const formal = await evaluateAcceptanceVerificationGate({
      targetId: RFC_ID,
      frontmatter: { createdAt: "2026-10-24", verificationTier: "formal" },
      reports: [],
      isCandidateBound: async () => true,
    });
    expect(formal.errors.map((e) => e.rule)).toEqual(["RFC-IMP-12"]);

    const standard = await evaluateAcceptanceVerificationGate({
      targetId: RFC_ID,
      frontmatter: { createdAt: "2026-10-24", verificationTier: "standard" },
      reports: [],
      isCandidateBound: async () => true,
    });
    expect(standard.errors).toEqual([]);
  });
});
