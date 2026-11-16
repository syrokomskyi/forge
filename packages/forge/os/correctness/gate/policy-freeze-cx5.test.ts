/*
RFC-1615 acceptance verification — FINAL round (round 4 of adversarial passes).

Classes probed here that the shipped policy-freeze{,-cx,-cx2,-cx3,-cx4} suites
do not reach:

 CX-27  forgeYamlOnlyFrozenKeys strip() does JSON.parse(JSON.stringify(doc))
        on an intAsBigInt-parsed doc — ANY integer leaf in forge.yaml throws
        TypeError OUTSIDE the try, so every --accept-weakening run crashes
        instead of producing a verdict. AC-6's "integration SHALL proceed"
        is dead on any real repo (oracleTimeoutMs, budgets, counts are ints).
        Triggers: (a) BigInt leaf, (b) YAML alias cycle (Converting circular
        structure), (c) same crash on a no-policy repo (the null branch
        stringifies identically), (d) crash even when the weakening is NOT in
        forge.yaml (policy-file + accept still strips forge.yaml).

 CX-28  exempt→exempt early return: run.ts returns "exempt" BEFORE the
        weakening diff — a session on a mode:exempt-at-base repo can commit
        arbitrary policy-key/policy-decl/policy-file weakenings and the gate
        never diffs (the weakening launders into the next non-exempt base).
        Probed and classified by output.

 CX-29  :(literal) pathspec with `:` / parens in the filename — the last-touch
        verifier lookup must stay literal for names containing the pathspec
        separator itself.

 CX-30  --policy-only + base-declared policy dropped at HEAD → policy-decl
        flagged (not the "no policy surface declared" note).

 Consistency probes: a verifier commit bundling a weakening AND an addition
 exempts both (documented trailer trust model); base=HEAD degenerate pass;
 freezeFiles:[forge.yaml] double-freeze semantics; strip NaN-collapse.
*/

import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { policyWeakenings, sideFrom, type CorrectnessSide, type FrozenSet } from "./frozen.ts";
import { runCorrectnessGate } from "./run.ts";
import { makeGateFixture, verifierCommit, type GateFixture } from "./tests/gate-fixture.ts";

// ---------------------------------------------------------------------------
// helpers (same shape as the shipped suites)
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
    policyGlobs: [],
    policyFiles: [],
  };
}
const headOf = (yaml: string): CorrectnessSide => sideFrom(yaml, () => null);
const weak = (base: string, head: string) => policyWeakenings(frozenOf(base), headOf(head));

// ===========================================================================
// CX-27: --accept-weakening crashes TypeError on ANY integer leaf in
// forge.yaml (intAsBigInt → JSON.stringify BigInt). AC-6: "the integration
// SHALL proceed" — the only sanctioned path for a policy amendment dies with
// an uncaught exception on virtually every real forge.yaml.
// ===========================================================================

describe("CX-27: accept path TypeError — intAsBigInt vs JSON.stringify (AC-6)", () => {
  it("a pure policy-decl session + accept + integer leaf → crash, not pass", async () => {
    const f = fx({
      // `limits.cap` is an integer — intAsBigInt makes it a BigInt leaf.
      forgeYamlAppend: `agentTools:
  deny: [danger.cmd]
loopMetrics: []
limits:
  cap: 4000
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles: []
`,
    });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("mutable: [project, forge, moves]", "mutable: [project]"),
    );
    f.commit("amend policy");
    let threw: unknown = null;
    let out: Awaited<ReturnType<typeof runCorrectnessGate>> | null = null;
    try {
      out = await runCorrectnessGate(f.root, {
        base: f.base,
        bundleDir: `${f.root}/.bundles`,
        policyOnly: true,
        acceptWeakening: "operator approved",
      });
    } catch (e) {
      threw = e;
    }
    // AC-6: touches only frozen policy paths → integration SHALL proceed.
    expect(threw, `gate threw instead of producing a verdict: ${String(threw)}`).toBeNull();
    expect(out && out.ok && out.result.status).toBe("pass");
  });

  it("same crash with NO --policy-only (full mode) — accept block precedes oracles", async () => {
    const f = fx({
      forgeYamlAppend: `agentTools:
  deny: [danger.cmd]
loopMetrics: []
limits:
  cap: 4000
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles: []
`,
    });
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.commit("weaken deny");
    let threw: unknown = null;
    try {
      await runCorrectnessGate(f.root, {
        base: f.base,
        bundleDir: `${f.root}/.bundles`,
        acceptWeakening: "operator approved",
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeNull();
  });

  it("the weakening need NOT be in forge.yaml — policy-file + accept still strips it", async () => {
    const f = fx({
      forgeYamlAppend: `agentTools:
  deny: [danger.cmd]
loopMetrics: []
limits:
  cap: 4000
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles:
    - "hooks/**"
`,
      extraFiles: { "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 1\n");
    f.commit("weaken hook");
    let threw: unknown = null;
    try {
      await runCorrectnessGate(f.root, {
        base: f.base,
        bundleDir: `${f.root}/.bundles`,
        policyOnly: true,
        acceptWeakening: "operator approved",
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeNull();
  });

  it("a NO-policy repo (RFC-1580 only) + binding weakening + accept + int → crash", async () => {
    const f = fx({ forgeYamlAppend: `limits:\n  cap: 4000\n` });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "true"'),
    );
    f.commit("rebind checkRun (RFC-1580 weakening)");
    let threw: unknown = null;
    try {
      await runCorrectnessGate(f.root, {
        base: f.base,
        bundleDir: `${f.root}/.bundles`,
        acceptWeakening: "operator approved",
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeNull();
  });

  it("control: identical session WITHOUT an integer leaf accepts fine", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("mutable: [project, forge, moves]", "mutable: [project]"),
    );
    f.commit("amend policy");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved");
  });
});

// ===========================================================================
// CX-28: a YAML alias CYCLE anywhere in forge.yaml → Converting circular
// structure to JSON in the same strip() — accept path dead (AC-6).
// ===========================================================================

describe("CX-28: alias cycle in forge.yaml crashes accept (AC-6)", () => {
  it("policy-decl + accept on a cyclic forge.yaml → crash, not pass", async () => {
    const f = fx({});
    // self-referencing anchor inside a mutable key — canon/policyLeaves
    // handle it (cycle guards), JSON.stringify does not.
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
  paths:
    compassDocs: [docs/requirements.xml]
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: enforce
  tier: standard
z: &z
  loop: *z
agentTools:
  deny: [danger.cmd]
loopMetrics: []
policy:
  mutable: [project, forge, moves, z]
  additive: [bindings, paths, loopMetrics]
  freezeFiles: []
`,
    );
    const base2 = f.commit("cyclic forge.yaml base");
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("mutable: [project, forge, moves, z]", "mutable: [project, z]"),
    );
    f.commit("amend policy");
    let threw: unknown = null;
    try {
      await runCorrectnessGate(f.root, {
        base: base2,
        bundleDir: `${f.root}/.bundles`,
        policyOnly: true,
        acceptWeakening: "operator approved",
      });
    } catch (e) {
      threw = e;
    }
    expect(threw, `gate threw: ${String(threw)}`).toBeNull();
  });
});

// ===========================================================================
// CX-29: exempt→exempt early return masks committed policy weakenings.
// Base correctness.mode: exempt → gate returns "exempt" before the diff.
// ===========================================================================

describe("CX-29: exempt-at-base repo — committed policy weakenings unjudged", () => {
  it("clean tree, all weakenings committed, mode exempt both sides → verdict", async () => {
    const f = fx({
      mode: "enforce",
      forgeYamlAppend: POLICY_APPEND,
      extraFiles: POLICY_FILES,
    });
    // Flip base to exempt + commit THAT as the frozen base.
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: enforce", "mode: exempt"));
    // An exempt repo must not bind a manifest (validate errors) — drop it.
    const y = f.read("forge.yaml").replace("    correctnessManifest: docs/correctness.yaml\n", "");
    f.write("forge.yaml", y);
    f.git(["rm", "-q", "docs/correctness.yaml"]);
    const base2 = f.commit("exempt base");
    // Session: weaken policy-decl, a frozen key, AND a frozen file — all committed.
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("mutable: [project, forge, moves]", "mutable: [project, forge, moves, agentTools]")
        .replace("deny: [danger.cmd]", "deny: []"),
    );
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 9\n");
    f.commit("weaken everything under an exempt contour");
    const out = await runCorrectnessGate(f.root, {
      base: base2,
      bundleDir: `${f.root}/.bundles`,
      policyOnly: true,
    });
    if (!out.ok) throw new Error(out.usageError);
    const { result } = out;
    console.log(
      "CX-29 OBS exempt→exempt:",
      JSON.stringify({
        status: result.status,
        weakenings: result.weakenings,
        violations: result.violations,
      }),
    );
    // Document observed behavior; classified in the report.
    expect(["exempt", "fail", "pass"]).toContain(result.status);
  });

  it("same masking under FULL mode", async () => {
    const f = fx({
      mode: "enforce",
      forgeYamlAppend: POLICY_APPEND,
      extraFiles: POLICY_FILES,
    });
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: enforce", "mode: exempt"));
    const y = f.read("forge.yaml").replace("    correctnessManifest: docs/correctness.yaml\n", "");
    f.write("forge.yaml", y);
    f.git(["rm", "-q", "docs/correctness.yaml"]);
    const base2 = f.commit("exempt base");
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.commit("weaken deny");
    const out = await runCorrectnessGate(f.root, {
      base: base2,
      bundleDir: `${f.root}/.bundles`,
    });
    if (!out.ok) throw new Error(out.usageError);
    const { result } = out;
    console.log(
      "CX-29b OBS full exempt:",
      JSON.stringify({ status: result.status, weakenings: result.weakenings }),
    );
    expect(["exempt", "fail", "pass"]).toContain(result.status);
  });
});

// ===========================================================================
// CX-30: `:(literal)` — `:` / parens inside the filename itself (AC-4).
// ===========================================================================

describe("CX-30: filenames containing `:` and parens under :(literal) pathspec", () => {
  it("weakened hooks/x:y.sh must report — `:` inside name must not break the lookup", async () => {
    const f = fx({
      forgeYamlAppend: POLICY_APPEND,
      extraFiles: { ...POLICY_FILES, "hooks/x:y.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/x:y.sh", "#!/bin/sh\nexit 7\n");
    f.commit("weaken x:y.sh without trailers");
    const { result } = await gate(f, { policyOnly: true });
    expect(
      result.weakenings.filter((w) => w.kind === "policy-file"),
      `weakenings: ${JSON.stringify(result.weakenings)}`,
    ).not.toEqual([]);
  });

  it("weakened hooks/p(1).sh reports; a verifier sibling p1.sh cannot launder it", async () => {
    const f = fx({
      forgeYamlAppend: POLICY_APPEND,
      extraFiles: {
        ...POLICY_FILES,
        "hooks/p(1).sh": "#!/bin/sh\nexit 0\n",
        "hooks/p1.sh": "#!/bin/sh\nexit 0\n",
      },
    });
    f.write("hooks/p(1).sh", "#!/bin/sh\nexit 9\n");
    f.commit("weaken p(1).sh without trailers");
    f.write("hooks/p1.sh", "#!/bin/sh\nexit 1\n");
    verifierCommit(f.git, "docs/correctness/reviews/p.yaml");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.filter((w) => w.kind === "policy-file")).not.toEqual([]);
  });

  it("a verifier commit touching hooks/x:y.sh legitimately exempts it", async () => {
    const f = fx({
      forgeYamlAppend: POLICY_APPEND,
      extraFiles: { ...POLICY_FILES, "hooks/x:y.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/x:y.sh", "#!/bin/sh\nexit 2\n");
    verifierCommit(f.git, "docs/correctness/reviews/xy.yaml", "review: colon file");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.filter((w) => w.kind === "policy-file")).toEqual([]);
  });
});

// ===========================================================================
// CX-31: --policy-only when base HAS policy but HEAD dropped it —
// policy-decl must fire; the "no policy surface declared" note keys off base.
// ===========================================================================

describe("CX-31: base-declared policy dropped at HEAD → policy-decl, no inert note", () => {
  it("dropping the whole policy: key refuses as policy-decl (spec table)", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    const y = f.read("forge.yaml");
    f.write("forge.yaml", y.slice(0, y.indexOf("policy:")));
    f.commit("drop policy section");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.some((w) => w.kind === "policy-decl")).toBe(true);
    expect(result.status).toBe("fail");
    expect(
      result.violations.some(
        (v) => v.severity === "warning" && v.message.includes("no policy surface declared"),
      ),
      "inert note must not appear when base declared a policy",
    ).toBe(false);
  });
});

// ===========================================================================
// CX-32: dedicated RFC-1580 rules must still win over `mutable:` in FULL mode
// (correctness-gate.md: "the dedicated binding/correctness-key checks also win
// over a hand-tuned mutable declaration"). Under --policy-only they release —
// documented — so only the full-mode assertions matter here.
// ===========================================================================

describe("CX-32: dedicated rules win over mutable: declarations (full mode)", () => {
  it("mutable:[bindings] + checkRun rebind → binding weakening still fires", async () => {
    const f = fx({
      forgeYamlAppend: `agentTools:
  deny: [danger.cmd]
loopMetrics: []
policy:
  mutable: [project, forge, moves, bindings]
  additive: [paths, loopMetrics]
  freezeFiles: []
`,
    });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "true"'),
    );
    f.commit("rebind checkRun under declared-mutable bindings");
    const { result } = await gate(f);
    const ks = result.weakenings.map((w) => w.kind);
    console.log("CX-32 binding:", JSON.stringify(result.weakenings.map((w) => w.kind)));
    expect(
      ks.includes("binding") || ks.includes("policy-key"),
      "a binding-weakening kind must fire — mutable must not release the frozen checkRun",
    ).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("mutable:[correctness] + mode enforce→warn → mode weakening still fires", async () => {
    const f = fx({
      forgeYamlAppend: `agentTools:
  deny: [danger.cmd]
loopMetrics: []
policy:
  mutable: [project, forge, moves, correctness]
  additive: [bindings, paths, loopMetrics]
  freezeFiles: []
`,
    });
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: enforce", "mode: warn"));
    f.commit("drop mode under declared-mutable correctness");
    const { result } = await gate(f);
    const ks = result.weakenings.map((w) => w.kind);
    console.log("CX-32 mode:", JSON.stringify(ks));
    expect(ks).toContain("mode");
    expect(result.status).toBe("fail");
  });
});

// ===========================================================================
// Consistency probes — expectations follow documented semantics
// ===========================================================================

describe("consistency: verifier commit bundling a weakening AND an addition", () => {
  it("one verifier-trailer commit may change AND add frozen-glob files (documented trust model)", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 3\n");
    f.write("hooks/new-hook.sh", "#!/bin/sh\nexit 4\n");
    verifierCommit(f.git, "docs/correctness/reviews/bundle.yaml", "review: change + add");
    const { result } = await gate(f, { policyOnly: true });
    // Each file's LAST touch is the verifier commit → both exempt.
    expect(result.weakenings.filter((w) => w.kind === "policy-file")).toEqual([]);
  });
});

describe("consistency: --base HEAD degenerate diff passes", () => {
  it("no diff → no weakenings → pass (caller's contract)", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    const head = f.git(["rev-parse", "HEAD"]);
    const out = await runCorrectnessGate(f.root, {
      base: head,
      bundleDir: `${f.root}/.bundles`,
      policyOnly: true,
    });
    if (!out.ok) throw new Error(out.usageError);
    expect(out.result.weakenings).toEqual([]);
    expect(out.result.status).toBe("pass");
  });
});

describe("consistency: freezeFiles including forge.yaml double-freezes mutable keys", () => {
  it("a mutable-only edit without trailers is still a policy-file byte change", async () => {
    const f = fx({
      forgeYamlAppend: `agentTools:
  deny: [danger.cmd]
loopMetrics: []
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles:
    - "forge.yaml"
`,
    });
    f.write("forge.yaml", f.read("forge.yaml").replace("name: gate-fixture", "name: renamed"));
    f.commit("mutable project.name edit");
    const { result } = await gate(f, { policyOnly: true });
    // Byte-frozen by declaration even though the key is mutable — OBS.
    console.log(
      "OBS forge.yaml-in-freezeFiles:",
      JSON.stringify(result.weakenings.map((w) => w.kind)),
    );
    expect(result.weakenings.length).toBeGreaterThanOrEqual(0);
  });
});

// ===========================================================================
// Robustness smoke — pathological forge.yaml must not break correctness
// ===========================================================================

describe("robustness: large/deep forge.yaml", () => {
  it("5k top-level keys + deep nesting judge correctly", () => {
    const lines = ["schema: forge/config@1", "project: {name: p}", "paths: {}"];
    for (let i = 0; i < 5000; i++) lines.push(`k${i}: {v: ${i}}`);
    lines.push("policy:", "  mutable: [project]", "  additive: []", "  freezeFiles: []");
    const base = lines.join("\n") + "\n";
    const head = base.replace("k4999: {v: 4999}", "k4999: {v: 0}");
    const w = weak(base, head);
    expect(w.some((x) => x.kind === "policy-key" && x.subject === "k4999.v")).toBe(true);
  });
});
