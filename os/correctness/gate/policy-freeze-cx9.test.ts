/*
RFC-1615 acceptance verification — round 8 (independent adversarial probe).

Targets: residual gaps in the CX-35/36/37/38/39/41/46 fixes and NEW attack
classes not covered by the shipped policy-freeze{,-cx,-cx2,-cx3,-cx4} suites.

Conventions: every `it` asserts the EXPECTED contract — a failure is a
counterexample. Candidate CX numbering starts at CX-47.

 Candidate classes probed:
  R8-A  schemaProbe parity (CX-35 residual): aliased (DAG-shared) objects
        collapse to null because `seen` never unwinds — fabricated configError
        (CORR-GATE-01) on configs loadForgeConfig accepts; tagged YAML scalars
        (Date/Map/Set/binary) in z.record fields probe to {} and mask real
        schema failures.
  R8-B  oracleTimeoutMs (CX-39 residual): Number.isFinite admits finite
        values > 2^31-1 — Node setTimeout clamps them to ~1ms — fabricated
        CORR-GATE-07 timeout; sub-millisecond fractions same class.
  R8-C  accept-isolation (CX-24 residual): `mutable: [bindings]`/`[paths]`
        keeps the parent in the strip — frozen-subkey diffs (checkRun,
        correctnessManifest, oracleReviewsDir) make forge.yaml foreign →
        mixed-weakening dead-end.
  R8-D  freezeFiles matching forge.yaml itself: policyFiles membership makes
        forge.yaml unconditionally "frozen path" — mutable edits refused as
        policy-file AND the isolation content-diff is bypassed.
  R8-E  CX-37 residual anchor contours (committed-vs-worktree, moves,
        duplicate copies).
  R8-F  CX-38/41 residual: inert-policy note on every contour, exactly once.
  R8-G  CX-46 residual: non-map forge.yaml at base/head — structured CORR-01.
  R8-H  CX-36 residual: policy adoption inside an accepted-weakening session.
  R8-I  new classes: compassDocs non-string crash, `!`-negation support glob,
        chmod-only diffs on frozen files, __proto__/merge-key additions,
        whitespace accept reason, symlink forge.yaml.
*/
import { rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  policyWeakenings,
  sideFrom,
  type CorrectnessSide,
  type FrozenSet,
} from "./frozen.ts";
import { runCorrectnessGate } from "./run.ts";
import { settingsFromForgeDoc } from "../workspace.ts";
import { parseForgeConfigDocument } from "../../../src/config/forge-config.ts";
import { makeGateFixture, type GateFixture } from "./tests/gate-fixture.ts";

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
    baseFiles: [],
    policyGlobs: [],
    policyFiles: [],
  };
}
const headOf = (yaml: string): CorrectnessSide => sideFrom(yaml, () => null);
const docOf = (yaml: string) => sideFrom(yaml, () => null).forgeDoc;
const weak = (base: string, head: string) => policyWeakenings(frozenOf(base), headOf(head));

// ---------------------------------------------------------------------------
// E2E helpers
// ---------------------------------------------------------------------------

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
  opts: { policyOnly?: boolean; acceptWeakening?: string; base?: string } = {},
) => {
  const out = await runCorrectnessGate(f.root, {
    base: opts.base ?? f.base,
    bundleDir: `${f.root}/.bundles`,
    policyOnly: opts.policyOnly,
    acceptWeakening: opts.acceptWeakening,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out;
};

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

/** Rewrite the fixture's forge.yaml wholesale and commit — returns the new base sha. */
const rebaseForgeYaml = (f: GateFixture, yaml: string): string => {
  f.write("forge.yaml", yaml);
  return f.commit("custom forge.yaml base");
};

const realAccepts = (yaml: string): boolean => {
  try {
    parseForgeConfigDocument(yaml, "forge.yaml");
    return true;
  } catch {
    return false;
  }
};

// ===========================================================================
// R8-A — CX-35 residual: schemaProbe parity gaps
// ===========================================================================

describe("R8-A: schemaProbe parity vs loadForgeConfig", () => {
  it("CX-50a: YAML alias (DAG share) into `paths` fabricates configError", () => {
    const yaml = `schema: forge/config@1
project:
  name: probe
extra: &cfg
  rfcsDir: docs/rfcs
paths: *cfg
`;
    expect(realAccepts(yaml), "loadForgeConfig must accept this file").toBe(true);
    const s = settingsFromForgeDoc(docOf(yaml), false);
    expect(
      s.configError,
      "aliased paths: probe collapsed the shared node to null — fabricated schema failure",
    ).toBeNull();
  });

  it("CX-50b: alias into an OPTIONAL object field (`bindings`) also fabricates", () => {
    const yaml = `schema: forge/config@1
project:
  name: probe
paths: {}
shared: &b
  schema: forge/bindings@1
  commands: {}
  paths: {}
bindings: *b
`;
    expect(realAccepts(yaml)).toBe(true);
    expect(settingsFromForgeDoc(docOf(yaml), false).configError).toBeNull();
  });

  it("CX-50c: alias into `correctness` (z.record) fabricates", () => {
    const yaml = `schema: forge/config@1
project:
  name: probe
paths: {}
shared: &c
  mode: enforce
correctness: *c
`;
    expect(realAccepts(yaml)).toBe(true);
    const s = settingsFromForgeDoc(docOf(yaml), false);
    expect(s.configError).toBeNull();
    expect(s.mode, "aliased correctness.mode must still read enforce").toBe("enforce");
  });

  it("CX-49a: tagged scalar in a z.record field — correctness: !!timestamp masks configError", () => {
    const yaml = `schema: forge/config@1
project:
  name: probe
paths: {}
correctness: !!timestamp 2026-01-01
`;
    expect(realAccepts(yaml), "loadForgeConfig must REJECT this file").toBe(false);
    expect(
      settingsFromForgeDoc(docOf(yaml), false).configError,
      "probe turned !!timestamp into {} — the real schema failure is masked",
    ).not.toBeNull();
  });

  it("CX-49b: bindings.terminology: !!timestamp masks configError", () => {
    const yaml = `schema: forge/config@1
project:
  name: probe
paths: {}
bindings:
  schema: forge/bindings@1
  commands: {}
  paths: {}
  terminology: !!timestamp 2026-01-01
`;
    expect(realAccepts(yaml)).toBe(false);
    expect(settingsFromForgeDoc(docOf(yaml), false).configError).not.toBeNull();
  });

  it("consistency: bindings.terminology: !!binary — numeric leaves fail the string record on BOTH flavors (parity)", () => {
    const yaml = `schema: forge/config@1
project:
  name: probe
paths: {}
bindings:
  schema: forge/bindings@1
  commands: {}
  paths: {}
  terminology: !!binary eA==
`;
    expect(realAccepts(yaml)).toBe(false);
    expect(settingsFromForgeDoc(docOf(yaml), false).configError).not.toBeNull();
  });

  it("CX-49c: formal.tools: !!omap masks configError", () => {
    const yaml = `schema: forge/config@1
project:
  name: probe
paths: {}
formal:
  tools: !!omap [a: 1]
`;
    expect(realAccepts(yaml)).toBe(false);
    expect(settingsFromForgeDoc(docOf(yaml), false).configError).not.toBeNull();
  });

  it("CX-35 verify: a real schema failure still reports configError", () => {
    const yaml = `schema: forge/config@1
project:
  name: 5
paths: {}
`;
    expect(realAccepts(yaml)).toBe(false);
    expect(settingsFromForgeDoc(docOf(yaml), false).configError).not.toBeNull();
  });

  it("CX-50d e2e: committed aliased-paths forge.yaml — enforce gate fabricates CORR-GATE-01", async () => {
    const f = fx({});
    const base2 = rebaseForgeYaml(
      f,
      `schema: forge/config@1
project:
  name: gate-fixture
extra: &cfg
  rfcsDir: docs/rfcs
paths: *cfg
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
`,
    );
    f.commit("no change");
    const { result } = await gate(f, { base: base2 });
    // loadForgeConfig accepts this file — nothing should fail. The
    // inert-policy note is a CORR-GATE-01 *warning* by contract (CX-34/41)
    // — filter the fabricated-configError class this probe targets.
    expect(
      result.violations.filter((v) => v.rule === "CORR-GATE-01" && v.severity === "error"),
      `violations: ${JSON.stringify(result.violations)}`,
    ).toEqual([]);
    expect(result.status).toBe("pass");
  });
});

// ===========================================================================
// R8-B — CX-39 residual: oracleTimeoutMs above INT32_MAX still overflows
// ===========================================================================

describe("R8-B: oracleTimeoutMs overflow (setTimeout clamp at 2^31-1)", () => {
  // Node clamps any delay > 2147483647 to ~1ms (TimeoutOverflowWarning) — the
  // isFinite guard admits them, so the oracle is killed ~immediately.
  for (const [label, value] of [
    ["3000000000", "3000000000"],
    ["9999999999999999999 (BigInt→1e19)", "9999999999999999999"],
    ["2147483648 (2^31)", "2147483648"],
  ] as const) {
    it(`CX-48: oracleTimeoutMs: ${value} fabricates a ~1ms timeout kill`, async () => {
      const f = fx({ forgeYamlAppend: `  oracleTimeoutMs: ${value}\n` });
      f.commit("no change");
      const { bundle } = await gate(f, {});
      const oracle = bundle.entries[0]?.oracles[0];
      expect(
        oracle?.timedOut,
        `oracleTimeoutMs ${label} overflowed setTimeout into a ~1ms kill — fabricated CORR-GATE-07`,
      ).toBe(false);
    });
  }

  it("CX-48b: oracleTimeoutMs: 0.5 (sub-ms fraction) fires ~1ms", async () => {
    const f = fx({ forgeYamlAppend: "  oracleTimeoutMs: 0.5\n" });
    f.commit("no change");
    const { bundle } = await gate(f, {});
    expect(bundle.entries[0]?.oracles[0]?.timedOut).toBe(false);
  });

  it("CX-39 verify: .inf / 1e999 / invalid values fall back to the default", async () => {
    for (const value of [".inf", "1e999", '"abc"', "-1", "0", ".nan", "yes"]) {
      const f = fx({ forgeYamlAppend: `  oracleTimeoutMs: ${value}\n` });
      f.commit("no change");
      const { bundle } = await gate(f, {});
      expect(
        bundle.entries[0]?.oracles[0]?.timedOut,
        `oracleTimeoutMs: ${value} must not fire`,
      ).toBe(false);
    }
  });

  it("consistency: a sane oracleTimeoutMs is honored (no fabricated timeout)", async () => {
    const f = fx({ forgeYamlAppend: "  oracleTimeoutMs: 60000\n" });
    f.commit("no change");
    const { bundle } = await gate(f, {});
    expect(bundle.entries[0]?.oracles[0]?.timedOut).toBe(false);
  });
});

// ===========================================================================
// R8-C — CX-24 residual: frozen subkeys inside a mutable-declared parent
// ===========================================================================

describe("R8-C: mutable membership of bindings/paths dead-ends the accept path", () => {
  it("CX-51a: mutable:[bindings] + checkRun rebind + --accept-weakening refuses mixed", async () => {
    const f = fx({
      forgeYamlAppend: `policy:
  mutable: [project, forge, moves, bindings]
  additive: [paths, loopMetrics]
  freezeFiles: []
`,
    });
    // Weaken the RFC-1580 frozen binding — a legal weakening-session diff.
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "node {file} --fix"'),
    );
    f.commit("rebind checkRun (weakening)");
    const { result } = await gate(f, { acceptWeakening: "operator approved rebind" });
    // The mutable membership is meaningless for the frozen subkey — the
    // weakening IS the whole diff, so isolation must accept (CX-24 contract).
    expect(result.status, `violations: ${JSON.stringify(result.violations)}`).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved rebind");
  });

  it("CX-51b: mutable:[bindings] + oracleReviewsDir rebind + accept refuses mixed", async () => {
    const f = fx({});
    const base3 = rebaseForgeYaml(
      f,
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
    oracleReviewsDir: docs/reviews-a
correctness:
  mode: enforce
  tier: standard
policy:
  mutable: [project, forge, moves, bindings]
  additive: [paths, loopMetrics]
  freezeFiles: []
`,
    );
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("docs/reviews-a", "docs/reviews-b"),
    );
    f.commit("rebind oracleReviewsDir (weakening)");
    const { result } = await gate(f, {
      base: base3,
      acceptWeakening: "operator approved rebind",
    });
    // acceptedWeakening is the discriminating signal — with the mutable-
    // membership poison the accept path dead-ends and it stays null.
    expect(
      result.acceptedWeakening,
      `violations: ${JSON.stringify(result.violations)}`,
    ).toBe("operator approved rebind");
  });

  it("CX-51c: mutable:[bindings] + correctnessManifest rebind + accept refuses mixed", async () => {
    const f = fx({
      forgeYamlAppend: `policy:
  mutable: [project, forge, moves, bindings]
  additive: [paths, loopMetrics]
  freezeFiles: []
`,
    });
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("correctnessManifest: docs/correctness.yaml", "correctnessManifest: docs/c2.yaml"),
    );
    f.write("docs/c2.yaml", f.read("docs/correctness.yaml"));
    f.commit("rebind manifest (weakening)");
    const { result } = await gate(f, { acceptWeakening: "operator approved rebind" });
    expect(result.status, `violations: ${JSON.stringify(result.violations)}`).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved rebind");
  });

  it("CX-24 verify: mutable:[policy] pure policy-decl session still accepts", async () => {
    const f = fx({
      forgeYamlAppend: `policy:
  mutable: [project, forge, moves, policy]
  additive: [bindings, paths]
  freezeFiles: []
`,
    });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("mutable: [project, forge, moves, policy]", "mutable: [project, policy]"),
    );
    f.commit("amend policy");
    const { result } = await gate(f, { policyOnly: true, acceptWeakening: "operator approved" });
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved");
  });

  it("consistency: additive:[bindings] + checkRun rebind + accept still accepts", async () => {
    const f = fx({
      forgeYamlAppend: `policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles: []
`,
    });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "node {file} --fix"'),
    );
    f.commit("rebind checkRun (weakening)");
    const { result } = await gate(f, { acceptWeakening: "operator approved rebind" });
    expect(result.status, `violations: ${JSON.stringify(result.violations)}`).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved rebind");
  });
});

// ===========================================================================
// R8-D — freezeFiles matching forge.yaml itself
// ===========================================================================

describe("R8-D: freezeFiles self-match (RFC: globs are 'outside forge.yaml')", () => {
  it("CX-52a: freezeFiles:[forge.yaml] — a declared-MUTABLE edit is refused as policy-file", async () => {
    const f = fx({
      forgeYamlAppend: `policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles: ["forge.yaml", "hooks/**"]
`,
      extraFiles: POLICY_FILES,
    });
    f.write("forge.yaml", f.read("forge.yaml").replace("name: gate-fixture", "name: renamed"));
    f.commit("legal mutable project.name change");
    const { result } = await gate(f, { policyOnly: true });
    // project is declared mutable — the byte-freeze must not double-judge it.
    expect(
      result.weakenings.filter((w) => w.kind === "policy-file"),
      `weakenings: ${JSON.stringify(result.weakenings)}`,
    ).toEqual([]);
    expect(result.status).toBe("pass");
  });

  it("CX-52b: freezeFiles:[forge.yaml] — isolation bypass: mutable+weakening in one commit accepts", async () => {
    const f = fx({
      // agentTools.deny is the frozen weakening surface this probe rides
      // alongside the mutable project.name edit (POLICY_APPEND shape).
      forgeYamlAppend: `agentTools:
  deny: [danger.cmd]
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles: ["forge.yaml", "hooks/**"]
`,
      extraFiles: POLICY_FILES,
    });
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("deny: [danger.cmd]", "deny: []")
        .replace("name: gate-fixture", "name: renamed"),
    );
    f.commit("weaken agentTools.deny AND legal project.name edit");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    // AC-6: the diff is NOT isolated to weakening content — a mutable-region
    // edit rode along. The path-whitelist (forge.yaml ∈ policyFiles) must not
    // bypass the content-diff isolation check.
    expect(
      result.violations.some((v) => v.message.includes("mixed-weakening")),
      `expected mixed-weakening; violations: ${JSON.stringify(result.violations)}`,
    ).toBe(true);
  });

  it("CX-52c: freezeFiles:['*.yaml'] covers forge.yaml — same voided mutable", async () => {
    const f = fx({
      forgeYamlAppend: `policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles: ["*.yaml"]
`,
    });
    f.write("forge.yaml", f.read("forge.yaml").replace("name: gate-fixture", "name: renamed"));
    f.commit("legal mutable project.name change");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.filter((w) => w.kind === "policy-file")).toEqual([]);
  });

  it("CX-52d: freezeFiles:['x/../forge.yaml'] normalizes to a self-match", async () => {
    const f = fx({
      forgeYamlAppend: `policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles: ["x/../forge.yaml"]
`,
    });
    f.write("forge.yaml", f.read("forge.yaml").replace("name: gate-fixture", "name: renamed"));
    f.commit("legal mutable project.name change");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.filter((w) => w.kind === "policy-file")).toEqual([]);
  });
});

// ===========================================================================
// R8-E — CX-37 residual: anchor contours
// ===========================================================================

describe("R8-E: anchorWeakenings judged at the HEAD commit", () => {
  it("CX-37 verify: committed reword masked by uncommitted revert still reports", async () => {
    const f = fx({});
    f.write(
      "apps/api/src/dispatch.ts",
      'export function dispatch(): void {\n  // @ai-invariant[INV-dispatch-01]: CHANGED statement\n  //   (checked-by: test:test/dispatch.oracle.ts)\n}\n',
    );
    f.commit("reword anchor");
    // Uncommitted revert — must NOT mask the committed weakening.
    f.write(
      "apps/api/src/dispatch.ts",
      `export function dispatch(): void {\n  // @ai-invariant[INV-dispatch-01]: dispatch moves an approved candidate to queued exactly once\n  //   (checked-by: test:test/dispatch.oracle.ts)\n}\n`,
    );
    const { result } = await gate(f, {});
    expect(result.weakenings.some((w) => w.kind === "anchor-reworded")).toBe(true);
  });

  it("CX-37 verify: uncommitted reword does not fabricate a weakening", async () => {
    const f = fx({});
    // Commit something unrelated so HEAD is judgeable, then dirty the anchor.
    f.commit("no change");
    f.write(
      "apps/api/src/dispatch.ts",
      'export function dispatch(): void {\n  // @ai-invariant[INV-dispatch-01]: CHANGED statement\n  //   (checked-by: test:test/dispatch.oracle.ts)\n}\n',
    );
    const { result } = await gate(f, {});
    expect(result.weakenings.filter((w) => w.kind.startsWith("anchor-"))).toEqual([]);
  });

  it("E3: anchor moved to a non-source-candidate file reports anchor-removed", async () => {
    const f = fx({});
    f.write(
      "apps/api/src/dispatch.ts",
      "export function dispatch(): void {}\n",
    );
    f.write(
      "docs/anchor-notes.md",
      "# notes\n\n@ai-invariant[INV-dispatch-01]: dispatch moves an approved candidate to queued exactly once\n",
    );
    f.commit("move anchor into markdown");
    const { result } = await gate(f, {});
    expect(result.weakenings.some((w) => w.kind === "anchor-removed")).toBe(true);
  });

  it("E4: HEAD duplicate same-id with a reworded copy reports anchor-reworded", async () => {
    const f = fx({});
    f.write(
      "apps/api/src/duplicate.ts",
      'export function dup(): void {\n  // @ai-invariant[INV-dispatch-01]: DIFFERENT statement\n  //   (checked-by: test:test/dispatch.oracle.ts)\n}\n',
    );
    f.commit("add reworded duplicate anchor");
    const { result } = await gate(f, {});
    expect(result.weakenings.some((w) => w.kind === "anchor-reworded")).toBe(true);
  });

  it("E5: HEAD duplicate same-id with identical statement is not a weakening", async () => {
    const f = fx({});
    f.write(
      "apps/api/src/duplicate.ts",
      'export function dup(): void {\n  // @ai-invariant[INV-dispatch-01]: dispatch moves an approved candidate to queued exactly once\n  //   (checked-by: test:test/dispatch.oracle.ts)\n}\n',
    );
    f.commit("add identical duplicate anchor");
    const { result } = await gate(f, {});
    expect(result.weakenings.filter((w) => w.kind.startsWith("anchor-"))).toEqual([]);
  });
});

// ===========================================================================
// R8-F — CX-38/41 residual: the inert-policy note on every contour
// ===========================================================================

describe("R8-F: inert-policy note emission", () => {
  const NOTES = [
    "no policy surface declared — policy checks inert (adopt policy: to arm them)",
    "no policy surface declared at --base — policy checks inert for this diff; the HEAD-adopted policy: binds the next integration",
  ];
  const countNotes = (vs: { rule: string; message: string }[]) =>
    vs.filter((v) => v.rule === "CORR-GATE-01" && NOTES.some((n) => v.message === n)).length;

  it("F1: exempt×exempt + no policy → note exactly once + status exempt", async () => {
    const f = fx({ mode: "exempt" });
    f.commit("no change");
    const { result } = await gate(f, {});
    expect(result.status).toBe("exempt");
    expect(countNotes(result.violations)).toBe(1);
  });

  it("F2: enforce contour + no policy → note exactly once", async () => {
    const f = fx({});
    f.commit("no change");
    const { result } = await gate(f, {});
    expect(countNotes(result.violations)).toBe(1);
  });

  it("F3: --policy-only + no policy → note once + pass", async () => {
    const f = fx({});
    f.commit("no change");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.status).toBe("pass");
    expect(countNotes(result.violations)).toBe(1);
  });

  it("F4: base no-policy + HEAD adopts malformed policy → CORR-GATE-01 error, note text honest", async () => {
    const f = fx({});
    f.write("forge.yaml", `${f.read("forge.yaml")}policy: [not-a-map]\n`);
    f.commit("adopt malformed policy");
    const { result } = await gate(f, { policyOnly: true });
    expect(
      result.violations.some(
        (v) => v.rule === "CORR-GATE-01" && v.severity === "error" && v.message.includes("malformed"),
      ),
    ).toBe(true);
    // The note must not claim the adopted policy "binds the next integration"
    // — a malformed declaration refuses NOW, it binds nothing.
    const note = result.violations.find((v) => v.message.includes("no policy surface declared"));
    expect(
      note === undefined || !note.message.includes("binds the next integration"),
      `misleading note: ${note?.message}`,
    ).toBe(true);
  });
});

// ===========================================================================
// R8-G — CX-46 residual: non-map forge.yaml
// ===========================================================================

describe("R8-G: non-map forge.yaml at base/head → structured CORR-GATE-01", () => {
  for (const [label, content] of [
    ["scalar", "just a string\n"],
    ["array", "- a\n- b\n"],
    ["comment-only", "# nothing else\n"],
    ["yaml null", "~\n"],
    ["binary garbage", "\x00\x01\x02\xff\xfe\n"],
  ] as const) {
    it(`base forge.yaml = ${label} refuses CORR-GATE-01 (no crash)`, async () => {
      const f = fx({});
      const base2 = rebaseForgeYaml(f, content);
      f.commit("no change");
      const { result } = await gate(f, { base: base2 });
      expect(
        result.violations.some(
          (v) => v.rule === "CORR-GATE-01" && v.severity === "error",
        ),
        `violations: ${JSON.stringify(result.violations)}`,
      ).toBe(true);
      expect(result.status).toBe("fail");
    });

    it(`head forge.yaml = ${label} refuses CORR-GATE-01`, async () => {
      const f = fx({});
      f.write("forge.yaml", content);
      f.commit("corrupt forge.yaml");
      const { result } = await gate(f, {});
      expect(
        result.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error"),
      ).toBe(true);
      expect(result.status).toBe("fail");
    });
  }

  it("head forge.yaml as symlink refuses (blob = link target → non-map)", async () => {
    const f = fx({});
    f.git(["rm", "-q", "forge.yaml"]);
    writeFileSync(`${f.root}/other.yaml`, f.read("docs/correctness.yaml"));
    // Re-create as a symlink via git (commit the link object).
    const { symlinkSync } = await import("node:fs");
    symlinkSync("other.yaml", `${f.root}/forge.yaml`);
    f.git(["add", "forge.yaml", "other.yaml"]);
    f.git(["commit", "-qm", "forge.yaml as symlink"]);
    const { result } = await gate(f, {});
    expect(
      result.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error"),
    ).toBe(true);
  });
});

// ===========================================================================
// R8-H — CX-36 residual: policy adoption inside accepted-weakening sessions
// ===========================================================================

describe("R8-H: --accept-weakening with a legal policy: adoption", () => {
  it("CX-36 verify: adoption + oracle-file weakening + accept → accepted", async () => {
    const f = fx({});
    f.write(
      "forge.yaml",
      `${f.read("forge.yaml")}policy:\n  mutable: [project]\n  additive: []\n  freezeFiles: []\n`,
    );
    f.write("test/dispatch.oracle.ts", "// weakened oracle\n");
    f.commit("adopt policy + weaken oracle");
    const { result } = await gate(f, { acceptWeakening: "operator approved" });
    expect(
      result.violations.some((v) => v.message.includes("mixed-weakening")),
      `violations: ${JSON.stringify(result.violations)}`,
    ).toBe(false);
    expect(result.acceptedWeakening).toBe("operator approved");
  });

  it("adoption + foreign file + accept → mixed-weakening refused", async () => {
    const f = fx({});
    f.write(
      "forge.yaml",
      `${f.read("forge.yaml")}policy:\n  mutable: [project]\n  additive: []\n  freezeFiles: []\n`,
    );
    f.write("src/foreign.ts", "export const x = 1;\n");
    f.commit("adopt policy + foreign file");
    const { result } = await gate(f, { acceptWeakening: "operator approved" });
    // A clean adoption+foreign commit is not itself a weakening — the accept
    // path is never reached; the run must not refuse either.
    expect(result.weakenings.length === 0 || result.acceptedWeakening === null).toBe(true);
  });

  it("adoption where the adopted policy is malformed → CORR-GATE-01, not silently accepted", async () => {
    const f = fx({});
    f.write("forge.yaml", `${f.read("forge.yaml")}policy: 5\n`);
    f.commit("adopt malformed policy");
    const { result } = await gate(f, { acceptWeakening: "operator approved" });
    expect(
      result.violations.some(
        (v) => v.rule === "CORR-GATE-01" && v.severity === "error",
      ),
    ).toBe(true);
    expect(result.status).toBe("fail");
  });
});

// ===========================================================================
// R8-I — new classes
// ===========================================================================

describe("R8-I: new counterexample classes", () => {
  it("CX-47: base compassDocs with a non-string member crashes the gate (TypeError)", async () => {
    const f = fx({});
    const base2 = rebaseForgeYaml(
      f,
      `schema: forge/config@1
project:
  name: gate-fixture
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
  paths:
    compassDocs: [1]
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: enforce
`,
    );
    f.commit("no change");
    // Expected: structured refusal (CORR-GATE-01), never an uncaught throw.
    let outcome;
    try {
      outcome = await gate(f, { base: base2 });
    } catch (err) {
      throw new Error(`gate crashed instead of structured refusal: ${(err as Error).message}`);
    }
    expect(
      outcome.result.violations.some((v) => v.rule === "CORR-GATE-01"),
    ).toBe(true);
  });

  it("CX-53: manifest support:['!x'] negation glob freezes the complement", async () => {
    const f = fx({});
    // Rewrite the manifest's support list with a negation glob at base.
    f.write(
      "docs/correctness.yaml",
      f.read("docs/correctness.yaml").replace("support: []", 'support: ["!docs/**"]'),
    );
    const base2 = f.commit("support negation glob");
    // A file NOT under docs/** — it silently entered the frozen set via the
    // negation complement. Touching it must not fabricate a frozen-file
    // weakening: a `!`-glob in `support` is malformed-class, same rule as
    // the CX-23 freezeFiles negation.
    // Append (keep the anchor comment intact) — the only signal should be the
    // byte diff, so a frozen-file weakening here is purely the negation
    // complement at work.
    f.write(
      "apps/api/src/dispatch.ts",
      `${f.read("apps/api/src/dispatch.ts")}// touched\n`,
    );
    f.commit("touch code");
    const { result } = await gate(f, { base: base2 });
    expect(
      result.weakenings.filter((w) => w.subject === "apps/api/src/dispatch.ts"),
      `weakenings: ${JSON.stringify(result.weakenings)}`,
    ).toEqual([]);
  });

  it("CX-54: chmod-only diff on a frozen file is invisible to every weakening kind", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.git(["update-index", "--chmod=+x", "hooks/integration-gate.sh"]);
    // Commit the index DIRECTLY — `f.commit` runs `git add -A` first, which
    // restages the 644 worktree mode and discards the staged chmod.
    f.git(["commit", "-qm", "chmod +x frozen hook"]);
    const { result } = await gate(f, { policyOnly: true });
    // The tracked mode changed — `git diff` reports it — but blob equality
    // means no weakening kind ever fires.
    expect(
      result.weakenings.filter((w) => w.subject === "hooks/integration-gate.sh"),
      `chmod diff unjudged; weakenings: ${JSON.stringify(result.weakenings)}`,
    ).not.toEqual([]);
  });

  it("CX-13 verify: __proto__ as a new top-level key is policy-key", () => {
    const w = weak(BASE_YAML, `${BASE_YAML}__proto__: {x: 1}\n`);
    expect(w.some((x) => x.kind === "policy-key")).toBe(true);
  });

  it("constructor/prototype as new top-level keys are policy-key", () => {
    for (const k of ["constructor", "prototype", "hasOwnProperty", "toString"]) {
      const w = weak(BASE_YAML, `${BASE_YAML}${k}: {x: 1}\n`);
      expect(w.some((x) => x.kind === "policy-key"), `key ${k}`).toBe(true);
    }
  });

  it("<< merge-key line added at HEAD is a policy-key (new top-level key)", () => {
    const w = weak(BASE_YAML, `${BASE_YAML}<<:\n  agentTools: {deny: []}\n`);
    expect(w.some((x) => x.kind === "policy-key" || x.kind === "policy-decl")).toBe(true);
  });

  it("--accept-weakening '   ' (whitespace) refuses like an absent reason", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 1\n");
    f.commit("weaken hook");
    const { result } = await gate(f, { policyOnly: true, acceptWeakening: "   " });
    expect(result.status).toBe("fail");
    expect(result.acceptedWeakening).toBeNull();
  });

  it("frozen file renamed INSIDE its glob reports delete+add weakenings", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.git(["mv", "hooks/integration-gate.sh", "hooks/renamed-gate.sh"]);
    f.commit("rename frozen hook");
    const { result } = await gate(f, { policyOnly: true });
    const subs = result.weakenings.map((w) => w.subject);
    expect(subs).toContain("hooks/integration-gate.sh");
    expect(subs).toContain("hooks/renamed-gate.sh");
  });

  it("additive leaf-addition remains free (AC-2 verify)", () => {
    const w = weak(
      BASE_YAML,
      BASE_YAML.replace('    test: "vitest run"', '    test: "vitest run"\n    newCmd: "echo hi"'),
    );
    expect(w.filter((x) => x.kind === "policy-key")).toEqual([]);
  });

  it("frozen agentTools.deny edit is policy-key (AC-1 verify)", () => {
    const w = weak(BASE_YAML, BASE_YAML.replace("deny: [danger.cmd]", "deny: []"));
    expect(w.some((x) => x.kind === "policy-key")).toBe(true);
  });

  it("policy: edit is policy-decl (AC-3 verify)", () => {
    const w = weak(
      BASE_YAML,
      BASE_YAML.replace("mutable: [project, forge, moves]", "mutable: [project]"),
    );
    expect(w.some((x) => x.kind === "policy-decl")).toBe(true);
  });

  it("new undeclared top-level key is policy-key (AC-5 verify)", () => {
    const w = weak(BASE_YAML, `${BASE_YAML}evilKey: 1\n`);
    expect(w.some((x) => x.kind === "policy-key" && x.subject === "evilKey")).toBe(true);
  });
});

// ===========================================================================
// Shipped-fix confirmation matrix — quick regression of the round-8 claims
// ===========================================================================

describe("shipped-fix confirmations", () => {
  it("CX-46 verify: non-map forge.yaml strip path — accept path not reachable, CORR-01 fires", async () => {
    const f = fx({});
    const base2 = rebaseForgeYaml(f, "- just\n- an\n- array\n");
    f.commit("no change");
    const { result } = await gate(f, { base: base2, acceptWeakening: "any" });
    expect(result.status).toBe("fail");
  });

  it("CX-37 verify (2): anchor unchanged, unrelated uncommitted edit → clean", async () => {
    const f = fx({});
    f.commit("no change");
    writeFileSync(`${f.root}/scratch.txt`, "dirty\n");
    const { result } = await gate(f, {});
    expect(result.weakenings.filter((w) => w.kind.startsWith("anchor-"))).toEqual([]);
  });

  it("CX-38/41 verify: exempt×exempt still returns exempt status (note present)", async () => {
    const f = fx({ mode: "exempt" });
    f.commit("no change");
    const { result } = await gate(f, {});
    expect(result.status).toBe("exempt");
  });
});
