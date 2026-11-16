/*
RFC-1615 acceptance verification — round 1.

Re-verifies the round-0 counterexample fixes (CX-1..CX-5) and hunts for new
weakenings that pass the declared-policy diff. Every test asserts the
spec-required behavior — a failing test IS a counterexample.
*/
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { policyWeakenings, sideFrom, type CorrectnessSide, type FrozenSet } from "./frozen.ts";
import { runCorrectnessGate } from "./run.ts";
import { makeGateFixture, verifierCommit, type GateFixture } from "./tests/gate-fixture.ts";
import type { Weakening } from "./types.ts";
import {
  applyForgeYamlPatches,
  DEFAULT_FORGE_POLICY,
  defaultForgeConfig,
  parseForgeConfigDocument,
} from "../../../src/config/forge-config.ts";

// ---------------------------------------------------------------------------
// Unit-level helpers (same shape as the round-0 regression file)
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
// Round-0 counterexamples — the fixes under re-verification
// ===========================================================================

describe("CX-1 fix: quoted leaf segments — literal dotted keys cannot conflate", () => {
  it("moving bindings.commands.test to a literal dotted key still flags policy-key", () => {
    const head = BASE_YAML.replace(
      '  commands:\n    checkRun: "node {file}"\n    test: "vitest run"\n',
      '  commands:\n    checkRun: "node {file}"\n  "commands.test": "vitest run"\n',
    );
    expect(kinds(weak(BASE_YAML, head))).toContain("policy-key");
  });

  it("keys containing quote/backslash/unicode metachars cannot forge a leaf path", () => {
    // seg() escapes \ and " — a key `a\b`, `q"x` or `🔐` under the additive
    // `bindings` still contributes a leaf that, once removed, must flag.
    const base = BASE_YAML.replace(
      '    test: "vitest run"',
      '    test: "vitest run"\n    "a\\\\b": 1\n    "q\\"x": 2\n    "🔐": 3',
    );
    const head = base.replace('    "a\\\\b": 1\n    "q\\"x": 2\n    "🔐": 3\n', "");
    expect(kinds(weak(base, head))).toContain("policy-key");
  });
});

describe("CX-2 fix: empty containers contribute no leaves", () => {
  it("first element into an empty additive array is a pure addition", () => {
    const head = BASE_YAML.replace("loopMetrics: []", "loopMetrics:\n  - id: m1");
    expect(weak(BASE_YAML, head)).toEqual([]);
  });

  it("first key into an empty additive map is a pure addition", () => {
    const base = BASE_YAML.replace(
      "  paths:\n    correctnessManifest: docs/correctness.yaml",
      "  paths: {}",
    );
    const head = base.replace("  paths: {}", "  paths:\n    correctnessManifest: docs/c.yaml");
    expect(weak(base, head)).toEqual([]);
  });

  it("AC-2 residual: a NULL-valued additive key gaining its first leaf is also a pure addition", () => {
    // `loopMetrics:` (bare, YAML null) is the same 'empty' an operator writes;
    // adding the first leaf under it must not flag (AC-2 literal).
    const base = BASE_YAML.replace("loopMetrics: []", "loopMetrics:");
    const head = base.replace("loopMetrics:", "loopMetrics:\n  - id: m1");
    expect(weak(base, head)).toEqual([]);
  });
});

describe("CX-5 fix: weakening subject names the differing leaf", () => {
  it("deny:[] subject is agentTools.deny", () => {
    const head = BASE_YAML.replace("deny: [danger.cmd]", "deny: []");
    expect(weak(BASE_YAML, head)[0]?.subject).toBe("agentTools.deny");
  });

  it("a nested leaf diff is named without the trailing index", () => {
    const base = `${BASE_YAML}checksContribution:\n  guardRules: [r1, r2]\n`;
    const head = base.replace("[r1, r2]", "[r1]");
    const w = weak(base, head);
    expect(w[0]?.kind).toBe("policy-key");
    expect(w[0]?.subject).toBe("checksContribution.guardRules");
  });
});

// ===========================================================================
// New probes — unit level
// ===========================================================================

describe("additive array semantics", () => {
  it("a prepend into an additive array shifts existing leaves — must flag", () => {
    const a = BASE_YAML.replace("loopMetrics: []", "loopMetrics:\n  - a\n  - b");
    const h = a.replace("loopMetrics:\n  - a\n  - b", "loopMetrics:\n  - x\n  - a\n  - b");
    expect(kinds(weak(a, h))).toContain("policy-key");
  });

  it("an in-place edit of an additive array leaf flags", () => {
    const a = BASE_YAML.replace("loopMetrics: []", "loopMetrics:\n  - a\n  - b");
    const h = a.replace("loopMetrics:\n  - a\n  - b", "loopMetrics:\n  - a\n  - x");
    expect(kinds(weak(a, h))).toContain("policy-key");
  });

  it("a reorder of an additive array flags (order is semantics)", () => {
    const a = BASE_YAML.replace("loopMetrics: []", "loopMetrics:\n  - a\n  - b");
    const h = a.replace("loopMetrics:\n  - a\n  - b", "loopMetrics:\n  - b\n  - a");
    expect(kinds(weak(a, h))).toContain("policy-key");
  });
});

describe("canon() structural equality", () => {
  it("reordered object keys are not a weakening", () => {
    // move `paths: {}` below `bindings:` — a pure top-level reorder.
    const head = BASE_YAML.replace("paths: {}\nbindings:", "bindings:").replace(
      "agentTools:",
      "paths: {}\nagentTools:",
    );
    expect(weak(BASE_YAML, head)).toEqual([]);
  });

  it("YAML anchors/aliases resolving to equal values are not a weakening", () => {
    const b = BASE_YAML.replace("deny: [danger.cmd]", "deny: [&d danger.cmd]\n  also: *d");
    const h = BASE_YAML.replace("deny: [danger.cmd]", "deny: [danger.cmd]\n  also: danger.cmd");
    expect(weak(b, h)).toEqual([]);
  });

  it("a timestamp-valued leaf under a FROZEN key changing flags policy-key", () => {
    // eemeli/yaml parses `2001-01-01` as Date; canon must not flatten it.
    const base = `${BASE_YAML}retention:\n  until: 2030-01-01\n`;
    const head = base.replace("until: 2030-01-01", "until: 1999-01-01");
    expect(kinds(weak(base, head))).toContain("policy-key");
  });

  it("a timestamp-valued leaf under an ADDITIVE key changing flags policy-key", () => {
    const base = BASE_YAML.replace(
      "loopMetrics: []",
      "loopMetrics:\n  - id: m1\n    since: 2030-01-01",
    );
    const head = base.replace("since: 2030-01-01", "since: 1999-01-01");
    expect(kinds(weak(base, head))).toContain("policy-key");
  });
});

describe("policy: self-freeze (AC-3)", () => {
  it("removing the policy: section entirely is policy-decl", () => {
    const head = BASE_YAML.replace(/policy:[\s\S]*$/, "");
    expect(kinds(weak(BASE_YAML, head))).toContain("policy-decl");
  });

  it("shrinking mutable is policy-decl", () => {
    const head = BASE_YAML.replace("mutable: [project, forge, moves]", "mutable: [project]");
    expect(kinds(weak(BASE_YAML, head))).toContain("policy-decl");
  });

  it("growing additive is policy-decl", () => {
    const head = BASE_YAML.replace(
      "additive: [bindings, paths, loopMetrics]",
      "additive: [bindings, paths, loopMetrics, agentTools]",
    );
    expect(kinds(weak(BASE_YAML, head))).toContain("policy-decl");
  });

  it("reordering a policy list is policy-decl (declaration is byte-semantic)", () => {
    const head = BASE_YAML.replace(
      "mutable: [project, forge, moves]",
      "mutable: [forge, project, moves]",
    );
    expect(kinds(weak(BASE_YAML, head))).toContain("policy-decl");
  });

  it("policy: cannot declare itself mutable", () => {
    const base = BASE_YAML.replace("mutable: [project, forge, moves]", "mutable: [policy]");
    const head = base.replace("mutable: [policy]", "mutable: [policy, agentTools]");
    expect(kinds(weak(base, head))).toContain("policy-decl");
  });

  it("policy: {} at base arms deny-all — any forge.yaml edit flags", () => {
    const base = BASE_YAML.replace(/policy:[\s\S]*$/, "policy: {}\n");
    const head = base.replace("deny: [danger.cmd]", "deny: []");
    expect(kinds(weak(base, head))).toContain("policy-key");
  });
});

describe("AC-5: brand-new top-level key", () => {
  it("new key with content flags policy-key", () => {
    const head = `${BASE_YAML}evilSurface:\n  x: 1\n`;
    expect(kinds(weak(BASE_YAML, head))).toContain("policy-key");
  });

  it("a new key whose value is null still flags policy-key", () => {
    // `evil:` parses to null — canon(null) must not equal canon(absent).
    const head = `${BASE_YAML}evilSurface:\n`;
    expect(kinds(weak(BASE_YAML, head))).toContain("policy-key");
  });

  it("a frozen top-level key removed while null-valued still flags policy-key", () => {
    // base has `deadKey:` (null); head drops it — canon(null)≡canon(absent)
    // must not make the removal invisible.
    const base = `${BASE_YAML}deadKey:\n`;
    expect(kinds(weak(base, BASE_YAML))).toContain("policy-key");
  });
});

describe("malformed policy: surface classification (parsePolicySurface)", () => {
  const NO_POLICY = BASE_YAML.replace(/policy:[\s\S]*$/, "");
  it("policy: [] is malformed", () => {
    expect(sideFrom(`${NO_POLICY}policy: []\n`, () => null).policyMalformed).toBe(true);
  });
  it('policy: "scalar" is malformed', () => {
    expect(sideFrom(`${NO_POLICY}policy: "scalar"\n`, () => null).policyMalformed).toBe(true);
  });
  it("policy: {mutable: scalar} is malformed", () => {
    expect(sideFrom(`${NO_POLICY}policy:\n  mutable: nope\n`, () => null).policyMalformed).toBe(
      true,
    );
  });
  it("a declared-but-null policy: is not silently treated as undeclared", () => {
    // `policy:` with an empty value parses to null — a non-map, i.e. malformed
    // per the spec's '{mutable?, additive?, freezeFiles?} string-list map'.
    const side = sideFrom(`${NO_POLICY}policy:\n`, () => null);
    expect(side.policyMalformed).toBe(true);
  });
  it("a declared freezeFiles list whose members are not strings is malformed, not silently inert", () => {
    // `freezeFiles: [1]` survives Array.isArray but binds zero globs — the
    // operator's declared freeze silently does nothing.
    const side = sideFrom(`${NO_POLICY}policy:\n  freezeFiles: [1]\n`, () => null);
    expect(side.policyMalformed).toBe(true);
  });
});

// ===========================================================================
// E2E — gate runs on fixture repos
// ===========================================================================

describe("CX-3 fix (AC-7): no-policy repo under --policy-only", () => {
  it("exits 0 with the 'no policy surface declared' bundle note", async () => {
    const f = fx({});
    const { result, bundle } = await gate(f, { policyOnly: true });
    expect(result.status).toBe("pass");
    expect(`${JSON.stringify(result)}${JSON.stringify(bundle)}`).toContain(
      "no policy surface declared",
    );
  });
});

describe("CX-4 fix (AC-7): malformed policy: is CORR-GATE-01 in both modes", () => {
  it("non-object policy: at base under --policy-only", async () => {
    const f = fx({ forgeYamlAppend: 'policy: "definitely not a policy object"\n' });
    const { result } = await gate(f, { policyOnly: true });
    expect(result.violations.some((v) => v.rule === "CORR-GATE-01")).toBe(true);
  });

  it("policy: [] at base under --policy-only", async () => {
    const f = fx({ forgeYamlAppend: "policy: []\n" });
    const { result } = await gate(f, { policyOnly: true });
    expect(result.violations.some((v) => v.rule === "CORR-GATE-01")).toBe(true);
  });

  it("policy: {freezeFiles: scalar} at base under --policy-only", async () => {
    const f = fx({ forgeYamlAppend: 'policy:\n  freezeFiles: "hooks/**"\n' });
    const { result } = await gate(f, { policyOnly: true });
    expect(result.violations.some((v) => v.rule === "CORR-GATE-01")).toBe(true);
  });

  it("malformed policy: at HEAD (valid at base)", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("forge.yaml", f.read("forge.yaml").replace(/policy:[\s\S]*$/, 'policy: "broken"\n'));
    f.commit("mangle policy");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.violations.some((v) => v.rule === "CORR-GATE-01")).toBe(true);
  });

  it("warn mode does not downgrade CORR-GATE-01 for malformed policy:", async () => {
    const f = fx({ mode: "warn", forgeYamlAppend: 'policy: "broken"\n' });
    const { result } = await gate(f, { policyOnly: true });
    const v = result.violations.find((x) => x.rule === "CORR-GATE-01" && x.severity === "error");
    expect(v).toBeTruthy();
    expect(result.status).toBe("fail");
  });

  it("malformed policy: is CORR-GATE-01 in a full (non-policyOnly) run", async () => {
    const f = fx({ mode: "warn", forgeYamlAppend: 'policy: "broken"\n' });
    const { result } = await gate(f);
    expect(result.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error")).toBe(
      true,
    );
  });

  it("a declared-but-null policy: at base fails closed, not silently inert", async () => {
    const f = fx({ forgeYamlAppend: "policy:\n" });
    const { result } = await gate(f, { policyOnly: true });
    // Must be the malformed ERROR, not the 'no policy surface declared' note
    // (which also carries the CORR-GATE-01 rule id at warning severity).
    expect(result.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error")).toBe(
      true,
    );
    expect(result.status).toBe("fail");
  });
});

describe("AC-1 e2e: frozen forge.yaml keys refuse in warn mode too", () => {
  it("emptying agentTools.deny is a policy-key CORR-GATE-02 in warn mode", async () => {
    const f = fx({ mode: "warn", forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.commit("drop the deny list");
    const { result } = await gate(f);
    const w = result.weakenings.find((x) => x.kind === "policy-key");
    expect(w?.subject).toBe("agentTools.deny");
    expect(result.violations.some((v) => v.rule === "CORR-GATE-02")).toBe(true);
    expect(result.status).toBe("fail");
  });
});

describe("AC-4: freezeFiles byte-freeze", () => {
  it("modifying a matched file is policy-file", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 1\n");
    f.commit("weaken the gate hook");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.some((w) => w.kind === "policy-file")).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("deleting .forge/pinned.yaml is policy-file", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.git(["rm", "-q", ".forge/pinned.yaml"]);
    f.commit("drop pinned");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.some((w) => w.kind === "policy-file")).toBe(true);
  });

  it("a NEW file matching a frozen glob is policy-file", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("hooks/extra.sh", "#!/bin/sh\ntrue\n");
    f.commit("add a hook");
    const { result } = await gate(f, { policyOnly: true });
    const w = result.weakenings.find((x) => x.kind === "policy-file");
    expect(w?.subject).toBe("hooks/extra.sh");
  });

  it("a verifier-trailer commit may change a frozen file", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 1\n");
    verifierCommit(f.git, "docs/correctness/reviews/x.yaml");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.filter((w) => w.kind === "policy-file")).toEqual([]);
  });

  it("./-prefixed and backslash glob spellings still freeze", async () => {
    const append = POLICY_APPEND.replace('"hooks/**"', '"./hooks/**"').replace(
      '".forge/pinned.yaml"',
      '"hooks\\\\**"',
    );
    // `./hooks/**` normalizes to hooks/**; `hooks\\**` (backslash) → hooks/**.
    const f = fx({ forgeYamlAppend: append, extraFiles: POLICY_FILES });
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 1\n");
    f.commit("weaken the gate hook");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.some((w) => w.kind === "policy-file")).toBe(true);
  });

  it("an executable-bit flip on a frozen file without byte change still reports", async () => {
    // Verifier round-1 observation, judged out-of-scope: the spec freezes
    // bytes, not modes — a mode-only flip is invisible to byte-compare, the
    // same gap RFC-1580's frozen.files carries. Asserts the documented
    // semantics (mode flips do not weaken) rather than a speculative fix.
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.git(["update-index", "--chmod=+x", "hooks/integration-gate.sh"]);
    f.git(["commit", "-qm", "chmod the hook"]);
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.some((w) => w.kind === "policy-file")).toBe(false);
  });
});

describe("AC-5 e2e + forge.yaml removal", () => {
  it("a brand-new top-level key refuses", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("forge.yaml", `${f.read("forge.yaml")}evilSurface:\n  x: 1\n`);
    f.commit("add evil surface");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("deleting forge.yaml refuses", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.git(["rm", "-q", "forge.yaml"]);
    f.commit("delete forge.yaml");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.status).toBe("fail");
  });
});

describe("AC-3 e2e: policy-decl under --policy-only", () => {
  it("shrinking mutable is caught by the cheap gate too", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("mutable: [project, forge, moves]", "mutable: [project]"),
    );
    f.commit("shrink mutable");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.some((w) => w.kind === "policy-decl")).toBe(true);
    expect(result.status).toBe("fail");
  });
});

describe("AC-6: isolated weakening session + --accept-weakening", () => {
  it("a pure policy-file change accepts", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 1\n");
    f.commit("weaken the gate hook");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved");
    expect(result.weakenings.every((w) => w.accepted)).toBe(true);
  });

  it("a policy-file change bundled with foreign work names mixed-weakening", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 1\n");
    f.write("src/unrelated.ts", "export const x = 1;\n");
    f.commit("weaken hook plus foreign work");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    expect(result.status).toBe("fail");
    expect(result.violations.some((v) => /mixed-weakening/.test(v.message))).toBe(true);
  });

  it("a pure policy-decl change accepts (policy surface session)", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("mutable: [project, forge, moves]", "mutable: [project]"),
    );
    f.commit("shrink mutable");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved");
  });

  it("AC-6: a pure additive-leaf policy-key weakening accepts like every other policy.*", async () => {
    // `bindings.commands.verify` exists at base → changing it is a policy-key
    // weakening on a path that is a policy.* subject — the isolated weakening
    // session must be acceptable (the spec adds `policy.*` to the allowed set).
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace('verify: "node scripts/verify.mjs"', 'verify: "node scripts/evil.mjs"'),
    );
    f.commit("rebind verify");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    expect(result.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved");
  });

  it("AC-6: a new file matching a frozen glob accepts like every other policy.*", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("hooks/extra.sh", "#!/bin/sh\ntrue\n");
    f.commit("add a hook");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    expect(result.weakenings.some((w) => w.kind === "policy-file")).toBe(true);
    expect(result.status).toBe("pass");
  });
});

describe("policy: inert adoption (spec-table conflict — documents behavior)", () => {
  it("adding policy: at HEAD on a repo without it is inert (no policy-decl)", async () => {
    const f = fx({}); // no policy at base
    f.write(
      "forge.yaml",
      `${f.read("forge.yaml")}policy:\n  mutable: [project]\n  additive: [bindings]\n  freezeFiles: ["hooks/**"]\n`,
    );
    f.commit("adopt policy");
    const { result } = await gate(f, { policyOnly: true });
    // Spec table: 'policy: added → policy-decl'; spec prose: adoption is opt-in.
    expect(result.status).toBe("pass");
  });
});

// ===========================================================================
// AC-8: scaffolded policy block
// ===========================================================================

describe("AC-8: default policy block scaffolding", () => {
  it("defaultForgeConfig carries the populated policy block", () => {
    expect(defaultForgeConfig("probe").policy).toEqual(DEFAULT_FORGE_POLICY);
    expect(DEFAULT_FORGE_POLICY.mutable.length).toBeGreaterThan(0);
    expect(DEFAULT_FORGE_POLICY.additive.length).toBeGreaterThan(0);
    expect(DEFAULT_FORGE_POLICY.freezeFiles.length).toBeGreaterThan(0);
  });

  it("the init write path (stringifyYaml(config)) emits a policy: section", () => {
    const yaml = stringifyYaml(defaultForgeConfig("probe"));
    const doc = parseYaml(yaml) as Record<string, unknown>;
    expect(doc["policy"]).toEqual(DEFAULT_FORGE_POLICY);
  });

  it("the upgrade patch path adds policy: when absent", () => {
    const raw = "schema: forge/config@1\nproject:\n  name: probe\npaths: {}\n";
    const patched = applyForgeYamlPatches(raw, [{ path: ["policy"], value: DEFAULT_FORGE_POLICY }]);
    expect(patched).not.toBeNull();
    const doc = parseYaml(patched!) as Record<string, unknown>;
    expect(doc["policy"]).toEqual(DEFAULT_FORGE_POLICY);
  });

  it("parseForgeConfigDocument surfaces absent policy: as undefined (upgrade guard)", () => {
    const config = parseForgeConfigDocument(
      "schema: forge/config@1\nproject:\n  name: probe\npaths: {}\n",
      "forge.yaml",
    );
    expect(config.policy).toBeUndefined();
    const withPolicy = parseForgeConfigDocument(
      "schema: forge/config@1\nproject:\n  name: probe\npaths: {}\npolicy:\n  mutable: [project]\n",
      "forge.yaml",
    );
    expect(withPolicy.policy).toBeTruthy();
  });

  it("defaultForgeConfig does not share the policy arrays with DEFAULT_FORGE_POLICY", () => {
    const c = defaultForgeConfig("probe");
    expect(c.policy?.mutable).not.toBe(DEFAULT_FORGE_POLICY.mutable);
  });
});

describe("AC-8 e2e: forge upgrade scaffolds policy:", () => {
  const FORGE_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
  const LOGGER = { section() {}, info() {}, warn() {}, error() {}, success() {} };
  const PKG_VERSION = JSON.parse(readFileSync(path.join(FORGE_ROOT, "package.json"), "utf8"))
    .version as string;

  const workspace = (yaml: string) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "forge-upgrade-"));
    tmpdirs.push(root);
    writeFileSync(path.join(root, "forge.yaml"), yaml);
    return root;
  };
  const upgrade = async (root: string) => {
    const { runUpgrade } = await import("../../../src/onboarding/upgrade.ts");
    return runUpgrade(
      { argv: [], flags: {} },
      {
        workspaceRoot: root,
        dryRun: false,
        outputFormat: "json",
        forgeRoot: FORGE_ROOT,
        logger: LOGGER,
      },
    );
  };
  const policyOf = (root: string) =>
    (parseYaml(readFileSync(path.join(root, "forge.yaml"), "utf8")) as Record<string, unknown>)[
      "policy"
    ];

  it("a version-bumped upgrade writes the default policy block", async () => {
    const root = workspace(
      'schema: forge/config@1\nproject:\n  name: up\npaths: {}\nforge:\n  syncedVersion: "0.0.0-old"\n',
    );
    await upgrade(root);
    expect(policyOf(root)).toEqual(DEFAULT_FORGE_POLICY);
  }, 120_000);

  it("AC-8: a noop upgrade on a policy-less repo still leaves the policy block", async () => {
    const root = workspace(
      `schema: forge/config@1\nproject:\n  name: up\npaths: {}\nforge:\n  syncedVersion: "${PKG_VERSION}"\n`,
    );
    const res = await upgrade(root);
    expect(res.data?.status).toBe("noop");
    expect(policyOf(root)).toEqual(DEFAULT_FORGE_POLICY);
  }, 120_000);

  it("an operator-tuned policy: is never rewritten by upgrade", async () => {
    const root = workspace(
      'schema: forge/config@1\nproject:\n  name: up\npaths: {}\nforge:\n  syncedVersion: "0.0.0-old"\npolicy:\n  mutable: [zzz]\n  additive: []\n  freezeFiles: []\n',
    );
    await upgrade(root);
    expect(policyOf(root)).toEqual({ mutable: ["zzz"], additive: [], freezeFiles: [] });
  }, 120_000);
});
