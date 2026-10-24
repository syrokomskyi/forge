/*
<MODULE_CONTRACT>
<purpose>
Independent acceptance-verifier check for RFC-1391 (origin-proof-spec-entry) — authored inside
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
  <item>RFC-1391 r1 verification: independent check origin-proof-spec-entry.</item>
  <item>RFC-1391: commit independent verifier checks + independent probes + round-1 pass report

Round-0 verdict counterexamples (CX-1: emit dead for proof-probe RFCs),
fixed in 1342fe21a; round-1 verdict pass — 47/47 checks, AC-1..AC-10 all
verified on the real implementation surface, non-vacuity re-verified by
mutation.</item>
</CHANGE_SUMMARY>
*/

// RFC-1391 design point (Verification envelope / origin derivation) —
// "deriveProbeOrigins gains a `proof` branch: the probe's `spec` and the
// spec's `entry` get the same `commitsTouching` analysis a `test` probe's
// `file` gets — implementer-authored specs derive `self`, verifier-trailer-
// committed specs derive `verifier`. Without it a `proof` probe falls
// through to `unchanged`, where `effective = declared` — an `independent`
// declaration on an implementer-authored spec would slip through unchecked."
//
// This is the load-bearing security property behind AC-6's RFC-IMP-11 gate:
// the origin of proof evidence must be git-derived, never trusted from the
// declared expectationSource alone.
//
// Independent check: the REAL `deriveProbeOrigins` + REAL
// `createProofEntryResolver` (spec.entry resolved out of the actual spec
// YAML) over REAL tmp git workspaces — the acceptance commit establishes the
// range base, post-acceptance commits touching spec/entry decide the
// derived origin.

import { afterEach, describe, expect, it } from "vitest";

import {
  createOriginGit,
  createProofEntryResolver,
  deriveProbeOrigins,
} from "../../verification-origin.ts";
import { parseRfcFile } from "../../frontmatter-io.ts";
import type { AcceptanceProbe } from "../../types.ts";
import { exhaustiveSpec, git, put, rfcMd, tmpWorkspace } from "./support.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const RFC_ID = "RFC-9012";
const RFC_REL = "docs/rfcs/rfc-9012-proof-origin.md";
const SPEC_REL = "specs/claims.proof.yaml";
const ENTRY_REL = "specs/claims.tla";

// The proof probe declares `independent` — the strongest claim. The check is
// whether git-derived origin honors or overrides that declaration.
const PROBES_YAML = `  - probe: proof
    criterion: AC-6
    spec: "${SPEC_REL}"
    expectationSource: independent
`;
const CRITERIA = [
  "AC-6: WHEN the checker accepts the spec, THE command SHALL return proved (evidence: probe:AC-6)",
];

function seedAcceptedRepo(): { dir: string; probe: AcceptanceProbe; frontmatter: Record<string, unknown> } {
  const { dir, cleanup } = tmpWorkspace("rfc1391-origin-");
  cleanups.push(cleanup);
  git(dir, "init", "-q", "-b", "main");

  put(dir, ENTRY_REL, "---- MODULE Claims ----\n====\n");
  put(dir, SPEC_REL, exhaustiveSpec({ id: "PROOF-origin", entry: ENTRY_REL, cardinality: 3 }));
  const rfcSource = rfcMd({
    id: RFC_ID,
    tier: "formal",
    status: "accepted",
    probesYaml: PROBES_YAML,
    criteria: CRITERIA,
  });
  put(dir, RFC_REL, rfcSource);
  git(dir, "add", "-A");
  // The acceptance transition — this commit becomes the origin range base.
  git(dir, "commit", "-qm", `docs: accept ${RFC_ID}`);

  const parsed = parseRfcFile(rfcSource);
  const probes = parsed.frontmatter["acceptance"] as AcceptanceProbe[];
  return { dir, probe: probes[0]!, frontmatter: parsed.frontmatter };
}

const origins = (dir: string, probe: AcceptanceProbe, frontmatter: Record<string, unknown>) =>
  deriveProbeOrigins({
    git: createOriginGit(dir),
    rfcRelPath: RFC_REL,
    frontmatter,
    probes: [probe],
    resolveProofEntry: createProofEntryResolver(dir),
  });

describe("proof-probe origin: spec/entry commit analysis (RFC-IMP-11 evidence source)", () => {
  it("implementer commit touching only the entry → derived self, effective self (declared independent NOT trusted)", async () => {
    const { dir, probe, frontmatter } = seedAcceptedRepo();
    put(dir, ENTRY_REL, "---- MODULE Claims ----\nEXTENDED\n====\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `implement: ${RFC_ID.toLowerCase()} entry tweak\n\nX-RFC: ${RFC_ID}`);

    const [rec] = await origins(dir, probe, frontmatter);
    expect(rec!.declared).toBe("independent");
    expect(rec!.derivedOrigin).toBe("self");
    // THE security property: declared independent cannot survive implementer
    // authorship of the proof bytes — effective must fall back to self.
    expect(rec!.effective).toBe("self");
    expect(rec!.reason.join(" ")).toContain("touched proof spec/entry");
  });

  it("implementer commit touching only the spec → derived self, effective self", async () => {
    const { dir, probe, frontmatter } = seedAcceptedRepo();
    put(
      dir,
      SPEC_REL,
      exhaustiveSpec({ id: "PROOF-origin", entry: ENTRY_REL, cardinality: 4 }),
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `implement: ${RFC_ID.toLowerCase()} spec tweak\n\nX-RFC: ${RFC_ID}`);

    const [rec] = await origins(dir, probe, frontmatter);
    expect(rec!.derivedOrigin).toBe("self");
    expect(rec!.effective).toBe("self");
  });

  it("verifier-trailer commit touching spec/entry → derived verifier, effective independent + report ref", async () => {
    const { dir, probe, frontmatter } = seedAcceptedRepo();
    put(dir, ENTRY_REL, "---- MODULE Claims ----\nVERIFIER HARDENED\n====\n");
    git(dir, "add", "-A");
    git(
      dir,
      "commit",
      "-qm",
      `verify: ${RFC_ID.toLowerCase()} independent proof hardening\n\nX-Expectation-Origin: independent-verifier\nX-Verifier-Report: docs/reviews/verifier-rfc-9012.md`,
    );

    const [rec] = await origins(dir, probe, frontmatter);
    expect(rec!.derivedOrigin).toBe("verifier");
    expect(rec!.effective).toBe("independent");
    expect(rec!.reason.join(" ")).toContain("docs/reviews/verifier-rfc-9012.md");
  });

  it("control: declaration unchanged since acceptance, no post-acceptance spec/entry commits → unchanged keeps declared", async () => {
    const { dir, probe, frontmatter } = seedAcceptedRepo();
    // An unrelated commit so HEAD != base but nothing touched spec/entry.
    put(dir, "docs/notes.md", "unrelated\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "docs: unrelated notes");

    const [rec] = await origins(dir, probe, frontmatter);
    expect(rec!.derivedOrigin).toBe("unchanged");
    // Same rule as `test` probes: unchanged → effective = declared.
    expect(rec!.effective).toBe("independent");
  });

  it("a non-presence execution probe: proof is NOT in the presence set (V-44)", async () => {
    const { isPresenceProbe } = await import("../../verification-origin.ts");
    const { dir, probe } = seedAcceptedRepo();
    void dir;
    expect(isPresenceProbe(probe)).toBe(false);
  });
});
