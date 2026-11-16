/*
RFC-1615 acceptance probes — verifier-minimized regression checks (round 0).
Each test asserts what the RFC requires; they were failing counterexamples at
candidate a2522daa6 and now guard the fixes verbatim.
*/
import { afterEach, describe, expect, it } from "vitest";

import { policyWeakenings, sideFrom, type CorrectnessSide, type FrozenSet } from "./frozen.ts";
import { runCorrectnessGate } from "./run.ts";
import { makeGateFixture, type GateFixture } from "./tests/gate-fixture.ts";
import type { Weakening } from "./types.ts";

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
    anchorFiles: [],
    baseFiles: [],
    policyGlobs: [],
    policyFiles: [],
  };
}
const headOf = (yaml: string): CorrectnessSide => sideFrom(yaml, () => null);
const kinds = (w: Weakening[]) => w.map((x) => x.kind).sort();
const weak = (base: string, head: string) => policyWeakenings(frozenOf(base), headOf(head));

describe("CX-1 (AC-1/design): leaf-path conflation bypass", () => {
  it("moving bindings.commands.test to a literal dotted key must still flag policy-key", () => {
    // `commands.test` (nested) and `{"commands.test": x}` produce the same
    // leaf path — the semantic binding is gone but the diff must still see
    // it as a changed/removed leaf.
    const head = BASE_YAML.replace(
      '  commands:\n    checkRun: "node {file}"\n    test: "vitest run"\n',
      '  commands:\n    checkRun: "node {file}"\n  "commands.test": "vitest run"\n',
    );
    expect(kinds(weak(BASE_YAML, head))).toContain("policy-key");
  });
});

describe("CX-2 (AC-2): empty-container additions must not flag", () => {
  it("first element into an empty additive array is a new leaf, not a weakening", () => {
    // loopMetrics: [] ships in the default scaffold; the FIRST element added
    // is flagged "existing leaves changed or were removed (loopMetrics)".
    const head = BASE_YAML.replace("loopMetrics: []", "loopMetrics:\n  - id: m1");
    expect(weak(BASE_YAML, head)).toEqual([]);
  });

  it("first key into an empty additive map is a new leaf, not a weakening", () => {
    const base = BASE_YAML.replace(
      "  paths:\n    correctnessManifest: docs/correctness.yaml",
      "  paths: {}",
    );
    const head = base.replace("  paths: {}", "  paths:\n    correctnessManifest: docs/c.yaml");
    expect(weak(base, head)).toEqual([]);
  });
});

describe("CX-5 (design output format): weakening subject names the leaf", () => {
  it("subject is agentTools.deny, not agentTools", () => {
    const head = BASE_YAML.replace("deny: [danger.cmd]", "deny: []");
    const w = weak(BASE_YAML, head);
    expect(w[0]?.subject).toBe("agentTools.deny");
  });
});

const POLICY_APPEND = `agentTools:
  deny: [danger.cmd]
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
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));

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

describe("CX-1 e2e: leaf-path conflation passes --policy-only", () => {
  it("moving bindings.commands.* to literal dotted keys must be refused", async () => {
    const f = makeGateFixture({
      forgeYamlAppend: POLICY_APPEND,
      extraFiles: POLICY_FILES,
    });
    fixtures.push(f);
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace(
          '  commands:\n    checkRun: "node {file}"\n    verify: "node scripts/verify.mjs"\n',
          '  "commands.checkRun": "node {file}"\n  "commands.verify": "node scripts/verify.mjs"\n',
        ),
    );
    f.commit("respell commands with dotted keys");
    const { result } = await gate(f, { policyOnly: true });
    // The semantic bindings bindings.commands.checkRun/.verify are gone —
    // a weakening the gate must name. Observed: status pass, no violations.
    expect(result.status).toBe("fail");
    expect(result.violations.some((x) => x.rule === "CORR-GATE-02")).toBe(true);
  });
});

describe("CX-3 (AC-7): no-policy repo under --policy-only", () => {
  it("exits 0 WITH the bundle note 'no policy surface declared'", async () => {
    const f = makeGateFixture({}); // no forgeYamlAppend -> no policy:
    fixtures.push(f);
    const { result, bundle } = await gate(f, { policyOnly: true });
    expect(result.status).toBe("pass");
    const haystack = `${JSON.stringify(result)}\n${JSON.stringify(bundle)}`;
    expect(haystack).toContain("no policy surface declared");
  });
});

describe("CX-4 (AC-7): malformed policy: is CORR-GATE-01", () => {
  it("a non-object policy: at --base is a CORR-GATE-01 error, not a silent pass", async () => {
    const f = makeGateFixture({
      forgeYamlAppend: 'policy: "definitely not a policy object"\n',
    });
    fixtures.push(f);
    f.commit("no-op");
    const { result } = await gate(f, { policyOnly: true });
    // Spec: "`policy:` section malformed | CORR-GATE-01 error".
    // Observed: violations [], status pass, exit 0 — the loose parser arms a
    // deny-all surface instead of failing closed with the named verdict.
    expect(result.violations.some((x) => x.rule === "CORR-GATE-01")).toBe(true);
  });
});
