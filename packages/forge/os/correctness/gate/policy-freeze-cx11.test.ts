/*
RFC-1615 acceptance verification — round 10 (adversarial).
Every `it` asserts the EXPECTED contract; a failure is a counterexample.
*/

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessGate, type GateOptions } from "./run.ts";
import {
  makeGateFixture,
  verifierCommit,
  ORACLE_PATH,
  type GateFixture,
} from "./tests/gate-fixture.ts";
import { loadForgeConfig } from "../../../src/config/forge-config.ts";

const fixtures: GateFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const fx = (o: Parameters<typeof makeGateFixture>[0] = {}) => {
  const f = makeGateFixture(o);
  fixtures.push(f);
  return f;
};

const run = (f: GateFixture, opts: Partial<GateOptions> = {}) =>
  runCorrectnessGate(f.root, { base: f.base, bundleDir: `${f.root}/.bundles`, ...opts });

const gate = async (f: GateFixture, opts: Partial<GateOptions> = {}) => {
  const out = await run(f, opts);
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
};

const msgs = (r: { violations: { rule: string; message: string }[] }) =>
  r.violations.map((v) => `${v.rule}: ${v.message}`);

/** Overwrite the loose object for `rev:path` with garbage so content reads fail but trees still resolve. */
const corruptBlob = (f: GateFixture, revPath: string): string => {
  const sha = f.git(["rev-parse", revPath]);
  const obj = path.join(f.root, ".git", "objects", sha.slice(0, 2), sha.slice(2));
  chmodSync(obj, 0o644);
  writeFileSync(obj, "corrupt-loose-object-not-zlib");
  return sha;
};

/** Apply pending writes into the fixture's base commit (rewrite history) and return the new base sha. */
const amendBase = (f: GateFixture): string => {
  f.git(["add", "-A"]);
  f.git(["commit", "-q", "--amend", "--no-edit"]);
  return f.git(["rev-parse", "HEAD"]);
};

const MARK = "@ai-" + "invariant";

// ---------------------------------------------------------------------------
// CX-56/57 fix verification — non-plain YAML roots/values refuse CORR-GATE-01
// ---------------------------------------------------------------------------

describe("CX-56/57 non-plain forge.yaml roots and policy values", () => {
  const roots: [string, string][] = [
    ["!!omap", "!!omap [a: 1]\n"],
    ["!!pairs", "!!pairs [[a, 1]]\n"],
    ["!!timestamp", "!!timestamp 2020-01-01\n"],
    ["!!binary", "!!binary aGk=\n"],
    ["!!set", "!!set\n? a\n? b\n"],
    ["scalar int", "5\n"],
    ["scalar str", "just a string\n"],
    ["flow seq", "[a, b]\n"],
  ];
  for (const [name, body] of roots) {
    it(`HEAD forge.yaml is ${name} → CORR-GATE-01 unreadable`, async () => {
      const f = fx();
      f.write("forge.yaml", body);
      f.commit(`${name} root`);
      const r = await gate(f);
      expect(r.status).toBe("fail");
      expect(msgs(r).some((m) => m.includes("does not parse to a YAML map"))).toBe(true);
    });
  }

  it("BASE forge.yaml is !!omap → CORR-GATE-01 unreadable", async () => {
    const f = fx();
    f.write("forge.yaml", "!!omap [a: 1]\n");
    const base = amendBase(f);
    const r = await gate(f, { base });
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("does not parse to a YAML map"))).toBe(true);
  });

  const policyValues: [string, string][] = [
    ["!!omap", "policy: !!omap [mutable: [a]]\n"],
    ["!!set", "policy: !!set\n  ? mutable\n"],
    ["!!timestamp", "policy: !!timestamp 2020-01-01\n"],
    ["!!binary", "policy: !!binary aGk=\n"],
    ["scalar", "policy: 5\n"],
    ["string", "policy: mutable\n"],
    ["seq", "policy: [mutable]\n"],
    ["null", "policy:\n"],
    ["mutable: !!set", "policy:\n  mutable: !!set\n    ? a\n"],
    ["mutable elem !!timestamp", "policy:\n  mutable: [a, !!timestamp 2020-01-01]\n"],
    ["mutable: !!pairs", "policy:\n  mutable: !!pairs [[a, 1]]\n"],
    ["freezeFiles: !!omap", "policy:\n  freezeFiles: !!omap [x: 1]\n"],
    ["additive: scalar", "policy:\n  additive: 5\n"],
  ];
  for (const [name, append] of policyValues) {
    it(`HEAD ${name} → CORR-GATE-01 malformed`, async () => {
      const f = fx();
      f.write("forge.yaml", f.read("forge.yaml") + append);
      f.commit(`policy ${name}`);
      const r = await gate(f);
      expect(r.status).toBe("fail");
      expect(
        msgs(r).some((m) => m.includes("policy: declaration") && m.includes("malformed")),
      ).toBe(true);
    });
  }

  it("BASE policy is !!omap → CORR-GATE-01 malformed", async () => {
    const f = fx();
    f.write("forge.yaml", f.read("forge.yaml") + "policy: !!omap [a: 1]\n");
    const base = amendBase(f);
    const r = await gate(f, { base });
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("malformed"))).toBe(true);
  });

  it("policy with a `<<` merge key is read as a literal `<<` key — denies, not a merge", async () => {
    const f = fx({
      forgeYamlAppend: "policy:\n  <<: {mutable: [project]}\n",
    });
    // `<<` stays literal in yaml.parse → policy armed with all-empty lists →
    // project.name is frozen → editing it must be a policy-key weakening.
    f.write("forge.yaml", f.read("forge.yaml").replace("name: gate-fixture", "name: changed"));
    f.commit("edit project.name");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(r.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
  });

  it("duplicate top-level keys → YAML parse error → CORR-GATE-01 unreadable", async () => {
    const f = fx();
    f.write("forge.yaml", f.read("forge.yaml") + "project: {name: dup}\nproject: {name: dup2}\n");
    f.commit("dup keys");
    const r = await gate(f);
    expect(r.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// CX-58 fix verification — schemaProbe parity with loadForgeConfig
// ---------------------------------------------------------------------------

describe("CX-58 schemaProbe parity", () => {
  // Each transform edits the fixture's valid forge.yaml in place so every
  // required key survives — the only variable is the cyclic construct.
  const cyclic: [string, (y: string) => string][] = [
    ["cyclic extra", (y) => `${y}xtra: &x\n  self: *x\n`],
    [
      "cyclic correctness.self",
      (y) => y.replace("tier: standard", "tier: standard\n  self: &c\n    back: *c"),
    ],
    ["cyclic policy.self", (y) => `${y}policy:\n  mutable: [project]\n  self: &p\n    back: *p\n`],
    [
      "paths.back cycle",
      (y) => y.replace("paths: {}", "paths: &pp\n  rfcsDir: docs/rfcs\n  back: *pp"),
    ],
    ["mutable alias", (y) => `${y}policy:\n  mutable: [&a project, *a]\n`],
  ];
  for (const [name, mutate] of cyclic) {
    it(`${name}: gate judges like loadForgeConfig (no fabricated configError)`, async () => {
      const f = fx();
      f.write("forge.yaml", mutate(f.read("forge.yaml")));
      f.commit(name);
      // Loader parity oracle: whatever the gate reports, the loader must agree.
      let loaderOk = true;
      try {
        loadForgeConfig(f.root);
      } catch {
        loaderOk = false;
      }
      const r = await gate(f);
      const configErr = msgs(r).some((m) => m.includes("schema validation"));
      expect(loaderOk, "fixture doc must be a legal config for loadForgeConfig").toBe(true);
      expect(configErr).toBe(!loaderOk);
    });
  }

  it("cyclic under a strict-typed field → loader rejects AND gate reports configError", async () => {
    const f = fx();
    const y = f.read("forge.yaml");
    f.write(
      "forge.yaml",
      `schema: forge/config@1\nproject: &p\n  name: *p\npaths: {}\n${y.replace(/^schema:[^\n]*\nproject:[\s\S]*?paths:[^\n]*\n/m, "")}`,
    );
    f.commit("cyclic project.name");
    let loaderOk = true;
    try {
      loadForgeConfig(f.root);
    } catch {
      loaderOk = false;
    }
    const r = await gate(f);
    expect(loaderOk).toBe(false);
    expect(msgs(r).some((m) => m.includes("schema validation"))).toBe(true);
  });

  it("correctness.mode !!binary → invalid CORR-02 parity (loader accepts, gate flags invalid)", async () => {
    const f = fx();
    const y = f.read("forge.yaml").replace("mode: enforce", "mode: !!binary aGk=");
    f.write("forge.yaml", y);
    f.commit("binary mode");
    expect(() => loadForgeConfig(f.root)).not.toThrow();
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("correctness.mode") && m.includes("invalid"))).toBe(true);
  });

  it("compassDocs !!omap → configError parity (loader rejects, gate CORR-01)", async () => {
    const f = fx();
    const y = f
      .read("forge.yaml")
      .replace("compassDocs: [docs/requirements.xml]", "compassDocs: !!omap [a: 1]");
    f.write("forge.yaml", y);
    f.commit("omap compassDocs");
    expect(() => loadForgeConfig(f.root)).toThrow();
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("schema validation"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CX-59/60 fix verification — unreadable listing reads fail closed
// ---------------------------------------------------------------------------

describe("CX-59/60 unreadable reads", () => {
  it("corrupt base subtree → ls-tree fails → CORR-GATE-01 fail closed", async () => {
    const f = fx();
    corruptBlob(f, `${f.base}:test`); // test/ tree object
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("a git read failed"))).toBe(true);
  });

  it("corrupt base anchor-carrier blob → base grep fails → CORR-GATE-01", async () => {
    const f = fx();
    corruptBlob(f, `${f.base}:apps/api/src/dispatch.ts`);
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("a git read failed"))).toBe(true);
  });

  it("unreadable changed-path diff refuses --accept-weakening (mixed-weakening)", async () => {
    const f = fx();
    // A weakening to accept: edit the frozen oracle.
    f.write(ORACLE_PATH, "// weakened oracle\n");
    f.commit("weaken oracle");
    // Now corrupt the test/ tree at HEAD — the diff read must walk it.
    corruptBlob(f, `HEAD:test`);
    const r = await gate(f, { acceptWeakening: "verifier review 123" });
    expect(r.status).toBe("fail");
    expect(r.acceptedWeakening).toBeNull();
    expect(
      msgs(r).some((m) => m.includes("a git read failed") || m.includes("mixed-weakening")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEW counterexample probes — repo.show failures treated as "file absent"
// ---------------------------------------------------------------------------

describe("unrecorded repo.show failures (absent-vs-unreadable conflation)", () => {
  it("CX-61: corrupt base+head forge.yaml blob → the whole frozen set must not silently inert", async () => {
    const f = fx();
    // Weaken a frozen file — the oracle.
    f.write(ORACLE_PATH, "// weakened oracle\n");
    f.commit("weaken oracle");
    // forge.yaml is unchanged between base and head → ONE shared blob.
    corruptBlob(f, `${f.base}:forge.yaml`);
    const r = await gate(f);
    // Expected: CORR-GATE-01 (unreadable base forge.yaml) + CORR-GATE-02 (oracle edit).
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("a git read failed") || m.includes("CORR-GATE-02"))).toBe(
      true,
    );
  });

  it("CX-61 (variant): corrupt base forge.yaml only, support-file weakening → must not pass silently", async () => {
    // Weaken a support-glob file (NOT an oracle) so nothing but the frozen-set
    // diff can judge it — if the base surface inerts, this must pass silently.
    const f = fx();
    f.write("scripts/run.sh", "v1\n");
    f.write(
      "docs/correctness.yaml",
      `schema: forge/correctness-manifest@1
entries:
  - id: CM-dispatch-01
    source: req
    ref: REQ-01
    seam: data
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:${ORACLE_PATH}
        substrate: L1
support: ["scripts/**"]
exemptions: []
`,
    );
    const base = amendBase(f);
    f.write("scripts/run.sh", "v2 weakened\n");
    f.commit("weaken support file");
    corruptBlob(f, `${base}:forge.yaml`);
    const r = await gate(f, { base });
    expect(r.status).toBe("fail");
  });

  it("CX-61 (variant): corrupt base manifest blob → must not read as 'no manifest'", async () => {
    const f = fx();
    // Weaken a frozen file.
    f.write(ORACLE_PATH, "// weakened oracle\n");
    f.commit("weaken oracle");
    // The manifest is unchanged → base and head share the corrupt blob.
    corruptBlob(f, `${f.base}:docs/correctness.yaml`);
    const r = await gate(f);
    expect(r.status).toBe("fail");
  });

  it("CX-62: --accept-weakening must not whitelist an unreadable HEAD forge.yaml", async () => {
    // `mutable: [moves]` names no present key → strip(base) === "{}" ===
    // strip(unreadable-head→null) — the isolation check passes on thin air.
    const f = fx({ forgeYamlAppend: "policy:\n  mutable: [moves]\n" });
    // Session edits forge.yaml (any content) then we corrupt the HEAD blob —
    // git show HEAD:forge.yaml fails while ls-tree/diff still work.
    f.write("forge.yaml", f.read("forge.yaml") + "sessionEdit: 1\n");
    f.commit("session forge.yaml edit");
    corruptBlob(f, "HEAD:forge.yaml");
    const r = await gate(f, { acceptWeakening: "operator reviewed the diff" });
    // Expected: refuse — the isolation of forge.yaml cannot be proven on a failed read.
    expect(r.status).toBe("fail");
    expect(r.acceptedWeakening).toBeNull();
  });

  it("CX-63: --accept-weakening must not launder an unreadable HEAD manifest", async () => {
    const f = fx();
    f.write(
      "docs/correctness.yaml",
      "schema: forge/correctness-manifest@1\nentries: []\nsupport: []\nexemptions: []\n",
    );
    f.commit("drop entries");
    corruptBlob(f, "HEAD:docs/correctness.yaml");
    const r = await gate(f, { acceptWeakening: "operator reviewed" });
    expect(r.status).toBe("fail");
    expect(r.acceptedWeakening).toBeNull();
  });

  it("CX-61 (variant): a corrupt committed manifest silently inerts the NEXT integration", async () => {
    const f = fx();
    // Land the corrupt manifest (this commit is the NEXT session's base).
    corruptBlob(f, "HEAD:docs/correctness.yaml");
    const corruptBase = f.git(["rev-parse", "HEAD"]);
    // Next session weakens the oracle.
    f.write(ORACLE_PATH, "// weakened oracle\n");
    f.commit("weaken oracle");
    const r = await gate(f, { base: corruptBase });
    // Expected: refuse — the base manifest exists (ls-tree) but cannot be read.
    expect(r.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// NEW counterexample probes — diff/read edge cases
// ---------------------------------------------------------------------------

describe("diff/read edge cases", () => {
  it("CX-64: a byte change to a frozen file with a non-UTF8 name is judged", async () => {
    const name = Buffer.from([0x73, 0x63, 0x72, 0xff, 0x2e, 0x73, 0x68]); // "scr\xff.sh"
    const dirRel = "nonutf8";
    const f = fx();
    // Put the file + a support glob covering it into the BASE commit.
    mkdirSync(path.join(f.root, dirRel), { recursive: true });
    writeFileSync(path.join(f.root, dirRel, "placeholder.txt"), "x\n");
    writeFileSync(Buffer.concat([Buffer.from(path.join(f.root, dirRel) + "/"), name]), "v1\n");
    f.write(
      "docs/correctness.yaml",
      `schema: forge/correctness-manifest@1
entries:
  - id: CM-dispatch-01
    source: req
    ref: REQ-01
    seam: data
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:${ORACLE_PATH}
        substrate: L1
support: ["${dirRel}/**"]
exemptions: []
`,
    );
    const base = amendBase(f);
    writeFileSync(Buffer.concat([Buffer.from(path.join(f.root, dirRel) + "/"), name]), "v2\n");
    f.commit("edit non-utf8 frozen file");
    const r = await gate(f, { base });
    // Expected: CORR-GATE-02 frozen-file weakening (or a fail-closed CORR-GATE-01).
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("CORR-GATE-02") || m.includes("a git read failed"))).toBe(
      true,
    );
  });

  it("CX-65: git mv of an anchor carrier + drop must report anchor-removed", async () => {
    const f = fx({
      extraFiles: {
        "apps/api/src/dispatch.ts": `// ${MARK}[INV-dispatch-01]: dispatch moves an approved candidate to queued exactly once
//   (checked-by: test:${ORACLE_PATH})
export function dispatch(): void {
${Array.from({ length: 40 }, (_, i) => `  // filler line ${i}`).join("\n")}
}
`,
      },
    });
    // Rename the sole carrier and drop the anchor lines (similarity stays >50%).
    const dropped = f
      .read("apps/api/src/dispatch.ts")
      .split("\n")
      .filter((l) => !l.includes(MARK) && !l.includes("checked-by"))
      .join("\n");
    f.write("apps/api/src/dispatch2.ts", dropped);
    f.git(["rm", "-q", "apps/api/src/dispatch.ts"]);
    f.commit("rename carrier, drop anchor");
    // Cover for CORR-04: an UNCOMMITTED copy of the anchor in the worktree —
    // the validator scans the worktree, the gate judges commits.
    f.write(
      "src/carrier.ts",
      `// ${MARK}[INV-dispatch-01]: dispatch moves an approved candidate to queued exactly once
//   (checked-by: test:${ORACLE_PATH})
export const x = 1;
`,
    );
    const r = await gate(f);
    // Expected: CORR-GATE-02 anchor-removed — the committed anchor is gone.
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("CORR-GATE-02") && m.includes("INV-dispatch-01"))).toBe(
      true,
    );
  });

  it("CX-66: a failed `git status` must not silently drop the dirty-worktree warning", async () => {
    const f = fx();
    // Dirty a tracked file that affects no other check — the only observable
    // is whether the dirty-worktree warning survives the failed status read.
    f.write("apps/api/wrangler.jsonc", "{ /* dirty */ }\n");
    // Corrupt the index so `git status --porcelain` fails.
    const idx = path.join(f.root, ".git", "index");
    chmodSync(idx, 0o644);
    writeFileSync(idx, "corrupt-index");
    const r = await gate(f);
    expect(msgs(r).some((m) => m.includes("uncommitted") || m.includes("a git read failed"))).toBe(
      true,
    );
  });

  it("CX-67: a zero-match base grep is an empty result, not an unreadable read", async () => {
    const f = fx();
    // Rebind the entry to an anchor id that exists NOWHERE, and strip the
    // fixture's marker so `git grep` exits 1 (no matches).
    f.write(
      "docs/correctness.yaml",
      `schema: forge/correctness-manifest@1
entries:
  - id: CM-dispatch-01
    source: req
    ref: REQ-01
    seam: data
    anchors: [INV-ghost-99]
    oracles:
      - check: test:${ORACLE_PATH}
        substrate: L1
support: []
exemptions: []
`,
    );
    f.write(
      "apps/api/src/dispatch.ts",
      "export function dispatch(): void {\n  // no markers here\n}\n",
    );
    const base = amendBase(f);
    const r = await gate(f, { base });
    // Expected: refuse via CORR-04-flavoured CORR-GATE-01 (anchor absent) — NOT
    // a fabricated "a git read failed" claim that also poisons --accept-weakening.
    expect(msgs(r).every((m) => !m.includes("a git read failed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: ordinary weakenings still refuse; clean sessions still pass
// ---------------------------------------------------------------------------

describe("baseline sanity", () => {
  it("frozen oracle edit without verifier trailers refuses CORR-GATE-02", async () => {
    const f = fx();
    f.write(ORACLE_PATH, "// weakened oracle\n");
    f.commit("weaken oracle");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("CORR-GATE-02"))).toBe(true);
  });

  it("isolated weakening + --accept-weakening grants acceptedReason", async () => {
    const f = fx();
    // checkRun rebind: a binding weakening on forge.yaml only; the oracle still
    // runs and attests, so nothing but CORR-GATE-02 is in play.
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace('checkRun: "node {file}"', 'checkRun: "node --no-warnings {file}"'),
    );
    f.commit("rebind checkRun");
    const r = await gate(f, { acceptWeakening: "operator reviewed" });
    expect(r.acceptedWeakening).toBe("operator reviewed");
    expect(r.status).toBe("pass");
  });

  it("verifier-trailer touch of a frozen file is exempt", async () => {
    const f = fx();
    f.write(ORACLE_PATH, "// verifier-amended oracle\n");
    verifierCommit(f.git, "docs/correctness/reviews/2026-11-14-v.yaml");
    const r = await gate(f);
    expect(msgs(r).every((m) => !m.includes("weakening (frozen-file)"))).toBe(true);
  });
});
