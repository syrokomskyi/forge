/*
<MODULE_CONTRACT>
<purpose>
Independent acceptance-verifier check for RFC-1391 (ac5-imp13-formal-stamp-block) — authored inside
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
  <item>RFC-1391 r1 verification: independent check ac5-imp13-formal-stamp-block.</item>
  <item>RFC-1391: commit independent verifier checks + independent probes + round-1 pass report

Round-0 verdict counterexamples (CX-1: emit dead for proof-probe RFCs),
fixed in 1342fe21a; round-1 verdict pass — 47/47 checks, AC-1..AC-10 all
verified on the real implementation surface, non-vacuity re-verified by
mutation.</item>
</CHANGE_SUMMARY>
*/

// RFC-1391 AC-5 — "IF a `verificationTier: formal` RFC has no `proof` probe
// with envelope verdict `proved`, THEN rfc.implement.stamp SHALL block with
// RFC-IMP-13." RFC design: "`unavailable` never counts as passing. There is no
// waiver flag for RFC-IMP-13."
//
// Independent check: the REAL `runRfcImplementStamp` handler over a real tmp
// git workspace — committed RFC file, implementation commit with X-RFC trailer,
// verification envelope fixtures written to the committed location the gate
// reads. A control case (proved envelope → no RFC-IMP-13) keeps the check
// honest, and direct `evaluateFormalProofGate` unit checks cover the verdict
// matrix including `unavailable` and `error`.

import { stringify as yamlStringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { runRfcImplementStamp } from "../../handlers/implement-stamp.ts";
import { evaluateFormalProofGate } from "../../handlers/implement-stamp-origin.ts";
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

const RFC_ID = "RFC-9007";
const SPEC_REL = "specs/claims.proof.yaml";

const PROOF_PROBE = `  - probe: proof
    criterion: AC-1
    spec: "${SPEC_REL}"
    expectationSource: self
`;
const FILE_PROBE = `  - probe: file-exists
    path: "specs/claims.tla"
    criterion: AC-1
    expectationSource: self
`;

const CRITERIA = [
  "AC-1: WHEN the checker accepts the spec, THE command SHALL return proved (evidence: probe:AC-1)",
];

/**
 * Build a stampable fixture repo: RFC committed as accepted, an implementation
 * commit carrying governance provenance, and (optionally) a verification
 * envelope at docs/rfcs/verification/<id>.generated.yaml recording `verdict`
 * for the proof probe. Envelope hashes are computed with the real emit helpers.
 */
async function stampFixture(opts: {
  tier: string;
  probesYaml: string;
  verdict?: "proved" | "refuted" | "unavailable" | "error";
  envelopeOverall?: "pass" | "fail";
}) {
  const { dir, cleanup } = tmpWorkspace("rfc1391-ac5-");
  cleanups.push(cleanup);
  git(dir, "init", "-q", "-b", "main");

  put(dir, "specs/claims.tla", "---- MODULE Claims ----\n====\n");
  put(
    dir,
    SPEC_REL,
    exhaustiveSpec({ id: "PROOF-ac5", entry: "specs/claims.tla", cardinality: 3 }),
  );
  const rfcSource = rfcMd({
    id: RFC_ID,
    tier: opts.tier,
    probesYaml: opts.probesYaml,
    criteria: CRITERIA,
  });
  put(dir, "docs/rfcs/rfc-9007-formal.md", rfcSource);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", `docs: accept ${RFC_ID}`);
  git(
    dir,
    "commit",
    "-qm",
    `implement: ${RFC_ID.toLowerCase()} formal gate\n\nX-RFC: ${RFC_ID}`,
    "--allow-empty",
  );

  if (opts.verdict !== undefined) {
    const parsed = parseRfcFile(rfcSource);
    const probes = parsed.frontmatter["acceptance"] as AcceptanceProbe[];
    const ok = opts.verdict === "proved";
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
          ok,
          detail: `fixture ${opts.verdict}`,
          durationMs: 1,
          proof: {
            tool: "tlc",
            toolVersion: "2.18",
            verdict: opts.verdict,
            specSha256: "a".repeat(64),
            entrySha256: "b".repeat(64),
          },
        },
      ],
      overall: opts.envelopeOverall ?? (ok ? "pass" : "fail"),
    };
    put(dir, "docs/rfcs/verification/rfc-9007.generated.yaml", yamlStringify(envelope));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `docs: ${RFC_ID} evidence envelope`);
  }

  const implSha = git(dir, "log", "--format=%H", "--grep=implement:", "-1");
  return { dir, implSha };
}

const rules = (r: Awaited<ReturnType<typeof runRfcImplementStamp>>) =>
  (r.data?.violations ?? []).map((v) => v.rule);
const messages = (r: Awaited<ReturnType<typeof runRfcImplementStamp>>) => r.data?.violations ?? [];

describe("AC-5: formal tier without proved proof evidence → RFC-IMP-13", () => {
  it("formal RFC declaring zero proof probes → blocked with RFC-IMP-13", async () => {
    const { dir, implSha } = await stampFixture({ tier: "formal", probesYaml: FILE_PROBE });
    const res = await runRfcImplementStamp(
      input({ id: RFC_ID, "implementation-commit": implSha }),
      ctx(dir),
    );
    expect(res.exitCode).not.toBe(0);
    expect(rules(res)).toContain("RFC-IMP-13");
    const v = messages(res).find((x) => x.rule === "RFC-IMP-13")!;
    expect(v.message).toContain("formal");
  });

  it("formal RFC with a proof probe but NO envelope → RFC-IMP-13 (verdict missing)", async () => {
    const { dir, implSha } = await stampFixture({ tier: "formal", probesYaml: PROOF_PROBE });
    const res = await runRfcImplementStamp(
      input({ id: RFC_ID, "implementation-commit": implSha }),
      ctx(dir),
    );
    expect(res.exitCode).not.toBe(0);
    expect(rules(res)).toContain("RFC-IMP-13");
    const v = messages(res).find((x) => x.rule === "RFC-IMP-13")!;
    expect(v.message).toContain("missing");
  });

  it("formal RFC whose envelope records verdict `refuted` → RFC-IMP-13", async () => {
    const { dir, implSha } = await stampFixture({
      tier: "formal",
      probesYaml: PROOF_PROBE,
      verdict: "refuted",
    });
    const res = await runRfcImplementStamp(
      input({ id: RFC_ID, "implementation-commit": implSha }),
      ctx(dir),
    );
    expect(res.exitCode).not.toBe(0);
    expect(rules(res)).toContain("RFC-IMP-13");
    const v = messages(res).find((x) => x.rule === "RFC-IMP-13")!;
    expect(v.message).toContain("refuted");
  });

  it("formal RFC whose envelope records verdict `unavailable` → RFC-IMP-13 (unavailable never passes)", async () => {
    const { dir, implSha } = await stampFixture({
      tier: "formal",
      probesYaml: PROOF_PROBE,
      verdict: "unavailable",
    });
    const res = await runRfcImplementStamp(
      input({ id: RFC_ID, "implementation-commit": implSha }),
      ctx(dir),
    );
    expect(rules(res)).toContain("RFC-IMP-13");
  });

  it("control: proved envelope → no RFC-IMP-13 (and stamp is NOT blocked by it)", async () => {
    const { dir, implSha } = await stampFixture({
      tier: "formal",
      probesYaml: PROOF_PROBE,
      verdict: "proved",
    });
    const res = await runRfcImplementStamp(
      input({ id: RFC_ID, "implementation-commit": implSha }),
      ctx(dir),
    );
    expect(rules(res)).not.toContain("RFC-IMP-13");
  });

  it("control: high-tier RFC with the same missing evidence → NO RFC-IMP-13 (gate is formal-bound)", async () => {
    const { dir, implSha } = await stampFixture({ tier: "high", probesYaml: FILE_PROBE });
    const res = await runRfcImplementStamp(
      input({ id: RFC_ID, "implementation-commit": implSha }),
      ctx(dir),
    );
    expect(rules(res)).not.toContain("RFC-IMP-13");
  });
});

describe("AC-5 unit: evaluateFormalProofGate verdict matrix", () => {
  const fm = { verificationTier: "formal", createdAt: "2026-10-24" };
  const probe = { probe: "proof", spec: SPEC_REL, criterion: "AC-1" } as AcceptanceProbe;
  const record = (verdict: string) => ({
    probe,
    ok: verdict === "proved",
    detail: "",
    durationMs: 0,
    proof: {
      tool: "tlc",
      toolVersion: "2.18",
      verdict: verdict as "proved" | "refuted" | "unavailable" | "error",
      specSha256: "a".repeat(64),
      entrySha256: "b".repeat(64),
    },
  });

  it("zero proof probes → RFC-IMP-13", () => {
    const r = evaluateFormalProofGate({
      targetId: RFC_ID,
      frontmatter: fm,
      probes: [{ probe: "file-exists", path: "x", criterion: "AC-1" } as AcceptanceProbe],
      evidenceRecords: [],
    });
    expect(r.errors.map((e) => e.rule)).toEqual(["RFC-IMP-13"]);
  });

  it.each(["refuted", "unavailable", "error"] as const)(
    "envelope verdict `%s` → RFC-IMP-13",
    (verdict) => {
      const r = evaluateFormalProofGate({
        targetId: RFC_ID,
        frontmatter: fm,
        probes: [probe],
        evidenceRecords: [record(verdict)],
      });
      expect(r.errors.map((e) => e.rule)).toEqual(["RFC-IMP-13"]);
    },
  );

  it("proved verdict → clean", () => {
    const r = evaluateFormalProofGate({
      targetId: RFC_ID,
      frontmatter: fm,
      probes: [probe],
      evidenceRecords: [record("proved")],
    });
    expect(r.errors).toEqual([]);
  });

  it("non-formal tiers never fire the gate", () => {
    for (const tier of ["high", "standard"]) {
      const r = evaluateFormalProofGate({
        targetId: RFC_ID,
        frontmatter: { ...fm, verificationTier: tier },
        probes: [probe],
        evidenceRecords: [record("refuted")],
      });
      expect(r.errors).toEqual([]);
    }
  });
});
