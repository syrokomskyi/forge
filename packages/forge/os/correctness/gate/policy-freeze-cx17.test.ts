/*
<MODULE_CONTRACT>
<purpose>RFC-1615 round-16 adversarial verification probes (CX-112+):
the hardened rfcPath scope filter (archive parity), the newly judged
bindings.paths.invariantsFile, and the extended --accept-weakening
isolation strip (compassDocs / invariantsFile / paths.rfcsDir). Each probe
reproduces one attack or parity check against `correctness.gate` and asserts
the expected verdict.</purpose>
<non-goals>
  <item>Not a contract source of truth — gate/run.ts owns behaviour.</item>
  <item>Never modifies gate source; fixtures are hermetic temp git repos.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessGate } from "./run.ts";
import {
  ORACLE_PATH,
  makeGateFixture,
  manifestYaml,
  type GateFixture,
} from "./tests/gate-fixture.ts";
import { resolveRfcRef } from "../references.ts";

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
const INVARIANTS = `# Invariants\n\n## DNA-7 — never two openers\n`;
const INVARIANTS_EVIL = `# Invariants\n\n## DNA-7 — never two openers\n\n## DNA-99 — planted\n`;
const REQUIREMENTS_NO_IDS = `<requirements>\n  <meta><document-id>requirements</document-id></meta>\n</requirements>\n`;
const EVIL_REQUIREMENTS = `<requirements>\n  <meta><document-id>requirements</document-id></meta>\n  <requirement id="REQ-99">planted</requirement>\n</requirements>\n`;

const rfcAcEntry = (id: string, ref: string, check = ORACLE_PATH) =>
  `  - id: ${id}\n    source: rfc-ac\n    ref: ${ref}\n    seam: data\n    anchors: [INV-dispatch-01]\n    oracles:\n      - check: test:${check}\n        substrate: L1\n`;
const dnaEntry = (id: string, ref: string, check = ORACLE_PATH) =>
  `  - id: ${id}\n    source: dna\n    ref: ${ref}\n    seam: data\n    anchors: [INV-dispatch-01]\n    oracles:\n      - check: test:${check}\n        substrate: L1\n`;
const rfcOnlyManifest = (ref: string) =>
  `schema: forge/correctness-manifest@1\nentries:\n${rfcAcEntry("CM-dispatch-01", ref)}support: []\nexemptions: []\n`;

const forgeYaml = (o: {
  mode?: string;
  commands?: string;
  bindingsPaths?: string;
  topPaths?: string | null;
  append?: string;
}) => `schema: forge/config@1
project:
  name: gate-fixture
${o.topPaths === null ? "" : `paths: ${o.topPaths ?? "{}"}\n`}bindings:
  schema: forge/bindings@1
  commands:
${o.commands ?? `    checkRun: "node {file}"\n    verify: "node scripts/verify.mjs"`}
  paths:
${o.bindingsPaths ?? `    compassDocs: [docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml`}
correctness:
  mode: ${o.mode ?? "enforce"}
  tier: standard
${o.append ?? ""}`;

describe("r16: rfcPath scope parity (O-3 hardening)", () => {
  // Control: RFC directly under rfcsDir still resolves at the base.
  it("P-A1: RFC directly under rfcsDir resolves", async () => {
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
    expect(r.messages.join("\n")).not.toContain("CORR-03");
  });

  // Worktree parity: archive/ is searched RECURSIVELY — archive/x/rfc-…md resolves.
  it("P-A2: RFC under archive/<sub>/ resolves (full recursion under archive)", async () => {
    const f = fx({
      review: false,
      extraFiles: {
        "docs/requirements.xml": REQUIREMENTS_NO_IDS,
        "docs/correctness.yaml": rfcOnlyManifest("RFC-0100/AC-1"),
      },
    });
    f.write("docs/rfcs/archive/2026/rfc-0100-title.md", RFC_BODY);
    const accept = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    const r = await gate(f, { base: accept });
    expect(r.status).toBe("pass");
    expect(r.messages.join("\n")).not.toContain("CORR-03");
  });

  // CX-107 flip: a non-archive subdir no longer resolves at the base.
  it("P-A3: RFC under a non-archive subdir no longer resolves — CORR-03 refuses", async () => {
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
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("not found");
  });

  // Prefix-confusion check: `archivefoo/` must NOT satisfy `archive/`.
  it("P-A4: docs/rfcs/archivefoo/ does not satisfy the archive/ scope", async () => {
    const f = fx({
      review: false,
      extraFiles: {
        "docs/requirements.xml": REQUIREMENTS_NO_IDS,
        "docs/correctness.yaml": rfcOnlyManifest("RFC-0100/AC-1"),
      },
    });
    f.write("docs/rfcs/archivefoo/rfc-0100-title.md", RFC_BODY);
    const accept = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    const r = await gate(f, { base: accept });
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("not found");
  });

  // Case check: `Archive/` is out of scope (worktree skips it too).
  it("P-A5: docs/rfcs/Archive/ is out of scope (case)", async () => {
    const f = fx({
      review: false,
      extraFiles: {
        "docs/requirements.xml": REQUIREMENTS_NO_IDS,
        "docs/correctness.yaml": rfcOnlyManifest("RFC-0100/AC-1"),
      },
    });
    f.write("docs/rfcs/Archive/rfc-0100-title.md", RFC_BODY);
    const accept = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    const r = await gate(f, { base: accept });
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("not found");
  });

  // rfcsDir with a trailing slash normalizes and still resolves.
  it("P-A6: rfcsDir with trailing slash resolves", async () => {
    const f = fx({
      review: false,
      extraFiles: {
        "forge.yaml": forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs/ }" }),
        "docs/requirements.xml": REQUIREMENTS_NO_IDS,
        "docs/correctness.yaml": rfcOnlyManifest("RFC-0100/AC-1"),
      },
    });
    f.write("docs/rfcs/rfc-0100-title.md", RFC_BODY);
    const accept = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    const r = await gate(f, { base: accept });
    expect(r.status).toBe("pass");
    expect(r.messages.join("\n")).not.toContain("CORR-03");
  });

  // CX-114 (fixed): `paths.rfcsDir: "."` — the git-side root normalizes to ""
  // so ls-tree paths prefix-match at the repo root; parity with the worktree
  // resolver which scans the repo root + archive/.
  it('CX-114: rfcsDir "." — gate resolves the root-level RFC like the worktree resolver', async () => {
    const f = fx({
      review: false,
      extraFiles: {
        "forge.yaml": forgeYaml({ topPaths: '{ rfcsDir: "." }' }),
        "docs/requirements.xml": REQUIREMENTS_NO_IDS,
        "docs/correctness.yaml": rfcOnlyManifest("RFC-0100/AC-1"),
      },
    });
    f.write("rfc-0100-title.md", RFC_BODY);
    const accept = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    // Canonical worktree resolver DOES find it — parity reference point.
    expect(resolveRfcRef(f.root, ".", "RFC-0100/AC-1", "AC").ok).toBe(true);
    const r = await gate(f, { base: accept });
    expect(r.status).toBe("pass");
  });

  // CX-113 (fixed): duplicate RFC-0100 files — real at rfcsDir root, shadow
  // in archive/. The gate now prefers the root-level match like findRfcFile,
  // so the archive shadow cannot smuggle AC-99 coverage.
  it("CX-113: root RFC wins over an archive shadow (parity with findRfcFile)", async () => {
    const f = fx({
      review: false,
      extraFiles: {
        "docs/requirements.xml": REQUIREMENTS_NO_IDS,
        "docs/correctness.yaml": rfcOnlyManifest("RFC-0100/AC-99"),
      },
    });
    f.write("docs/rfcs/rfc-0100-real.md", RFC_BODY); // declares AC-1 only
    f.write("docs/rfcs/archive/rfc-0100-shadow.md", EVIL_RFC_BODY); // declares AC-99
    const accept = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    // Canonical worktree resolver resolves the ROOT file → AC-99 missing.
    const wt = resolveRfcRef(f.root, "docs/rfcs", "RFC-0100/AC-99", "AC");
    expect(wt.ok).toBe(false);
    // The gate resolves the ROOT file too → AC-99 is refused like the
    // canonical resolver refuses it.
    const r = await gate(f, { base: accept });
    expect(r.messages.join("\n")).toContain("declares no AC-99");
    expect(r.status).toBe("fail");
  });

  // Nested archive inside rfcsDir-as-archive: rfcsDir = docs/rfcs/archive —
  // `x/` subdir excluded on both resolvers, `archive/` subdir included.
  it("P-A7: rfcsDir = docs/rfcs/archive — x/ excluded, archive/ included", async () => {
    const f = fx({
      review: false,
      extraFiles: {
        "forge.yaml": forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs/archive }" }),
        "docs/requirements.xml": REQUIREMENTS_NO_IDS,
        "docs/correctness.yaml": rfcOnlyManifest("RFC-0100/AC-1"),
      },
    });
    f.write("docs/rfcs/archive/x/rfc-0100-title.md", RFC_BODY);
    const accept = f.commit("accept: RFC-0100\n\nX-RFC: RFC-0100");
    const wt = resolveRfcRef(f.root, "docs/rfcs/archive", "RFC-0100/AC-1", "AC");
    const r = await gate(f, { base: accept });
    expect(wt.ok).toBe(false);
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("not found");
  });
});

describe("r16: invariantsFile as judged binding (O-1)", () => {
  const invFixture = (extra: Parameters<typeof fx>[0] = {}) =>
    fx({
      extraFiles: {
        "forge.yaml": forgeYaml({
          bindingsPaths:
            "    compassDocs: [docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml\n    invariantsFile: docs/invariants.md",
        }),
        "docs/invariants.md": INVARIANTS,
        "docs/correctness.yaml": manifestYaml({}, dnaEntry("CM-dna-01", "DNA-7")),
        ...extra.extraFiles,
      },
      ...extra,
    });

  // CX-106 flip: the rebind is now JUDGED as a binding weakening.
  it("P-B1: invariantsFile rebind is judged + base DNA ids still refuse planted DNA-99", async () => {
    const f = invFixture();
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
    f.commit("session rebinds invariantsFile and plants DNA-99");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(
      r.weakenings.some(
        (w) => w.kind === "binding" && w.message.includes("bindings.paths.invariantsFile"),
      ),
      "the rebind is now a judged binding weakening",
    ).toBe(true);
    expect(r.messages.join("\n")).toContain("DNA-99 is not declared");
  });

  // Add-direction: base bound no invariantsFile under a declared contour.
  it("P-B2: invariantsFile added under a declared contour is judged", async () => {
    const f = fx();
    f.write(
      "forge.yaml",
      forgeYaml({
        bindingsPaths:
          "    compassDocs: [docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml\n    invariantsFile: docs/invariants.md",
      }),
    );
    f.write("docs/invariants.md", INVARIANTS);
    f.commit("session adds invariantsFile");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(
      r.weakenings.some((w) => w.kind === "binding" && w.message.includes("invariantsFile")),
    ).toBe(true);
  });

  // Remove-direction: base bound, head drops the key.
  it("P-B3: invariantsFile removed under a declared contour is judged", async () => {
    const f = invFixture();
    f.write(
      "forge.yaml",
      forgeYaml({
        bindingsPaths:
          "    compassDocs: [docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml",
      }),
    );
    f.commit("session drops invariantsFile");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(
      r.weakenings.some((w) => w.kind === "binding" && w.message.includes("invariantsFile")),
    ).toBe(true);
  });

  // Type flip: base bound, head sets a non-string → null → judged.
  it("P-B4: invariantsFile retyped to a non-string is judged", async () => {
    const f = invFixture();
    f.write(
      "forge.yaml",
      forgeYaml({
        bindingsPaths:
          "    compassDocs: [docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml\n    invariantsFile: [docs/invariants.md]",
      }),
    );
    f.commit("session retypes invariantsFile");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(
      r.weakenings.some((w) => w.kind === "binding" && w.message.includes("invariantsFile")),
    ).toBe(true);
  });
});

describe("r16: extended isolation strip (O-4/O-7)", () => {
  // The rfcsDir rebind alone is now an isolated weakening — accept works.
  // (The value need not exist: the weakening judges the binding value.)
  it("P-C1: paths.rfcsDir rebind is --accept-weakening acceptable", async () => {
    const f = fx({
      extraFiles: { "forge.yaml": forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs }" }) },
    });
    f.write("forge.yaml", forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs-evil }" }));
    f.commit("session rebinds rfcsDir");
    const r = await gate(f, { acceptWeakening: "operator accepts the rebind" });
    expect(r.acceptedWeakening, "an isolated rfcsDir rebind must be acceptable").not.toBeNull();
    expect(r.status).toBe("pass");
  });

  // …but the MOMENT the rebind comes with the planted dir it stops being isolated.
  it("P-C1b: rfcsDir rebind + planted target dir → mixed-weakening refuse", async () => {
    const f = fx({
      extraFiles: { "forge.yaml": forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs }" }) },
    });
    f.write("forge.yaml", forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs-evil }" }));
    f.write("docs/rfcs-evil/rfc-0100-evil.md", EVIL_RFC_BODY);
    f.commit("session rebinds rfcsDir and plants the dir");
    const r = await gate(f, { acceptWeakening: "operator accepts the rebind" });
    expect(r.acceptedWeakening).toBeNull();
    expect(r.messages.join("\n")).toContain("mixed-weakening");
  });

  // Sibling smuggling: paths.otherKey changed alongside the rfcsDir rebind —
  // the strip removes ONLY rfcsDir, so the sibling change must break isolation.
  it("P-C2: rfcsDir rebind + paths sibling change → mixed-weakening refuse", async () => {
    const f = fx({
      extraFiles: {
        "forge.yaml": forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs, adrsDir: docs/adrs }" }),
      },
    });
    f.write("forge.yaml", forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs-evil, adrsDir: vault }" }));
    f.commit("session rebinds rfcsDir and adrsDir");
    const r = await gate(f, { acceptWeakening: "operator accepts" });
    expect(r.acceptedWeakening).toBeNull();
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("mixed-weakening");
  });

  // Foreign file smuggling: rfcsDir rebind + an unfrozen file change.
  it("P-C3: rfcsDir rebind + foreign file → mixed-weakening refuse", async () => {
    const f = fx({
      extraFiles: { "forge.yaml": forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs }" }) },
    });
    f.write("forge.yaml", forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs-evil }" }));
    f.write("src/backdoor.ts", "export const x = 1;\n");
    f.commit("session rebinds rfcsDir and adds a foreign file");
    const r = await gate(f, { acceptWeakening: "operator accepts" });
    expect(r.acceptedWeakening).toBeNull();
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("mixed-weakening");
    expect(r.messages.join("\n")).toContain("src/backdoor.ts");
  });

  // CX-112 (fixed): `paths` entirely absent at base; the session adds
  // `paths: {rfcsDir: …}`. The weakening IS reported (binding added) and the
  // strip now prunes the emptied `paths` container → the isolated weakening
  // can be operator-accepted.
  it("CX-112: paths absent at base → paths:{rfcsDir} add is --accept-weakening acceptable", async () => {
    const f = fx({
      extraFiles: { "forge.yaml": forgeYaml({ topPaths: null }) },
    });
    f.write("forge.yaml", forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs-evil }" }));
    f.commit("session adds paths.rfcsDir");
    const r = await gate(f, { acceptWeakening: "operator accepts" });
    expect(
      r.weakenings.some((w) => w.kind === "binding" && w.message.includes("paths.rfcsDir")),
      "the add is judged",
    ).toBe(true);
    expect(r.acceptedWeakening).not.toBeNull();
    expect(r.status).toBe("pass");
  });

  // The same asymmetry in remove direction: `paths` had only rfcsDir at base;
  // head deletes the whole `paths` key → both sides strip to absent, so the
  // accept lands on the judged binding weakening — but dropping the required
  // `paths` section leaves forge.yaml schema-invalid → CORR-01 still refuses.
  it("CX-112b: whole paths removed at HEAD → accept lands on the binding, schema refuse stands", async () => {
    const f = fx({
      extraFiles: { "forge.yaml": forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs }" }) },
    });
    f.write("forge.yaml", forgeYaml({ topPaths: null }));
    f.commit("session removes the whole paths key");
    const r = await gate(f, { acceptWeakening: "operator accepts" });
    expect(
      r.weakenings.some((w) => w.kind === "binding" && w.message.includes("paths.rfcsDir")),
    ).toBe(true);
    expect(r.acceptedWeakening).not.toBeNull();
    expect(r.messages.join("\n")).not.toContain("mixed-weakening");
    expect(r.status).toBe("fail");
    expect(r.messages.join("\n")).toContain("schema validation");
  });

  // Remove-only with surviving siblings IS isolated (control for CX-112).
  it("P-C4: rfcsDir removed while paths siblings remain → isolated accept", async () => {
    const f = fx({
      extraFiles: {
        "forge.yaml": forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs, adrsDir: docs/adrs }" }),
      },
    });
    f.write("forge.yaml", forgeYaml({ topPaths: "{ adrsDir: docs/adrs }" }));
    f.commit("session removes only rfcsDir");
    const r = await gate(f, { acceptWeakening: "operator accepts" });
    expect(r.acceptedWeakening).not.toBeNull();
    expect(r.status).toBe("pass");
  });

  // CX-111 flip: a compassDocs rebind is now strippable → accept works.
  it("P-C5: compassDocs rebind is --accept-weakening acceptable (strip gained the key)", async () => {
    const f = fx();
    f.write(
      "forge.yaml",
      forgeYaml({
        bindingsPaths:
          "    compassDocs: [docs/other.xml]\n    correctnessManifest: docs/correctness.yaml",
      }),
    );
    f.commit("session rebinds compassDocs (value only)");
    const r = await gate(f, { acceptWeakening: "operator accepts the rebind" });
    expect(r.acceptedWeakening).not.toBeNull();
    expect(r.status).toBe("pass");
    expect(
      r.weakenings.some((w) => w.kind === "binding" && w.message.includes("compassDocs")),
    ).toBe(true);
  });

  // …but the planted doc itself stays foreign.
  it("P-C5b: compassDocs rebind + planted doc → mixed-weakening refuse", async () => {
    const f = fx();
    f.write(
      "forge.yaml",
      forgeYaml({
        bindingsPaths:
          "    compassDocs: [docs/evil.xml]\n    correctnessManifest: docs/correctness.yaml",
      }),
    );
    f.write("docs/evil.xml", EVIL_REQUIREMENTS);
    f.commit("session rebinds compassDocs and plants the doc");
    const r = await gate(f, { acceptWeakening: "operator accepts the rebind" });
    expect(r.acceptedWeakening).toBeNull();
    expect(r.messages.join("\n")).toContain("mixed-weakening");
  });

  // invariantsFile rebind is strippable too.
  it("P-C6: invariantsFile rebind is --accept-weakening acceptable", async () => {
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
          "    compassDocs: [docs/requirements.xml]\n    correctnessManifest: docs/correctness.yaml\n    invariantsFile: docs/invariants2.md",
      }),
    );
    f.commit("session rebinds invariantsFile (value only)");
    const r = await gate(f, { acceptWeakening: "operator accepts" });
    if (r.status !== "pass") console.log("P-C6 messages:", r.messages, "weak:", r.weakenings);
    expect(r.acceptedWeakening).not.toBeNull();
    expect(r.status).toBe("pass");
  });

  // checkRun + rfcsDir rebind in ONE diff — all stripped → isolated accept.
  it("P-C7: checkRun + paths.rfcsDir rebinds in one diff → isolated accept", async () => {
    const f = fx({
      extraFiles: { "forge.yaml": forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs }" }) },
    });
    f.write(
      "forge.yaml",
      forgeYaml({
        topPaths: "{ rfcsDir: docs/rfcs-evil }",
        commands: '    checkRun: "node --evil {file}"\n    verify: "node scripts/verify.mjs"',
      }),
    );
    f.commit("session rebinds checkRun and rfcsDir");
    const r = await gate(f, { acceptWeakening: "operator accepts both" });
    expect(r.acceptedWeakening).not.toBeNull();
    expect(r.status).toBe("pass");
  });

  // Declared policy, additive:[paths] — rfcsDir leaf change is a policy-key
  // weakening AND a binding weakening; strip deletes `paths` → isolated.
  it("P-C8: additive:[paths] + rfcsDir rebind → weakening reported, accept lands", async () => {
    const f = fx({
      extraFiles: {
        "forge.yaml": forgeYaml({
          topPaths: "{ rfcsDir: docs/rfcs }",
          append: "policy:\n  mutable: [project]\n  additive: [paths]\n",
        }),
      },
    });
    f.write(
      "forge.yaml",
      forgeYaml({
        topPaths: "{ rfcsDir: docs/rfcs-evil }",
        append: "policy:\n  mutable: [project]\n  additive: [paths]\n",
      }),
    );
    f.commit("session rebinds rfcsDir under additive paths");
    const r = await gate(f, { acceptWeakening: "operator accepts" });
    expect(r.weakenings.length).toBeGreaterThan(0);
    expect(r.acceptedWeakening).not.toBeNull();
    expect(r.status).toBe("pass");
  });

  // Declared policy, mutable:[paths] — a paths sibling change is legal
  // (mutable) yet must still break isolation: the kept `paths` minus rfcsDir
  // is compared, so the mutable sibling diff lands mixed-weakening.
  it("P-C9: mutable:[paths] + rfcsDir rebind + sibling change → mixed-weakening", async () => {
    const f = fx({
      extraFiles: {
        "forge.yaml": forgeYaml({
          topPaths: "{ rfcsDir: docs/rfcs, adrsDir: docs/adrs }",
          append: "policy:\n  mutable: [paths]\n",
        }),
      },
    });
    f.write(
      "forge.yaml",
      forgeYaml({
        topPaths: "{ rfcsDir: docs/rfcs-evil, adrsDir: vault }",
        append: "policy:\n  mutable: [paths]\n",
      }),
    );
    f.commit("session rebinds rfcsDir and mutable sibling");
    const r = await gate(f, { acceptWeakening: "operator accepts" });
    expect(r.acceptedWeakening).toBeNull();
    expect(r.messages.join("\n")).toContain("mixed-weakening");
  });

  // mutable:[paths] + ONLY the rfcsDir rebind → isolated accept (the frozen
  // subkey is stripped even though `paths` itself is mutable).
  it("P-C10: mutable:[paths] + isolated rfcsDir rebind → accept lands", async () => {
    const f = fx({
      extraFiles: {
        "forge.yaml": forgeYaml({
          topPaths: "{ rfcsDir: docs/rfcs }",
          append: "policy:\n  mutable: [paths]\n",
        }),
      },
    });
    f.write(
      "forge.yaml",
      forgeYaml({
        topPaths: "{ rfcsDir: docs/rfcs-evil }",
        append: "policy:\n  mutable: [paths]\n",
      }),
    );
    f.commit("session rebinds rfcsDir only");
    const r = await gate(f, { acceptWeakening: "operator accepts" });
    expect(r.acceptedWeakening).not.toBeNull();
    expect(r.status).toBe("pass");
  });

  // `paths` non-map at base (`paths: "scalar"`), head adds {rfcsDir} —
  // the judged add is reported but the strip leaves scalar-vs-empty → refuse.
  it("CX-112c: paths scalar at base → paths:{rfcsDir} at HEAD → dead-end accept", async () => {
    const f = fx({
      extraFiles: { "forge.yaml": forgeYaml({ topPaths: '"scalar"' }) },
    });
    f.write("forge.yaml", forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs-evil }" }));
    f.commit("session retypes paths and adds rfcsDir");
    const r = await gate(f, { acceptWeakening: "operator accepts" });
    expect(r.acceptedWeakening).toBeNull();
    expect(r.messages.join("\n")).toContain("mixed-weakening");
  });

  // policyOnly + declared policy: rfcsDir rebind under additive:[paths] is a
  // policy-key weakening — still strippable (paths deleted as non-mutable).
  it("P-C11: --policy-only + additive:[paths] + rfcsDir rebind → accept lands", async () => {
    const f = fx({
      extraFiles: {
        "forge.yaml": forgeYaml({
          topPaths: "{ rfcsDir: docs/rfcs }",
          append: "policy:\n  mutable: [project]\n  additive: [paths]\n",
        }),
      },
    });
    f.write(
      "forge.yaml",
      forgeYaml({
        topPaths: "{ rfcsDir: docs/rfcs-evil }",
        append: "policy:\n  mutable: [project]\n  additive: [paths]\n",
      }),
    );
    f.commit("session rebinds rfcsDir under additive paths");
    const r = await gate(f, { acceptWeakening: "operator accepts", policyOnly: true });
    expect(r.weakenings.length).toBeGreaterThan(0);
    expect(r.acceptedWeakening).not.toBeNull();
    expect(r.status).toBe("pass");
  });
});

describe("r16: misc regressions", () => {
  // `paths.rfcsDir` change to a non-map paths value judged as binding weakening.
  it("P-D1: paths retyped map→scalar drops rfcsDir → binding weakening", async () => {
    const f = fx({
      extraFiles: { "forge.yaml": forgeYaml({ topPaths: "{ rfcsDir: docs/rfcs }" }) },
    });
    f.write("forge.yaml", forgeYaml({ topPaths: '"scalar"' }));
    f.commit("session retypes paths");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(
      r.weakenings.some((w) => w.kind === "binding" && w.message.includes("paths.rfcsDir")),
    ).toBe(true);
  });

  // A legal additive path addition rides an accepted rfcsDir weakening —
  // documented additive semantics (the add is not a weakening).
  it("P-D2: additive:[paths] + legal new leaf + rfcsDir rebind → accept covers both", async () => {
    const f = fx({
      extraFiles: {
        "forge.yaml": forgeYaml({
          topPaths: "{ rfcsDir: docs/rfcs }",
          append: "policy:\n  mutable: [project]\n  additive: [paths]\n",
        }),
      },
    });
    f.write(
      "forge.yaml",
      forgeYaml({
        topPaths: "{ rfcsDir: docs/rfcs-evil, newLegal: x }",
        append: "policy:\n  mutable: [project]\n  additive: [paths]\n",
      }),
    );
    f.commit("session rebinds rfcsDir and adds a legal additive leaf");
    const r = await gate(f, { acceptWeakening: "operator accepts" });
    expect(r.acceptedWeakening).not.toBeNull();
    expect(r.status).toBe("pass");
  });
});
