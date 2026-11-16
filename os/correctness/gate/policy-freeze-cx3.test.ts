/*
RFC-1615 acceptance verification — round 2 (final round).

New probes over mechanisms the shipped cx/cx2 suites do not cover:
 - Object.prototype-named top-level keys (the `key in doc` presence check)
 - canon()/policyLeaves() blindness to tagged YAML values (!!timestamp,
   !!set, !!omap, .nan/.inf)
 - scalar (non-map) HEAD forge.yaml — `key in <primitive>` TypeError
 - a COMMITTED weakening masked by an uncommitted worktree revert
 - the declared acceptance-probe file's existence
 - freezeFiles glob edge syntax (empty string, negation)
Every test asserts the spec-required behavior — a failure IS a counterexample.
*/
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { policyWeakenings, sideFrom, type CorrectnessSide, type FrozenSet } from "./frozen.ts";
import { runCorrectnessGate } from "./run.ts";
import { makeGateFixture, type GateFixture } from "./tests/gate-fixture.ts";
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
// CX-A: Object.prototype-named top-level keys slip past `key in doc`
//
// `had = key in baseDoc` consults the prototype chain: Object.prototype
// members (hasOwnProperty, constructor, toString, …) are ALWAYS "present".
// canon(inherited function) is "null" — a null-valued new key of that name
// compares canon-equal to the inherited member and is never judged.
// AC-5: a brand-new top-level key not declared mutable SHALL report policy-key.
// ===========================================================================

describe("proto-named top-level keys (AC-5)", () => {
  const PROTO_KEYS = [
    "hasOwnProperty",
    "constructor",
    "toString",
    "valueOf",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
  ];
  for (const k of PROTO_KEYS) {
    it(`new top-level "${k}:" flags policy-key`, () => {
      const head = `${BASE_YAML}${k}:\n`;
      expect(kinds(weak(BASE_YAML, head)), k).toContain("policy-key");
    });
  }

  it('new top-level "__proto__: {}" flags policy-key', () => {
    const head = `${BASE_YAML}__proto__: {}\n`;
    expect(kinds(weak(BASE_YAML, head))).toContain("policy-key");
  });

  it("removing a null-valued proto-named key still flags policy-key", () => {
    const base = `${BASE_YAML}hasOwnProperty:\n`;
    expect(kinds(weak(base, BASE_YAML))).toContain("policy-key");
  });

  it("e2e: hasOwnProperty: addition refuses under --policy-only", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("forge.yaml", `${f.read("forge.yaml")}hasOwnProperty:\n`);
    f.commit("add a proto-named key");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("e2e: the invisible key does not break an accepted weakening's isolation", async () => {
    // policy-decl accept + a smuggled hasOwnProperty: addition — the accept
    // path's forgeYamlOnlyFrozenKeys strips non-mutable keys, so the smuggle
    // rides inside the accepted session. Both judgements must still name it.
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("mutable: [project, forge, moves]", "mutable: [project]") +
        "hasOwnProperty:\n",
    );
    f.commit("shrink mutable plus invisible key");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    // The smuggled key is either a reported weakening or makes forge.yaml
    // foreign — silently accepting means the invisible diff slipped through.
    const smuggled =
      result.weakenings.length === 0 || result.weakenings.every((w) => w.kind === "policy-decl");
    expect(smuggled && result.status === "pass").toBe(false);
  });
});

// ===========================================================================
// CX-B: canon()/policyLeaves() are blind to tagged YAML values
//
// eemeli/yaml resolves !!timestamp → Date, !!set → Set, !!omap → Map,
// .nan/.inf → NaN/Infinity. canon() walks Object.keys — none of those carry
// enumerable string keys, so every one collapses to "{}" (Date/Set/Map) or
// "null" (NaN/Infinity). policyLeaves() likewise contributes no leaf.
// Spec: "any diff of a frozen key is a weakening" — these diffs are invisible.
// ===========================================================================

describe("canon() blind to tagged YAML values (AC-1, spec-table frozen key)", () => {
  it("a !!timestamp leaf changed under a frozen key flags policy-key", () => {
    const base = `${BASE_YAML}retention:\n  until: !!timestamp 2030-01-01\n`;
    const head = base.replace("2030-01-01", "1999-01-01");
    expect(kinds(weak(base, head))).toContain("policy-key");
  });

  it("!!timestamp → plain map under a frozen key flags policy-key", () => {
    const base = `${BASE_YAML}retention:\n  until: !!timestamp 2030-01-01\n`;
    const head = base.replace("until: !!timestamp 2030-01-01", "until: {}");
    expect(kinds(weak(base, head))).toContain("policy-key");
  });

  it("a !!set leaf changed under a frozen key flags policy-key", () => {
    const base = `${BASE_YAML}caps:\n  tools: !!set {read, write}\n`;
    const head = base.replace("!!set {read, write}", "!!set {read}");
    expect(kinds(weak(base, head))).toContain("policy-key");
  });

  it("null → .nan under a frozen key flags policy-key", () => {
    const base = `${BASE_YAML}limits:\n  cap:\n`;
    const head = base.replace("  cap:\n", "  cap: .nan\n");
    expect(kinds(weak(base, head))).toContain("policy-key");
  });

  it("null → .inf under a frozen key flags policy-key", () => {
    const base = `${BASE_YAML}limits:\n  cap:\n`;
    const head = base.replace("  cap:\n", "  cap: .inf\n");
    expect(kinds(weak(base, head))).toContain("policy-key");
  });

  it("a !!timestamp leaf under an ADDITIVE key is an existing leaf — changing it flags", () => {
    const base = BASE_YAML.replace(
      "loopMetrics: []",
      "loopMetrics:\n  - id: m1\n    since: !!timestamp 2030-01-01",
    );
    const head = base.replace("!!timestamp 2030-01-01", "!!timestamp 1999-01-01");
    expect(kinds(weak(base, head))).toContain("policy-key");
  });

  it("a !!timestamp leaf under an ADDITIVE key removed flags", () => {
    const base = BASE_YAML.replace(
      "loopMetrics: []",
      "loopMetrics:\n  - id: m1\n    since: !!timestamp 2030-01-01",
    );
    const head = base.replace("\n    since: !!timestamp 2030-01-01", "");
    expect(kinds(weak(base, head))).toContain("policy-key");
  });

  it("a !!timestamp leaf INSIDE policy: changed flags policy-decl (AC-3)", () => {
    const base = BASE_YAML.replace(
      "  freezeFiles:",
      "  note: !!timestamp 2030-01-01\n  freezeFiles:",
    );
    const head = base.replace("2030-01-01", "1999-01-01");
    expect(kinds(weak(base, head))).toContain("policy-decl");
  });

  it("a Map-valued (!!omap) leaf under a frozen key changed flags", () => {
    const base = `${BASE_YAML}order:\n  seq: !!omap [{a: 1}]\n`;
    const head = base.replace("!!omap [{a: 1}]", "!!omap [{b: 9}]");
    expect(kinds(weak(base, head))).toContain("policy-key");
  });
});

// ===========================================================================
// CX-C: scalar/array HEAD forge.yaml — `key in <primitive>` TypeError
//
// sideFrom() assigns the raw parse result to forgeDoc without a type guard:
// `forge.yaml: 42` parses to a number, `key in 42` throws TypeError inside
// policyWeakenings. The gate must still refuse with a structured verdict
// (CORR-GATE-01/02), not crash without a bundle.
// ===========================================================================

describe("scalar/array HEAD forge.yaml (verdict contract)", () => {
  for (const doc of ["42", "true", '"plain scalar"', "!!timestamp 2020-01-01"]) {
    it(`forge.yaml ${doc} at HEAD refuses with a structured violation, not a crash`, async () => {
      const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
      f.write("forge.yaml", `${doc}\n`);
      f.commit("mangle forge.yaml to a scalar");
      let out;
      let threw: unknown = null;
      try {
        out = await runCorrectnessGate(f.root, {
          base: f.base,
          bundleDir: `${f.root}/.bundles`,
          policyOnly: true,
        });
      } catch (e) {
        threw = e;
      }
      expect(threw, `gate threw: ${String(threw)}`).toBeNull();
      if (out?.ok) {
        expect(out.result.status).toBe("fail");
      }
    });
  }
});

// ===========================================================================
// CX-D: a COMMITTED weakening masked by an uncommitted worktree revert
//
// readHeadSide() reads forge.yaml from the WORKTREE, not from the HEAD commit:
// a session can commit a policy weakening, then leave an uncommitted revert
// so the judged `now` equals base. git status warns (CORR-GATE-01 warning,
// never fatal) but the committed weakening lands on integrate.
// AC-1/AC-3: the gate SHALL report the weakening — the judged diff is base→HEAD.
// ===========================================================================

describe("committed weakening + uncommitted worktree revert (AC-1/AC-3)", () => {
  it("a committed policy-key weakening hidden by a worktree revert still reports", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    const baseYaml = f.read("forge.yaml");
    f.write("forge.yaml", baseYaml.replace("deny: [danger.cmd]", "deny: []"));
    f.commit("empty the deny list");
    f.write("forge.yaml", baseYaml); // uncommitted revert — HEAD keeps the evil
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("a committed policy-decl weakening hidden by a worktree revert still reports", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    const baseYaml = f.read("forge.yaml");
    f.write(
      "forge.yaml",
      baseYaml.replace("mutable: [project, forge, moves]", "mutable: [project]"),
    );
    f.commit("shrink mutable");
    f.write("forge.yaml", baseYaml); // uncommitted revert
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.some((w) => w.kind === "policy-decl")).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("same bypass in a FULL (non-policyOnly) run", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    const baseYaml = f.read("forge.yaml");
    f.write("forge.yaml", baseYaml.replace("deny: [danger.cmd]", "deny: []"));
    f.commit("empty the deny list");
    f.write("forge.yaml", baseYaml);
    const { result } = await gate(f);
    expect(result.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
    expect(result.status).toBe("fail");
  });
});

// ===========================================================================
// CX-D2: the accept path trusts `now.manifestPath` — read from the WORKTREE
//
// frozenPaths whitelists `[base.manifestPath, now.manifestPath]` — and `now`
// is read from the worktree, not the HEAD commit. A session that binds the
// manifest to a foreign path in the worktree only (uncommitted), commits just
// the new file, and runs --accept-weakening gets the foreign file treated as
// a frozen-set path: the "weakening" (the rebind) exists only in the worktree,
// yet it whitelists the committed file. AC-6: non-frozen paths SHALL refuse
// with mixed-weakening.
// ===========================================================================

describe("phantom worktree weakening whitelists a foreign file (AC-6)", () => {
  it("a committed foreign file accepted via a worktree-only manifest rebind", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    const baseYaml = f.read("forge.yaml");
    // Commit ONLY the new file — the forge.yaml rebind stays uncommitted.
    f.write("docs/evil-manifest.yaml", f.read("docs/correctness.yaml"));
    f.commit("add evil-manifest.yaml");
    f.write(
      "forge.yaml",
      baseYaml.replace(
        "correctnessManifest: docs/correctness.yaml",
        "correctnessManifest: docs/evil-manifest.yaml",
      ),
    );
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    // Commit-based judging (CX-16/17 fix): the worktree-only rebind is
    // invisible — there is no phantom weakening to arm the accept path, so
    // nothing is accepted and the foreign file rides nothing.
    expect(result.weakenings).toEqual([]);
    expect(result.acceptedWeakening).toBeNull();
  });
});

// ===========================================================================
// Observation probe: free mutable edits inside an accepted weakening session
// ===========================================================================

describe("mutable-key edit inside an accepted weakening session", () => {
  it("policy-decl accept + free project.name edit", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("mutable: [project, forge, moves]", "mutable: [project]")
        .replace("name: gate-fixture", "name: renamed"),
    );
    f.commit("shrink mutable plus a free rename");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    console.log(
      "OBS mutable-edit-in-accept:",
      JSON.stringify({ status: result.status, violations: result.violations }),
    );
    // documents behavior — the spec's "frozen-set paths only" reading decides
  });
});

// ===========================================================================
// CX-E: freezeFiles glob syntax edges
// ===========================================================================

describe("freezeFiles glob edge cases", () => {
  it("an empty-string glob is rejected (malformed or inert), never crashes the gate", async () => {
    const f = fx({
      forgeYamlAppend: `${POLICY_APPEND.replace('    - ".forge/pinned.yaml"\n', "")}    - ""\n`,
      extraFiles: POLICY_FILES,
    });
    f.write("hooks/extra.sh", "#!/bin/sh\ntrue\n");
    f.commit("add a hook");
    let threw: unknown = null;
    let out;
    try {
      out = await runCorrectnessGate(f.root, {
        base: f.base,
        bundleDir: `${f.root}/.bundles`,
        policyOnly: true,
      });
    } catch (e) {
      threw = e;
    }
    expect(threw, `gate threw: ${String(threw)}`).toBeNull();
    if (out?.ok) {
      // Either the malformed declaration errors or the new file flags —
      // a silent pass is the fail-open.
      expect(
        out.result.violations.some((v) => v.rule === "CORR-GATE-01") ||
          out.result.weakenings.some((w) => w.kind === "policy-file"),
      ).toBe(true);
    }
  });

  it("a whitespace-only glob is rejected, never crashes the gate", async () => {
    const f = fx({
      forgeYamlAppend: `${POLICY_APPEND.replace('    - ".forge/pinned.yaml"\n', "")}    - "   "\n`,
      extraFiles: POLICY_FILES,
    });
    let threw: unknown = null;
    try {
      await runCorrectnessGate(f.root, {
        base: f.base,
        bundleDir: `${f.root}/.bundles`,
        policyOnly: true,
      });
    } catch (e) {
      threw = e;
    }
    expect(threw, `gate threw: ${String(threw)}`).toBeNull();
  });
});

// ===========================================================================
// CX-F: the declared acceptance-probe file must exist
//
// RFC frontmatter: every AC-1..AC-8 probe is
//   { probe: test, file: "packages/forge/os/correctness/gate/policy-freeze.test.ts" }
// attributeProbeResult requires the file's own entry in the vitest report —
// an absent file yields `unverified` for all eight criteria.
// ===========================================================================

describe("declared acceptance probes (RFC acceptance block)", () => {
  it("packages/forge/os/correctness/gate/policy-freeze.test.ts exists", () => {
    const forgeRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
    expect(
      existsSync(path.join(forgeRoot, "os/correctness/gate/policy-freeze.test.ts")),
      "the file named by all 8 acceptance probes is absent — every probe yields unverified",
    ).toBe(true);
  });
});

// ===========================================================================
// CX-19: an unreadable/non-map BASE forge.yaml must fail closed — the frozen
// set would otherwise silently inert (spec failure-modes + F12 precedent).
// ===========================================================================

describe("unreadable base forge.yaml (fail-closed contract)", () => {
  for (const broken of ["dup: 1\ndup: 2\n", "42\n", "[a]\n", "just a string\n"]) {
    it(`base forge.yaml ${JSON.stringify(broken)} refuses`, async () => {
      const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
      const good = f.read("forge.yaml");
      f.write("forge.yaml", broken);
      const brokenBase = f.commit("broken forge.yaml lands out-of-band");
      f.write("forge.yaml", good.replace("deny: [danger.cmd]", "deny: []"));
      f.commit("empty the deny list");
      const out = await runCorrectnessGate(f.root, {
        base: brokenBase,
        bundleDir: `${f.root}/.bundles`,
        policyOnly: true,
      });
      if (!out.ok) throw new Error(out.usageError);
      expect(out.result.status).toBe("fail");
      expect(
        out.result.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error"),
      ).toBe(true);
    });
  }
});

// ===========================================================================
// CX-20: `forge upgrade` heals a declared-but-malformed `policy:` — a
// non-conforming block is not an operator-tuned block (AC-8 + Q-3).
// ===========================================================================

describe("AC-8: forge upgrade heals a malformed policy:", () => {
  const FORGE_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
  const LOGGER = {
    section() {},
    info() {},
    warn() {},
    error() {},
    success() {},
  };
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
    const { DEFAULT_FORGE_POLICY } = await import("../../../src/config/forge-config.ts");
    const res = await runUpgrade(
      { argv: [], flags: {} },
      {
        workspaceRoot: root,
        dryRun: false,
        outputFormat: "json",
        forgeRoot: FORGE_ROOT,
        logger: LOGGER,
      },
    );
    return { res, DEFAULT_FORGE_POLICY };
  };
  const policyOf = (root: string) =>
    (parseYaml(readFileSync(path.join(root, "forge.yaml"), "utf8")) as Record<string, unknown>)[
      "policy"
    ];

  for (const malformed of [
    "policy:\n",
    'policy: "scalar"\n',
    "policy: [a]\n",
    "policy:\n  mutable: [1]\n",
  ]) {
    it(`heals ${JSON.stringify(malformed)}`, async () => {
      const root = workspace(
        `schema: forge/config@1\nproject:\n  name: up\npaths: {}\nforge:\n  syncedVersion: "${PKG_VERSION}"\n${malformed}`,
      );
      const { res, DEFAULT_FORGE_POLICY } = await upgrade(root);
      expect(res.data?.status).toBe("noop");
      expect(policyOf(root)).toEqual(DEFAULT_FORGE_POLICY);
    }, 120_000);
  }
});
