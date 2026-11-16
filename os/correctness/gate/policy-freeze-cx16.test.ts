/*
<MODULE_CONTRACT>
<purpose>RFC-1615 round-15 adversarial verification probes (CX-86..CX-109):
base-anchored governing-reference resolution (CX-82/CX-83) and the judged
`bindings.paths.compassDocs` / live `paths.rfcsDir` keys. Each probe reproduces
one attack against `correctness.gate` and asserts the fail-closed verdict.</purpose>
<non-goals>
  <item>Not a contract source of truth — gate/run.ts owns behaviour.</item>
  <item>Never modifies gate source; fixtures are hermetic temp git repos.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { afterEach, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runCorrectnessGate } from "./run.ts";
import {
  ORACLE_PATH,
  makeGateFixture,
  manifestYaml,
  type GateFixture,
} from "./tests/gate-fixture.ts";
import { resolveRfcRef, resolveRfcRefContent } from "../references.ts";

const fixtures: GateFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const fx = (o: Parameters<typeof makeGateFixture>[0] = {}) => {
  const f = makeGateFixture(o);
  fixtures.push(f);
  return f;
};

interface GateRun {
  status: string;
  acceptedWeakening: string | null;
  messages: string[];
  weakenings: { kind: string; message: string }[];
  unreadableReads?: string[];
}
const gate = async (
  f: GateFixture,
  opts: { base?: string; acceptWeakening?: string; policyOnly?: boolean } = {},
): Promise<GateRun> => {
  const out = await runCorrectnessGate(f.root, {
    base: opts.base ?? f.base,
    bundleDir: `${f.root}/.bundles`,
    acceptWeakening: opts.acceptWeakening,
    policyOnly: opts.policyOnly,
  });
  if (!out.ok) throw new Error(out.usageError);
  return {
    status: out.result.status,
    acceptedWeakening: out.result.acceptedWeakening,
    messages: out.result.violations.map((v) => v.message),
    weakenings: out.result.weakenings,
    unreadableReads: out.bundle.unreadableReads,
  };
};

/** Overwrite the loose object of `rel` at `rev` with garbage — `ls-tree` still resolves the sha, `git show` fails. */
const corruptBaseBlob = (f: GateFixture, rel: string, rev = f.base) => {
  const sha = f.git(["rev-parse", `${rev}:${rel}`]);
  const objPath = path.join(f.root, ".git", "objects", sha.slice(0, 2), sha.slice(2));
  rmSync(objPath); // loose objects are written 0444 — replace, don't overwrite
  writeFileSync(objPath, "not-zlib");
};

const RFC_BODY = `---
id: RFC-0100
status: accepted
---

# RFC-0100 — governing

## Acceptance criteria

- [x] AC-1: the dispatch oracle holds (evidence: verified run)
`;
const EVIL_RFC_BODY = `---
id: RFC-0100
status: accepted
---

## Acceptance criteria

- [x] AC-99: fabricated criterion (evidence: none)
`;

const rfcAcEntry = (id: string, ref: string, check = ORACLE_PATH) =>
  `  - id: ${id}\n    source: rfc-ac\n    ref: ${ref}\n    seam: data\n    anchors: [INV-dispatch-01]\n    oracles:\n      - check: test:${check}\n        substrate: L1\n`;
const reqEntry = (id: string, ref: string, check = ORACLE_PATH) =>
  `  - id: ${id}\n    source: req\n    ref: ${ref}\n    seam: data\n    anchors: [INV-dispatch-01]\n    oracles:\n      - check: test:${check}\n        substrate: L1\n`;
const dnaEntry = (id: string, ref: string, check = ORACLE_PATH) =>
  `  - id: ${id}\n    source: dna\n    ref: ${ref}\n    seam: data\n    anchors: [INV-dispatch-01]\n    oracles:\n      - check: test:${check}\n        substrate: L1\n`;

const REQUIREMENTS_TWO = `<requirements>\n  <meta><document-id>requirements</document-id></meta>\n  <requirement id="REQ-01">Never two openers</requirement>\n  <requirement id="REQ-02">Never three openers</requirement>\n</requirements>\n`;
const NOTES_DOC = `<doc><meta><document-id>notes</document-id></meta></doc>\n`;
const EVIL_REQUIREMENTS = `<requirements>\n  <meta><document-id>requirements</document-id></meta>\n  <requirement id="REQ-99">planted</requirement>\n</requirements>\n`;
const INVARIANTS = `# Invariants\n\n## DNA-7 — never two openers\n`;
const INVARIANTS_EVIL = `# Invariants\n\n## DNA-7 — never two openers\n\n## DNA-99 — planted\n`;

const REQUIREMENTS_NO_IDS = `<requirements>\n  <meta><document-id>requirements</document-id></meta>\n</requirements>\n`;
/** Full manifest whose only entry is one rfc-ac oracle — for requirement-origin controls without a review record. */
const rfcOnlyManifest = (ref: string) =>
  `schema: forge/correctness-manifest@1\nentries:\n${rfcAcEntry("CM-dispatch-01", ref)}support: []\nexemptions: []\n`;

const forgeYaml = (o: {
  mode?: string;
  commands?: string;
  bindingsPaths?: string;
  topPaths?: string;
}) => `schema: forge/config@1
project:
  name: gate-fixture
paths: ${o.topPaths ?? "{}"}
bindings:
  schema: forge/bindings@1
  commands:
${o.commands ?? `    checkRun: "node {file}"\n    verify: "node scripts/verify.mjs"`}
  paths:
${o.bindingsPaths ?? `    compassDocs: [docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml`}
correctness:
  mode: ${o.mode ?? "enforce"}
  tier: standard
`;

describe("RFC-1615 round-15: base-anchored governing references (CX-86..)", () => {
  // CX-86 — severity: fail-closed check. Mechanism: the base compassDocs binding
  // lists a doc ABSENT at base; requirementDocAtBase must degrade to no-ids and
  // CORR-03 must refuse every req entry — never read "absent" as favorable.
  it("CX-86: base compass doc bound but absent at base — CORR-03 refuses, absent is not unreadable", async () => {
    const f = fx();
    f.git(["rm", "docs/requirements.xml"]);
    const baseNoReq = f.commit("drop the requirements doc");
    f.write("docs/requirements.xml", REQUIREMENTS_TWO);
    f.write("docs/correctness.yaml", manifestYaml({}, reqEntry("CM-dispatch-02", "REQ-02")));
    f.commit("session re-creates the doc and wires REQ-02");
    const r = await gate(f, { base: baseNoReq });
    expect(r.status).toBe("fail");
    expect(r.messages.filter((m) => m.includes("CORR-03")).length).toBeGreaterThanOrEqual(2);
    expect(r.messages.join("\n")).toContain("cannot resolve");
    // absent ≠ unreadable: no ledger flag may fire for a legitimate miss
    expect(r.unreadableReads).toBeUndefined();
  });

  // CX-87 — severity: fail-closed check. Mechanism: base invariantsFile bound but
  // absent at base; the session creates it at HEAD with DNA ids — dnaIdsAtBase
  // must return no-ids and CORR-03 must refuse.
  it("CX-87: base invariantsFile absent at base — session-created DNA ids cannot resolve", async () => {
    const f = fx({
      extraFiles: {
        "forge.yaml": forgeYaml({
          bindingsPaths:
            "    compassDocs: [docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml\n    invariantsFile: docs/invariants.md",
        }),
        "docs/invariants.md": INVARIANTS,
        "docs/correctness.yaml": manifestYaml({}, dnaEntry("CM-dna-01", "DNA-7")),
      },
    });
    f.git(["rm", "docs/invariants.md"]);
    const baseNoInv = f.commit("drop the invariants file");
    f.write("docs/invariants.md", INVARIANTS_EVIL);
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}, `${dnaEntry("CM-dna-01", "DNA-7")}${dnaEntry("CM-dna-02", "DNA-99")}`),
    );
    f.commit("session re-creates invariants with DNA-99 and wires it");
    const r = await gate(f, { base: baseNoInv });
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("CORR-03");
    expect(r.messages.join("\n")).toContain("DNA-7 is not declared");
    expect(r.messages.join("\n")).toContain("DNA-99 is not declared");
    expect(r.messages.join("\n")).not.toContain("entry-deleted");
  });

  // CX-88 — severity: fail-closed check. Mechanism: the base compass blob is
  // corrupt; GateRepo.show must flag the ledger (entry resolves, bytes unreadable)
  // and the gate refuses CORR-GATE-01 — never judges the surface inert.
  it("CX-88: corrupt base compass blob — ledger flag refuses fail-closed", async () => {
    const f = fx();
    corruptBaseBlob(f, "docs/requirements.xml");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(r.unreadableReads?.length ?? 0).toBeGreaterThan(0);
    expect(r.messages.join("\n")).toContain("a git read failed");
  });

  // CX-89 — severity: positive parity. Mechanism: the FIRST base compass doc is
  // not requirements, a LATER one is — the provider loop must continue and find it.
  it("CX-89: first base compass doc is not requirements, a later one is — resolution finds it", async () => {
    const f = fx({
      extraFiles: {
        "forge.yaml": forgeYaml({
          bindingsPaths:
            "    compassDocs: [docs/notes.xml, docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml",
        }),
        "docs/notes.xml": NOTES_DOC,
      },
    });
    const r = await gate(f);
    expect(r.status).toBe("pass");
    expect(r.messages.join("\n")).not.toContain("CORR-03");
  });

  // CX-90 — severity: declared-flavor observation. Mechanism: the session DELETES
  // the base requirements doc at HEAD; resolution at the base still resolves, and
  // the deletion is not a frozen-path weakening — the gate passes.
  it("CX-90: session deletes the base requirements doc at HEAD — base-anchored resolution still holds", async () => {
    const f = fx();
    f.git(["rm", "docs/requirements.xml"]);
    f.commit("session deletes the requirements doc");
    const r = await gate(f);
    expect(r.status).toBe("pass");
  });

  // CX-91 — severity: positive coverage check. Mechanism: coverage counts are
  // computed over BASE ids; a session-added entry anchoring a base-silent
  // requirement must still count as anchored (no CORR-08).
  it("CX-91: session-added entry anchoring a base-silent requirement counts", async () => {
    const f = fx({ extraFiles: { "docs/requirements.xml": REQUIREMENTS_TWO } });
    f.write("docs/correctness.yaml", manifestYaml({}, reqEntry("CM-dispatch-02", "REQ-02")));
    f.commit("session wires REQ-02 to the frozen oracle");
    const r = await gate(f);
    expect(r.status).toBe("pass");
    expect(r.messages.join("\n")).not.toContain("CORR-08");
  });

  // CX-92 — severity: fail-closed check. Mechanism: the base RFC blob is corrupt;
  // rfcRefAtBase's repo.show must flag the ledger and CORR-03 must refuse.
  it("CX-92: corrupt base RFC blob — ledger flag + CORR-03 refuse", async () => {
    const f = fx({
      review: false,
      extraFiles: {
        "docs/correctness.yaml": manifestYaml({}, rfcAcEntry("CM-dispatch-02", "RFC-0100/AC-1")),
      },
    });
    f.write("docs/rfcs/rfc-0100-title.md", RFC_BODY);
    const accept = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    corruptBaseBlob(f, "docs/rfcs/rfc-0100-title.md", accept);
    const r = await gate(f, { base: accept });
    expect(r.status).toBe("fail");
    expect(r.unreadableReads?.length ?? 0).toBeGreaterThan(0);
    expect(r.messages.join("\n")).toContain("a git read failed");
  });

  // CX-93 — severity: positive parity. Mechanism: the governing RFC lives under
  // the rfcsDir archive subtree at base — the base ls-tree -r must find it and
  // requirement origin must derive.
  it("CX-93: RFC at base under archive/ resolves and mints requirement origin", async () => {
    const f = fx({
      review: false,
      extraFiles: {
        "docs/requirements.xml": REQUIREMENTS_NO_IDS,
        "docs/correctness.yaml": rfcOnlyManifest("RFC-0100/AC-1"),
      },
    });
    f.write("docs/rfcs/archive/rfc-0100-title.md", RFC_BODY);
    const accept = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    const r = await gate(f, { base: accept });
    expect(r.status).toBe("pass");
    expect(r.messages.join("\n")).not.toContain("CORR-03");
  });

  // CX-94 — severity: CX-82 fix, attack flavor. Mechanism: the session plants an
  // RFC at HEAD declaring a fabricated AC and wires an entry to it with the
  // frozen review-verified oracle — CORR-03 must resolve at the BASE (real RFC
  // declares no AC-99) and refuse; a HEAD-worktree resolver would pass.
  it("CX-94: HEAD-planted RFC with a fabricated AC cannot satisfy CORR-03", async () => {
    const f = fx();
    f.write("docs/rfcs/rfc-0100-title.md", RFC_BODY);
    const base = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    f.write("docs/rfcs/rfc-0100-aaa-evil.md", EVIL_RFC_BODY);
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}, rfcAcEntry("CM-dispatch-02", "RFC-0100/AC-99")),
    );
    f.commit("session plants an RFC and wires the fabricated AC");
    const r = await gate(f, { base });
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("RFC-0100 declares no AC-99");
  });

  // CX-95 — severity: shape check. Mechanism: a ref not matching RFC_REF_RE
  // (lowercase kind) must refuse as not-of-the-form, never resolve loosely.
  it("CX-95: ref shape mismatch (lowercase kind) refuses as not of the form", async () => {
    const f = fx();
    f.write("docs/rfcs/rfc-0100-title.md", RFC_BODY);
    const base = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}, rfcAcEntry("CM-dispatch-02", "RFC-0100/ac-1")),
    );
    f.commit("session wires a malformed ref");
    const r = await gate(f, { base });
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("not of the form RFC-NNNN/AC-N");
  });

  // CX-96 — severity: CX-82 fix, rebind flavor. Mechanism: the session rebinds
  // paths.rfcsDir to a planted dir and plants the fabricated-AC RFC there — the
  // rebind must be judged as a binding weakening AND resolution must stay at the
  // base rfcsDir (real RFC declares no AC-99).
  it("CX-96: rfcsDir rebind to a planted dir is judged and cannot redirect CORR-03", async () => {
    const f = fx({
      extraFiles: { "forge.yaml": forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs }" }) },
    });
    f.write("docs/rfcs/rfc-0100-title.md", RFC_BODY);
    const base = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    f.write("forge.yaml", forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs-evil }" }));
    f.write("docs/rfcs-evil/rfc-0100-evil.md", EVIL_RFC_BODY);
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}, rfcAcEntry("CM-dispatch-02", "RFC-0100/AC-99")),
    );
    f.commit("session rebinds rfcsDir and plants the RFC there");
    const r = await gate(f, { base });
    expect(r.status).toBe("fail");
    expect(
      r.weakenings.some((w) => w.kind === "binding" && w.message.includes("paths.rfcsDir")),
      "the rebind is judged as a binding weakening",
    ).toBe(true);
    expect(r.messages.join("\n")).toContain("RFC-0100 declares no AC-99");
  });

  // CX-97 — severity: conservative-judgement check. Mechanism: a reorder-only
  // compassDocs change must flag as a binding weakening (canon list compare).
  it("CX-97: compassDocs reorder-only change is judged as a binding weakening", async () => {
    const f = fx({
      extraFiles: {
        "forge.yaml": forgeYaml({
          bindingsPaths:
            "    compassDocs: [docs/requirements.xml, docs/notes.xml]\n    correctnessManifest: docs/correctness.yaml",
        }),
        "docs/notes.xml": NOTES_DOC,
      },
    });
    f.write(
      "forge.yaml",
      forgeYaml({
        bindingsPaths:
          "    compassDocs: [docs/notes.xml, docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml",
      }),
    );
    f.commit("session reorders compassDocs");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("bindings.paths.compassDocs changed from");
  });

  // CX-98 — severity: adoption-contour check. Mechanism: the base binds no
  // manifest/compassDocs; the session adopts both at HEAD — even a requirements
  // doc that EXISTS at base cannot satisfy CORR-03 because the base binding
  // listed no compass docs (base-anchored, conservative).
  it("CX-98: adoption contour — base compassDocs [] refuses req refs even with the doc present at base", async () => {
    const f = fx({
      extraFiles: {
        "forge.yaml": forgeYaml({
          commands: '    verify: "node scripts/verify.mjs"',
          bindingsPaths: "",
        }),
      },
    });
    f.write(
      "forge.yaml",
      forgeYaml({
        bindingsPaths:
          "    compassDocs: [docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml",
      }),
    );
    f.commit("session adopts the contour");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("cannot resolve");
    expect(r.messages.join("\n")).toContain("CORR-03");
  });

  // CX-99 — severity: ordering check. Mechanism: a provider read failure (corrupt
  // base compass blob) must land in unreadableReads BEFORE the accept-path
  // `unreadableReads.length === 0` check — an otherwise-isolated mode weakening
  // (forge.yaml intact, judged independently of the corrupt blob) with
  // --accept-weakening must be refused as mixed-weakening, never accepted.
  it("CX-99: provider read failure lands in the ledger before the accept check — acceptance refused", async () => {
    const f = fx();
    corruptBaseBlob(f, "docs/requirements.xml");
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: enforce", "mode: warn"));
    f.commit("session downgrades the mode");
    const r = await gate(f, { acceptWeakening: "operator accepts the mode downgrade" });
    expect(r.acceptedWeakening, "the accept must not grant on an unreadable diff").toBeNull();
    expect(r.status).toBe("fail");
    expect(
      r.weakenings.length,
      "the mode weakening is judged independently of the corrupt blob",
    ).toBeGreaterThan(0);
    expect(r.messages.join("\n")).toContain("mixed-weakening");
    expect(r.messages.join("\n")).toContain("a git read failed");
  });

  // CX-100 — severity: fail-closed check on the exempt early-return path.
  // Mechanism: exempt×exempt contour with a corrupt base compass blob — the
  // ledger flag (from readFrozenSet's base compass reads) must force status fail.
  it("CX-100: exempt×exempt contour with a corrupt base compass doc fails closed", async () => {
    const f = fx({
      mode: "exempt",
      extraFiles: {
        "forge.yaml": forgeYaml({
          mode: "exempt",
          bindingsPaths: "    compassDocs: [docs/requirements.xml]",
        }),
      },
    });
    corruptBaseBlob(f, "docs/requirements.xml");
    const r = await gate(f);
    expect(r.status, "the early exempt return must not mask the unreadable read").toBe("fail");
    expect(r.unreadableReads?.length ?? 0).toBeGreaterThan(0);
  });

  // CX-101 — severity: fail-closed check under --policy-only. Mechanism: the
  // providers still run (validation is unconditional) and their read failure
  // must refuse the policy-only verdict.
  it("CX-101: --policy-only with a corrupt base compass doc fails closed", async () => {
    const f = fx();
    corruptBaseBlob(f, "docs/requirements.xml");
    const r = await gate(f, { policyOnly: true });
    expect(r.status).toBe("fail");
    expect(r.unreadableReads?.length ?? 0).toBeGreaterThan(0);
    expect(r.messages.join("\n")).toContain("a git read failed");
  });

  // CX-102 — severity: refactor-parity check. Mechanism: the worktree
  // resolveRfcRef delegates to resolveRfcRefContent — reason strings must be
  // identical for not-found and no-item; only the success rfcFile shape differs
  // (no consumer parses it).
  it("CX-102: resolveRfcRef/resolveRfcRefContent reason parity", () => {
    const f = fx();
    f.write("docs/rfcs/rfc-0100-title.md", RFC_BODY); // worktree only — no gate run here
    const noItemWt = resolveRfcRef(f.root, "docs/rfcs", "RFC-0100/AC-9", "AC");
    const noItemGit = resolveRfcRefContent(RFC_BODY, "RFC-0100/AC-9", "AC", "docs/rfcs");
    expect(noItemWt).toEqual(noItemGit);
    const missWt = resolveRfcRef(f.root, "docs/rfcs", "RFC-9999/AC-1", "AC");
    const missGit = resolveRfcRefContent(null, "RFC-9999/AC-1", "AC", "docs/rfcs");
    expect(missWt.ok).toBe(false);
    expect(missGit.ok).toBe(false);
    expect(missWt.ok === false && missWt.reason).toBe(missGit.ok === false && missGit.reason);
    const hitWt = resolveRfcRef(f.root, "docs/rfcs", "RFC-0100/AC-1", "AC");
    const hitGit = resolveRfcRefContent(RFC_BODY, "RFC-0100/AC-1", "AC", "docs/rfcs");
    expect(hitWt.ok).toBe(true);
    expect(hitGit.ok).toBe(true);
    // documented shape divergence: worktree names the file, git flavor names the base
    expect(hitWt.ok && hitWt.rfcFile).toBe("docs/rfcs/rfc-0100-title.md");
    expect(hitGit.ok && hitGit.rfcFile).toBe("docs/rfcs (at the integration base)");
  });

  // CX-103 — severity: CX-83 fix, edit flavor. Mechanism: the session EDITS the
  // base requirements doc at HEAD adding REQ-99 and wires an entry to it with the
  // frozen verified oracle — CORR-03 must judge the BASE doc and refuse.
  it("CX-103: session-edited requirements doc cannot mint requirement provenance", async () => {
    const f = fx();
    f.write("docs/requirements.xml", REQUIREMENTS_TWO.replace("REQ-02", "REQ-99"));
    f.write("docs/correctness.yaml", manifestYaml({}, reqEntry("CM-dispatch-02", "REQ-99")));
    f.commit("session edits the requirements doc and wires REQ-99");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("requirement REQ-99 is not declared");
  });

  // CX-104 — severity: CX-83 fix, rebind flavor. Mechanism: the session rebinds
  // compassDocs to a planted requirements doc declaring REQ-99 — the rebind is a
  // binding weakening AND resolution stays at the base doc.
  it("CX-104: compassDocs rebind to a planted requirements doc is judged and cannot mint ids", async () => {
    const f = fx();
    f.write(
      "forge.yaml",
      forgeYaml({
        bindingsPaths:
          "    compassDocs: [docs/evil.xml]\n    correctnessManifest: docs/correctness.yaml",
      }),
    );
    f.write("docs/evil.xml", EVIL_REQUIREMENTS);
    f.write("docs/correctness.yaml", manifestYaml({}, reqEntry("CM-dispatch-02", "REQ-99")));
    f.commit("session rebinds compassDocs and plants the doc");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(
      r.weakenings.some(
        (w) => w.kind === "binding" && w.message.includes("bindings.paths.compassDocs"),
      ),
    ).toBe(true);
    expect(r.messages.join("\n")).toContain("requirement REQ-99 is not declared");
  });

  // CX-105 — severity: CX-83 fix, DNA edit flavor. Mechanism: the session adds a
  // `## DNA-99` heading to the base invariants file and wires a dna entry —
  // dnaIdsAtBase must judge the BASE file and refuse.
  it("CX-105: session-added DNA heading cannot mint DNA provenance", async () => {
    const f = fx({
      extraFiles: {
        "forge.yaml": forgeYaml({
          bindingsPaths:
            "    compassDocs: [docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml\n    invariantsFile: docs/invariants.md",
        }),
        "docs/invariants.md": INVARIANTS,
        "docs/correctness.yaml": manifestYaml({}, dnaEntry("CM-dna-01", "DNA-7")),
      },
    });
    f.write("docs/invariants.md", INVARIANTS_EVIL);
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}, `${dnaEntry("CM-dna-01", "DNA-7")}${dnaEntry("CM-dna-02", "DNA-99")}`),
    );
    f.commit("session adds DNA-99 and wires it");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("DNA-99 is not declared");
    expect(r.messages.join("\n")).not.toContain("entry-deleted");
  });

  // CX-106 — severity: unjudged-but-inert check. Mechanism: the session rebinds
  // bindings.paths.invariantsFile to a planted file declaring DNA-99 — the rebind
  // is NOT judged as a binding weakening (documented gap), but it is inert for
  // the verdict: dnaIdsAtBase reads the BASE file, so CORR-03 still refuses.
  it("CX-106: invariantsFile rebind is unjudged but inert — CORR-03 still refuses", async () => {
    const f = fx({
      extraFiles: {
        "forge.yaml": forgeYaml({
          bindingsPaths:
            "    compassDocs: [docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml\n    invariantsFile: docs/invariants.md",
        }),
        "docs/invariants.md": INVARIANTS,
        "docs/correctness.yaml": manifestYaml({}, dnaEntry("CM-dna-01", "DNA-7")),
      },
    });
    f.write(
      "forge.yaml",
      forgeYaml({
        bindingsPaths:
          "    compassDocs: [docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml\n    invariantsFile: docs/invariants-evil.md",
      }),
    );
    f.write("docs/invariants-evil.md", INVARIANTS_EVIL);
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}, `${dnaEntry("CM-dna-01", "DNA-7")}${dnaEntry("CM-dna-02", "DNA-99")}`),
    );
    f.commit("session rebinds invariantsFile and plants the file");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(
      r.weakenings.some((w) => w.kind === "binding" && w.message.includes("invariantsFile")),
      "documented: the invariantsFile rebind itself is not a judged binding",
    ).toBe(false);
    expect(r.messages.join("\n")).toContain("DNA-99 is not declared");
  });

  // CX-107 — severity: documented divergence (permissive, base-committed).
  // Mechanism: the gate's base resolver is `ls-tree -r` (any subdir) while the
  // worktree resolver only descends into archive/ — a base RFC in a non-archive
  // subdir resolves in the gate. Base-committed, so no session minting vector.
  it("CX-107: base RFC in a non-archive subdir resolves in the gate (documented divergence)", async () => {
    const f = fx({
      review: false,
      extraFiles: {
        "docs/requirements.xml": REQUIREMENTS_NO_IDS,
        "docs/correctness.yaml": rfcOnlyManifest("RFC-0100/AC-1"),
      },
    });
    f.write("docs/rfcs/notes/rfc-0100-title.md", RFC_BODY);
    const accept = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    const r = await gate(f, { base: accept });
    expect(r.status).toBe("pass");
    expect(r.messages.join("\n")).not.toContain("CORR-03");
  });

  // CX-108 — severity: positive control. Mechanism: a HEAD-planted exact COPY of
  // the real base RFC is inert — resolution at the base picks the real file and
  // the legitimately wired entry passes.
  it("CX-108: HEAD-planted duplicate of the real RFC is inert — legitimate wiring passes", async () => {
    const f = fx();
    f.write("docs/rfcs/rfc-0100-title.md", RFC_BODY);
    const base = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    f.write("docs/rfcs/rfc-0100-aaa-copy.md", RFC_BODY);
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}, rfcAcEntry("CM-dispatch-02", "RFC-0100/AC-1")),
    );
    f.commit("session plants a duplicate and wires the real AC");
    const r = await gate(f, { base });
    expect(r.status).toBe("pass");
    expect(r.messages.join("\n")).not.toContain("CORR-03");
  });

  // CX-109 — severity: positive end-to-end control. Mechanism: with no review
  // record at all, an rfc-ac entry whose oracle is byte-identical to its state at
  // the governed base acceptance derives requirement origin through the
  // base-anchored resolver and the gate passes.
  it("CX-109: requirement origin end-to-end through the base-anchored resolver (no review record)", async () => {
    const f = fx({
      review: false,
      extraFiles: {
        "docs/requirements.xml": REQUIREMENTS_NO_IDS,
        "docs/correctness.yaml": rfcOnlyManifest("RFC-0100/AC-1"),
      },
    });
    f.write("docs/rfcs/rfc-0100-title.md", RFC_BODY);
    const accept = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    const r = await gate(f, { base: accept });
    expect(r.status).toBe("pass");
    expect(r.messages.join("\n")).not.toContain("CORR-GATE-03");
  });

  // CX-110 — severity: mode-coverage check. Mechanism: the validator hardcodes
  // CORR-03 as severity "error" (unlike CORR-01/07/08, which are mode-gated), so
  // the base-anchored refusal holds in warn mode too — a planted ref cannot pass
  // even where the gate is advisory.
  it("CX-110: the base-anchored refusal holds in warn mode too (CORR-03 is not mode-gated)", async () => {
    const f = fx({ mode: "warn" });
    f.write("docs/rfcs/rfc-0100-title.md", RFC_BODY);
    const base = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    f.write("docs/rfcs/rfc-0100-aaa-evil.md", EVIL_RFC_BODY);
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}, rfcAcEntry("CM-dispatch-02", "RFC-0100/AC-99")),
    );
    f.commit("session plants an RFC and wires the fabricated AC");
    const r = await gate(f, { base });
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("RFC-0100 declares no AC-99");
  });

  // CX-111 — severity: conservative-interaction check. Mechanism: a compassDocs
  // rebind makes forge.yaml non-isolated (the key is not in the accept strip),
  // so --accept-weakening must refuse the session as mixed even though the only
  // reported weakening is the binding itself.
  it("CX-111: --accept-weakening refuses a compassDocs rebind (forge.yaml never isolated for it)", async () => {
    const f = fx();
    f.write(
      "forge.yaml",
      forgeYaml({
        bindingsPaths:
          "    compassDocs: [docs/evil.xml]\n    correctnessManifest: docs/correctness.yaml",
      }),
    );
    f.write("docs/evil.xml", EVIL_REQUIREMENTS);
    f.write("docs/correctness.yaml", manifestYaml({}, reqEntry("CM-dispatch-02", "REQ-99")));
    f.commit("session rebinds compassDocs");
    const r = await gate(f, { acceptWeakening: "operator accepts the rebind" });
    expect(r.acceptedWeakening).toBeNull();
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("mixed-weakening");
  });
});
