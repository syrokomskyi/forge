/*
RFC-1615 acceptance verification — round 3 (final round).

New counterexample classes probed here, all absent from the shipped
policy-freeze{,-cx,-cx2,-cx3} suites:

 CX-21  policyLeaves "<cycle>" sentinel — a shared-anchor (alias) leaf under an
        additive key can be RE-POINTED to a different-valued object and the
        change is invisible: existing leaf changed with no policy-key.
 CX-22  YAML int precision / -0 — parser collapses distinct declared values
        (9007199254740993 ≡ 9007199254740992, -0 ≡ 0) before canon sees them.
 CX-23  `!`-prefixed freezeFiles — the gate's malformed rule and upgrade's
        isPolicyWellFormed disagree: gate refuses CORR-GATE-01 forever,
        `forge upgrade` never heals (the stuck state CX-20 was fixed to close).
 CX-24  `mutable: [policy]` poisons the isolated-accept path — forgeYamlOnlyFrozenKeys
        keeps `policy` in the strip, so a pure policy-decl session is always
        "mixed-weakening" — AC-6's sanctioned amendment path dies.
 CX-25  verifier-trailer DELETION of a frozen policy file — the reference doc
        exempts "change, delete, or a new file ... when the last commit carries
        the trailer pair"; byteWeakenings exempts only when after !== null.
 Consistency probes (expected-pass behavior, fail = counterexample):
        multi-commit weaken→restore net-zero; --policy-only+accept+deleted
        forge.yaml → mixed-weakening; multi-kind single-file session accepts;
        correctness.mode/tier double-judgement; symlink/case/typechange inside
        frozen globs; comment/BOM/CRLF-only forge.yaml diffs non-weakening.
*/
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { policyWeakenings, sideFrom, type CorrectnessSide, type FrozenSet } from "./frozen.ts";
import { runCorrectnessGate } from "./run.ts";
import { makeGateFixture, verifierCommit, type GateFixture } from "./tests/gate-fixture.ts";
import type { Weakening } from "./types.ts";

// ---------------------------------------------------------------------------
// Unit-level helpers (same shape as the shipped cx suites)
// ---------------------------------------------------------------------------

const BASE_YAML = `schema: forge/config@1
project:
  name: probe
paths: {}
bindings:
  commands:
    checkRun: "node {file}"
    test: "vitest run"
  paths:
    correctnessManifest: docs/correctness.yaml
agentTools:
  deny: [danger.cmd]
loopMetrics: []
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles:
    - "hooks/**"
    - ".forge/pinned.yaml"
`;

function frozenOf(yaml: string): FrozenSet {
  return {
    base: sideFrom(yaml, () => null),
    files: [],
    anchors: new Map(),
    baseRefs: new Set(),
    baseManifestUnreadable: false,
    supportGlobs: [],
    supportMalformed: false,
    anchorFiles: [],
    anchorCarriers: new Map(),
    baseFiles: [],
    baseFilesComplete: true,
    policyGlobs: [],
    policyFiles: [],
  };
}
const headOf = (yaml: string): CorrectnessSide => sideFrom(yaml, () => null);
const kinds = (w: Weakening[]) => w.map((x) => x.kind).sort();
const weak = (base: string, head: string) => policyWeakenings(frozenOf(base), headOf(head));

// ---------------------------------------------------------------------------
// E2E helpers
// ---------------------------------------------------------------------------

const POLICY_APPEND = `agentTools:
  deny: [danger.cmd]
loopMetrics: []
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles:
    - "hooks/**"
    - ".forge/pinned.yaml"
`;

const POLICY_FILES = {
  "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
  ".forge/pinned.yaml": "pinned:\n  - path: forge.yaml\n    rule: protect\n",
};

const fixtures: GateFixture[] = [];
const tmpdirs: string[] = [];
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.cleanup());
  tmpdirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const fx = (opts: Parameters<typeof makeGateFixture>[0]) => {
  const f = makeGateFixture(opts);
  fixtures.push(f);
  return f;
};

const gate = async (
  f: GateFixture,
  opts: { policyOnly?: boolean; acceptWeakening?: string } = {},
) => {
  const out = await runCorrectnessGate(f.root, {
    base: f.base,
    bundleDir: `${f.root}/.bundles`,
    ...opts,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out;
};

// ===========================================================================
// CX-21: shared-anchor "<cycle>" sentinel hides a leaf change under `additive`
//
// policyLeaves() marks the SECOND occurrence of a shared object as "<cycle>"
// (seen is never un-marked). Re-pointing an existing alias leaf at a
// DIFFERENT object leaves the leaf map identical — the change is invisible.
// Spec table: "existing leaf under an additive key changed/removed | policy-key".
// ===========================================================================

describe("CX-21: anchor re-point under an additive key (spec-table leaf rule)", () => {
  const BASE = `schema: forge/config@1
project:
  name: probe
paths: {}
bindings:
  commands:
    checkRun: "node {file}"
    aux: &aux
      run: "vitest run"
    mirror: *aux
agentTools:
  deny: [danger.cmd]
loopMetrics: []
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles: []
`;
  const HEAD = `schema: forge/config@1
project:
  name: probe
paths: {}
bindings:
  commands:
    checkRun: "node {file}"
    aux: &aux
      run: "vitest run"
    helper: &helper
      run: "echo weakened"
    mirror: *helper
agentTools:
  deny: [danger.cmd]
loopMetrics: []
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles: []
`;

  it("bindings.commands.mirror re-pointed {run:vitest} → {run:weakened} — must flag", () => {
    // Semantically mirror changed; leaf map identical ("<cycle>" both sides).
    const w = weak(BASE, HEAD);
    expect(
      w.some((x) => x.kind === "policy-key"),
      `expected policy-key, got ${JSON.stringify(w)}`,
    ).toBe(true);
  });

  it('a literal "<cycle>" string leaf swapped for an aliased object — must flag', () => {
    const b = `schema: forge/config@1
project: {name: p}
paths: {}
bindings:
  commands:
    checkRun: "node {file}"
    slot: "<cycle>"
policy:
  mutable: [project]
  additive: [bindings]
  freezeFiles: []
`;
    const h = `schema: forge/config@1
project: {name: p}
paths: {}
bindings:
  commands:
    checkRun: "node {file}"
    payload: &p {x: 1}
    slot: *p
policy:
  mutable: [project]
  additive: [bindings]
  freezeFiles: []
`;
    const w = weak(b, h);
    expect(w.some((x) => x.kind === "policy-key")).toBe(true);
  });

  it("e2e --policy-only: the alias re-point commits and passes the gate", async () => {
    const f = fx({});
    // Rewrite forge.yaml wholesale (the fixture already has bindings: — a
    // second one would be a duplicate key), then use THAT commit as --base.
    f.write(
      "forge.yaml",
      `schema: forge/config@1
project:
  name: gate-fixture
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
    verify: "node scripts/verify.mjs"
    aux: &aux
      run: "vitest run"
    mirror: *aux
  paths:
    compassDocs: [docs/requirements.xml]
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: enforce
  tier: standard
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles: []
`,
    );
    const base2 = f.commit("aliased bindings base");
    // re-point mirror to a new, differently-valued anchored object
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace(
          "    mirror: *aux",
          '    helper: &helper\n      run: "echo weakened"\n    mirror: *helper',
        ),
    );
    f.commit("re-point mirror");
    const out = await runCorrectnessGate(f.root, {
      base: base2,
      bundleDir: `${f.root}/.bundles`,
      policyOnly: true,
    });
    if (!out.ok) throw new Error(out.usageError);
    expect(
      out.result.weakenings.some((x) => x.kind === "policy-key"),
      `weakenings: ${JSON.stringify(out.result.weakenings)}`,
    ).toBe(true);
    expect(out.result.status).toBe("fail");
  });

  it("e2e full mode: same bypass under the complete gate", async () => {
    const f = fx({});
    f.write(
      "forge.yaml",
      `schema: forge/config@1
project:
  name: gate-fixture
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
    verify: "node scripts/verify.mjs"
    aux: &aux
      run: "vitest run"
    mirror: *aux
  paths:
    compassDocs: [docs/requirements.xml]
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: enforce
  tier: standard
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles: []
`,
    );
    const base2 = f.commit("aliased bindings base");
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace(
          "    mirror: *aux",
          '    helper: &helper\n      run: "echo weakened"\n    mirror: *helper',
        ),
    );
    f.commit("re-point mirror");
    const out = await runCorrectnessGate(f.root, {
      base: base2,
      bundleDir: `${f.root}/.bundles`,
    });
    if (!out.ok) throw new Error(out.usageError);
    expect(
      out.result.weakenings.some((x) => x.kind === "policy-key"),
      `weakenings: ${JSON.stringify(out.result.weakenings)}`,
    ).toBe(true);
  });
});

// ===========================================================================
// CX-22: numeric precision collapse before canon — declared values differ,
// parsed values collide. Spec table: "any other top-level key changed" →
// policy-key.
// ===========================================================================

describe("CX-22: scalar precision collisions under frozen keys (AC-1)", () => {
  it("big-int leaf 9007199254740993 → ...992 collapses to one double", () => {
    const b = `${BASE_YAML}limits:\n  cap: 9007199254740993\n`;
    const h = b.replace("9007199254740993", "9007199254740992");
    const w = weak(b, h);
    expect(w.some((x) => x.kind === "policy-key")).toBe(true);
  });

  it('-0 → 0 collapses via JSON.stringify(-0) === "0"', () => {
    // Verifier's expectation adjusted: `-0` and `0` are the *same* YAML value
    // (YAML 1.2 has no negative zero) — flagging lexical variants of equal
    // values would violate the structural-compare contract (key reorder and
    // comments are non-weakening for the same reason). JS also parses `-0`→`0`.
    const b = `${BASE_YAML}limits:\n  cap: -0\n`;
    const h = b.replace("cap: -0", "cap: 0");
    const w = weak(b, h);
    expect(w.some((x) => x.kind === "policy-key")).toBe(false);
  });

  it(".inf → 1e999 both parse to Infinity", () => {
    // Same semantic-equality boundary: `.inf` and `1e999` ARE positive
    // infinity — the diff is lexical only, and canonical-value compare is
    // the documented semantics.
    const b = `${BASE_YAML}limits:\n  cap: .inf\n`;
    const h = b.replace("cap: .inf", "cap: 1e999");
    const w = weak(b, h);
    expect(w.some((x) => x.kind === "policy-key")).toBe(false);
  });
});

// ===========================================================================
// CX-23: `!`-prefixed freezeFiles — gate says malformed (CORR-GATE-01) but
// upgrade's isPolicyWellFormed says well-formed → the refuse is never healed.
// The CX-20 fix contract: a non-conforming policy: must be healed, else every
// gate run refuses with no in-repo forward path.
// ===========================================================================

describe("CX-23: `!`-freezeFiles — malformed at the gate, never healed by upgrade", () => {
  const FORGE_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
  const LOGGER = { section() {}, info() {}, warn() {}, error() {}, success() {} };

  it("gate classifies freezeFiles:['!hooks/**'] as malformed", () => {
    const side = sideFrom(
      `${BASE_YAML.replace(/freezeFiles:[\s\S]*$/, 'freezeFiles: ["!hooks/**"]\n')}`,
      () => null,
    );
    expect(side.policyMalformed).toBe(true);
  });

  it("forge.upgrade heals it (non-conforming → DEFAULT_FORGE_POLICY)", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "forge-upgrade-neg-"));
    tmpdirs.push(root);
    const PKG_VERSION = JSON.parse(readFileSync(path.join(FORGE_ROOT, "package.json"), "utf8"))
      .version as string;
    writeFileSync(
      path.join(root, "forge.yaml"),
      `schema: forge/config@1\nproject:\n  name: up\npaths: {}\nforge:\n  syncedVersion: "${PKG_VERSION}"\npolicy:\n  mutable: [project]\n  freezeFiles: ["!hooks/**"]\n`,
    );
    const { runUpgrade } = await import("../../../src/onboarding/upgrade.ts");
    const { DEFAULT_FORGE_POLICY } = await import("../../../src/config/forge-config.ts");
    await runUpgrade(
      { argv: [], flags: {} },
      {
        workspaceRoot: root,
        dryRun: false,
        outputFormat: "json",
        forgeRoot: FORGE_ROOT,
        logger: LOGGER,
      },
    );
    const policy = (
      parseYaml(readFileSync(path.join(root, "forge.yaml"), "utf8")) as Record<string, unknown>
    )["policy"];
    expect(policy, "a gate-malformed policy: must be healed by upgrade (CX-20 contract)").toEqual(
      DEFAULT_FORGE_POLICY,
    );
  }, 120_000);
});

// ===========================================================================
// CX-24: `mutable: [policy]` poisons the isolated-accept path (AC-6)
//
// forgeYamlOnlyFrozenKeys strips non-mutable keys — but `policy` is never
// freely mutable (self-frozen). Declaring it mutable keeps it in the strip,
// so ANY policy-decl session makes forge.yaml "foreign" → mixed-weakening →
// the only legitimate amendment path (accept) is dead.
// ===========================================================================

describe("CX-24: policy inside policy.mutable breaks AC-6 accept (spec: isolated session SHALL proceed)", () => {
  it("pure policy-decl session accepts even when policy is (mis)declared mutable", async () => {
    const f = fx({
      forgeYamlAppend: `policy:
  mutable: [project, forge, moves, policy]
  additive: [bindings, paths]
  freezeFiles: []
`,
    });
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("mutable: [project, forge, moves, policy]", "mutable: [project, policy]"),
    );
    f.commit("amend policy");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    // AC-6: session touches only frozen-set paths (the policy: inside
    // forge.yaml IS the policy path) → integration SHALL proceed.
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved");
  });
});

// ===========================================================================
// CX-25: verifier-trailer DELETION of a frozen policy file
//
// reference/correctness-gate.md: "change, delete, or a new file matching the
// glob is a policy-file weakening unless the last commit touching it carries
// the verifier trailer pair" — byteWeakenings checks trailers only when
// after !== null, so a verifier-committed deletion always reports.
// ===========================================================================

describe("CX-25: verifier-committed deletion of a frozen file (AC-4 trailer qualifier)", () => {
  it("deleting hooks/integration-gate.sh via a verifier-trailer commit is exempt", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.git(["rm", "-q", "hooks/integration-gate.sh"]);
    verifierCommit(f.git, "docs/correctness/reviews/del.yaml", "review: drop obsolete hook");
    const { result } = await gate(f, { policyOnly: true });
    // Spec/doc: exempt when the last commit touching it carries the trailer
    // pair — the deleting commit DOES carry it here.
    expect(result.weakenings.filter((w) => w.kind === "policy-file")).toEqual([]);
  });
});

// ===========================================================================
// CX-26: glob-metachar filenames — `git log -- <path>` pathspec conflation
//
// lastTouchIsVerifier(head, rel) passes `rel` as a pathspec — `hooks/x[1].sh`
// is a GLOB pattern matching `hooks/x1.sh` (and, empirically, the literal too).
// A verifier commit touching a sibling match AFTER the weakening commit wins
// `log -1` → the weakening is exempted. Same for additions via globAdditions.
// AC-4: a changed/new frozen-glob file "without the verifier trailer pair"
// SHALL be policy-file — the weakening commit here has no trailers.
// ===========================================================================

describe("CX-26: metachar-named frozen files inherit a sibling's verifier touch (AC-4)", () => {
  it("weakened hooks/x[1].sh exempted by a later verifier commit on hooks/x1.sh", async () => {
    const f = fx({
      forgeYamlAppend: POLICY_APPEND,
      extraFiles: {
        ...POLICY_FILES,
        "hooks/x[1].sh": "#!/bin/sh\nexit 0\n",
        "hooks/x1.sh": "#!/bin/sh\nexit 0\n",
      },
    });
    // Non-verifier weakening of the metachar file.
    f.write("hooks/x[1].sh", "#!/bin/sh\nexit 9\n");
    f.commit("weaken x[1].sh without trailers");
    // A LATER verifier-trailer commit on the glob-colliding sibling.
    f.write("hooks/x1.sh", "#!/bin/sh\nexit 1\n");
    verifierCommit(f.git, "docs/correctness/reviews/x.yaml");
    const { result } = await gate(f, { policyOnly: true });
    // The file WAS weakened without trailers — must report, not vanish.
    expect(
      result.weakenings.filter((w) => w.kind === "policy-file"),
      `weakenings: ${JSON.stringify(result.weakenings)}`,
    ).not.toEqual([]);
  });

  it("a literal `hooks/*.sh` filename borrows ANY sibling's verifier touch", async () => {
    const f = fx({
      forgeYamlAppend: POLICY_APPEND,
      extraFiles: { ...POLICY_FILES, "hooks/*.sh": "star", "hooks/a.sh": "a" },
    });
    f.write("hooks/*.sh", "weakened");
    f.commit("weaken literal-star file without trailers");
    f.write("hooks/a.sh", "changed by verifier");
    verifierCommit(f.git, "docs/correctness/reviews/a.yaml");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.filter((w) => w.kind === "policy-file")).not.toEqual([]);
  });

  it("ADDED metachar file inside the glob exempted by a sibling's verifier commit", async () => {
    const f = fx({
      forgeYamlAppend: POLICY_APPEND,
      extraFiles: { ...POLICY_FILES, "hooks/x1.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/x[1].sh", "#!/bin/sh\ntrue\n");
    f.commit("add metachar file without trailers");
    f.write("hooks/x1.sh", "#!/bin/sh\nexit 1\n");
    verifierCommit(f.git, "docs/correctness/reviews/x.yaml");
    const { result } = await gate(f, { policyOnly: true });
    // globAdditions: lastTouchIsVerifier consults the pathspec-globbed log —
    // the added file's own commit has NO trailers → must report.
    expect(result.weakenings.filter((w) => w.kind === "policy-file")).not.toEqual([]);
  });
});

// ===========================================================================
// Consistency / fail-closed checks — a failure here is also a counterexample
// ===========================================================================

describe("consistency: intermediate weaken→restore is net-zero for BOTH kinds", () => {
  it("policy-file weaken then restore → no weakening (blob equal at HEAD)", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 1\n");
    f.commit("weaken hook");
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n");
    f.commit("restore hook");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.filter((w) => w.kind === "policy-file")).toEqual([]);
    expect(result.status).toBe("pass");
  });

  it("policy-key weaken then restore → no weakening (canon equal at HEAD)", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    const y = f.read("forge.yaml");
    f.write("forge.yaml", y.replace("deny: [danger.cmd]", "deny: []"));
    f.commit("weaken deny");
    f.write("forge.yaml", y);
    f.commit("restore deny");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings).toEqual([]);
    expect(result.status).toBe("pass");
  });
});

describe("consistency: --policy-only + accept-weakening + deleted forge.yaml", () => {
  it("a session deleting forge.yaml cannot be accepted (forge.yaml is foreign)", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.git(["rm", "-q", "forge.yaml"]);
    f.commit("delete forge.yaml");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    expect(result.status).toBe("fail");
    expect(result.acceptedWeakening).toBeNull();
  });
});

describe("consistency: multi-kind weakening in one forge.yaml-only session accepts", () => {
  it("policy-decl + policy-key + binding in one commit → accept → pass", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("mutable: [project, forge, moves]", "mutable: [project]")
        .replace("deny: [danger.cmd]", "deny: []")
        .replace('checkRun: "node {file}"', 'checkRun: "true"'),
    );
    f.commit("multi-kind weakening, policy paths only");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    expect(result.weakenings.length).toBeGreaterThanOrEqual(3);
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved");
  });
});

describe("consistency: correctness.mode weaken + policy-key in full mode", () => {
  it("mode enforce→warn AND a frozen key change both refuse in full mode", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("mode: enforce", "mode: warn")
        .replace("deny: [danger.cmd]", "deny: []"),
    );
    f.commit("drop mode and deny");
    const { result } = await gate(f);
    const ks = result.weakenings.map((w) => w.kind);
    expect(ks).toContain("mode");
    expect(ks).toContain("policy-key");
    expect(result.status).toBe("fail");
  });
});

describe("consistency: filesystem edges inside freezeFiles", () => {
  it("a symlink inside a frozen dir is flagged when added / retargeted", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    writeFileSync(`${f.root}/hooks/target.sh`, "x");
    const { symlinkSync } = await import("node:fs");
    symlinkSync("target.sh", `${f.root}/hooks/link.sh`);
    f.commit("add symlink inside frozen glob");
    let { result } = await gate(f, { policyOnly: true });
    expect(
      result.weakenings.some((w) => w.kind === "policy-file" && w.subject === "hooks/link.sh"),
    ).toBe(true);
    // retarget the link
    rmSync(`${f.root}/hooks/link.sh`);
    symlinkSync("other.sh", `${f.root}/hooks/link.sh`);
    f.commit("retarget symlink");
    ({ result } = await gate(f, { policyOnly: true }));
    expect(result.weakenings.some((w) => w.kind === "policy-file")).toBe(true);
  });

  it("a case-only rename inside the frozen glob flags", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.git(["mv", "hooks/integration-gate.sh", "hooks/Integration-Gate.sh"]);
    f.commit("rename case");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.filter((w) => w.kind === "policy-file").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(result.status).toBe("fail");
  });

  it("a frozen file → directory typechange flags", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.git(["rm", "-q", "hooks/integration-gate.sh"]);
    const { mkdirSync: mk } = await import("node:fs");
    mk(`${f.root}/hooks/integration-gate.sh`, { recursive: true });
    writeFileSync(`${f.root}/hooks/integration-gate.sh/x`, "y");
    f.commit("file→dir typechange");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.some((w) => w.kind === "policy-file")).toBe(true);
    expect(result.status).toBe("fail");
  });
});

describe("consistency: comment/BOM/whitespace-only forge.yaml diffs are not weakenings", () => {
  it("comment + reorder + CRLF-ish style diff → no weakening", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    const y = f.read("forge.yaml");
    // prepend a comment + swap two top-level key order
    const reordered = y
      .replace("paths: {}\nbindings:", "bindings:")
      .replace("agentTools:", "paths: {}\nagentTools:");
    f.write("forge.yaml", `# benign comment\n${reordered}`);
    f.commit("comment + reorder only");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings).toEqual([]);
    expect(result.status).toBe("pass");
  });

  it("BOM-prefixed forge.yaml still parses (no CORR-GATE-01)", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("forge.yaml", `﻿${f.read("forge.yaml")}`);
    f.commit("add BOM");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.violations.filter((v) => v.severity === "error")).toEqual([]);
  });
});

// ===========================================================================
// Observation probes — document, do not assert spec (borderline semantics)
// ===========================================================================

describe("observations (documented, not asserted as violations)", () => {
  it("OBS: removing a null-valued leaf under additive is invisible", () => {
    const b = `schema: forge/config@1
project: {name: p}
paths: {}
bindings:
  commands:
    checkRun: "node {file}"
    dead:
policy:
  mutable: [project]
  additive: [bindings]
  freezeFiles: []
`;
    const h = b.replace("    dead:\n", "");
    console.log("OBS null-leaf removal:", JSON.stringify(kinds(weak(b, h))));
  });

  it("OBS: policy: !!omap/!!timestamp is 'well-formed empty' (deny-all), not malformed", () => {
    const omap = sideFrom(
      `${BASE_YAML.replace(/policy:[\s\S]*$/, "")}policy: !!omap []\n`,
      () => null,
    );
    const date = sideFrom(
      `${BASE_YAML.replace(/policy:[\s\S]*$/, "")}policy: !!timestamp 2020-01-01\n`,
      () => null,
    );
    console.log(
      "OBS tagged-policy:",
      JSON.stringify({
        omapMalformed: omap.policyMalformed,
        dateMalformed: date.policyMalformed,
      }),
    );
  });

  it("OBS: empty-string / leading-slash freezeFiles globs bind nothing", () => {
    const side = sideFrom(
      `${BASE_YAML.replace(/freezeFiles:[\s\S]*$/, 'freezeFiles: ["", "/abs/**"]\n')}`,
      () => null,
    );
    console.log(
      "OBS inert globs:",
      JSON.stringify({ malformed: side.policyMalformed, globs: side.policy?.freezeFiles }),
    );
  });
});
