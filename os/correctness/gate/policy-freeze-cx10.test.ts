/*
 * RFC-1615 round-9 adversarial acceptance probes.
 * Every `it` asserts the EXPECTED contract; a failure is a counterexample.
 */
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseForgeConfigDocument } from "../../../src/config/forge-config.ts";
import { sideFrom } from "./frozen.ts";
import { runCorrectnessGate } from "./run.ts";
import { settingsFromForgeDoc } from "../workspace.ts";
import {
  makeGateFixture,
  manifestYaml,
  ORACLE_PATH,
  verifierCommit,
  type GateFixture,
  type GateFixtureOptions,
} from "./tests/gate-fixture.ts";

const fx = (opts: GateFixtureOptions = {}) => makeGateFixture(opts);
const gate = async (
  f: GateFixture,
  opts: { acceptWeakening?: string; policyOnly?: boolean; base?: string } = {},
) => {
  const out = await runCorrectnessGate(f.root, {
    base: opts.base ?? f.base,
    bundleDir: `${f.root}/.bundles`,
    acceptWeakening: opts.acceptWeakening,
    policyOnly: opts.policyOnly,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
};
const rules = (r: { violations: { rule: string }[] }) => r.violations.map((v) => v.rule);
const wk = (r: { weakenings: { kind: string; subject: string; message: string }[] }) =>
  r.weakenings.map((w) => `${w.kind}:${w.subject}`);

/** Corrupt a tree object shared by base and head so git enumeration fails. */
const corruptTree = (f: GateFixture, rel: string) => {
  const sha = f.git(["rev-parse", `HEAD:${rel}`]);
  const obj = path.join(f.root, ".git", "objects", sha.slice(0, 2), sha.slice(2));
  chmodSync(obj, 0o644);
  writeFileSync(obj, "corrupt-not-zlib");
  return sha;
};

/** A committed forge.yaml body; rewrites the fixture file and commits. */
const commitForgeYaml = (f: GateFixture, body: string, msg = "forge.yaml") => {
  f.write("forge.yaml", body);
  return f.commit(msg);
};

const BASE_YAML = `schema: forge/config@1
project:
  name: gate-fixture
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
  paths:
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: enforce
  tier: standard
`;

describe("CX-56 candidate: non-plain-object forge.yaml is 'readable'", () => {
  const bodies: [string, string][] = [
    ["!!set", "!!set\n? a\n? b\n"],
    ["!!omap", "!!omap\n- a: 1\n"],
    ["!!timestamp", "!!timestamp 2020-01-01\n"],
    ["!!binary", "!!binary aGk=\n"],
  ];
  for (const [tag, body] of bodies) {
    it(`sideFrom marks ${tag} forge.yaml unreadable`, () => {
      expect(sideFrom(body, () => null).forgeYamlUnreadable).toBe(true);
    });
    it(`HEAD ${tag} forge.yaml refuses CORR-GATE-01 under --policy-only (no base policy)`, async () => {
      const f = fx();
      commitForgeYaml(f, body);
      const r = await gate(f, { policyOnly: true });
      expect(r.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error")).toBe(
        true,
      );
      expect(r.status).toBe("fail");
      f.cleanup();
    });
  }
  it("a !!set forge.yaml at --base refuses (frozen set must not silently inert)", async () => {
    const f = fx();
    const base = commitForgeYaml(f, "!!set\n? a\n", "set-shaped base");
    const r = await gate(f, { base });
    expect(r.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error")).toBe(
      true,
    );
    expect(r.status).toBe("fail");
    f.cleanup();
  });
  it("a !!omap forge.yaml at --base refuses", async () => {
    const f = fx();
    const base = commitForgeYaml(f, "!!omap\n- a: 1\n", "omap base");
    const r = await gate(f, { base });
    expect(r.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error")).toBe(
      true,
    );
    expect(r.status).toBe("fail");
    f.cleanup();
  });
  it("a !!timestamp forge.yaml at --base refuses", async () => {
    const f = fx();
    const base = commitForgeYaml(f, "!!timestamp 2020-01-01\n", "date base");
    const r = await gate(f, { base });
    expect(r.status).toBe("fail");
    f.cleanup();
  });
});

describe("CX-57 candidate: policy: non-plain object is not 'malformed'", () => {
  for (const [tag, pol] of [
    ["plain timestamp string", "policy: 2020-01-01\n"],
    ["!!timestamp Date", "policy: !!timestamp 2020-01-01\n"],
    ["!!set", "policy: !!set\n  ? mutable\n"],
    ["!!omap", "policy: !!omap\n  - mutable: [x]\n"],
    ["!!binary", "policy: !!binary aGk=\n"],
  ] as const) {
    it(`policy: ${tag} at --base is malformed → CORR-GATE-01`, async () => {
      const f = fx({ forgeYamlAppend: pol });
      const r = await gate(f, { policyOnly: true });
      expect(rules(r)).toContain("CORR-GATE-01");
      f.cleanup();
    });
  }
  it("policy: !!omap contents are invisible — intended mutable:[x] still denies", async () => {
    const f = fx({ forgeYamlAppend: "policy: !!omap\n  - mutable: [project]\n" });
    // The operator declared `mutable: [project]` inside an omap. If the gate
    // reads it as well-formed, the key must be honored; if not, CORR-GATE-01.
    f.write("forge.yaml", f.read("forge.yaml").replace("name: gate-fixture", "name: renamed"));
    f.commit("edit project.name");
    const r = await gate(f, { policyOnly: true });
    const denied = wk(r).some((k) => /policy-key/.test(k));
    const refusedMalformed = rules(r).includes("CORR-GATE-01");
    // Either outcome is contract-satisfying; silently treating it as deny-all
    // *without* the malformed flag is not — assert malformed was reported.
    if (denied) expect(refusedMalformed).toBe(true);
    f.cleanup();
  });
});

describe("CX-58 candidate: cyclic alias fabricates configError the loader never produces", () => {
  const cyclicDocs: [string, string][] = [
    [
      "cyclic extra key",
      `schema: forge/config@1\nproject: {name: x}\npaths: {}\nextra: &x\n  self: *x\n`,
    ],
    [
      "cyclic correctness",
      `schema: forge/config@1\nproject: {name: x}\npaths: {}\ncorrectness: &c\n  mode: enforce\n  self: *c\n`,
    ],
    [
      "cyclic policy",
      `schema: forge/config@1\nproject: {name: x}\npaths: {}\npolicy: &p\n  mutable: [a]\n  self: *p\n`,
    ],
    [
      "deep cyclic extra",
      `schema: forge/config@1\nproject: {name: x}\npaths: {}\na: &x\n  nested:\n    deep: *x\n`,
    ],
  ];
  for (const [label, body] of cyclicDocs) {
    it(`loader accepts ${label} (parity baseline)`, () => {
      expect(() => parseForgeConfigDocument(body, "forge.yaml")).not.toThrow();
    });
    it(`settingsFromForgeDoc reports no configError for ${label}`, () => {
      const doc = sideFrom(body, () => null);
      const s = settingsFromForgeDoc(doc.forgeDoc, doc.forgeYamlUnreadable);
      expect(s.configError).toBeNull();
    });
  }
  it("a HEAD forge.yaml with a cyclic extra key is not refused (loader accepts it)", async () => {
    const f = fx();
    // Ported: extend the FIXTURE yaml — the probe's BASE_YAML diverged from
    // it (missing compassDocs/verify bindings) and fabricated CORR-03.
    f.write("forge.yaml", `${f.read("forge.yaml")}extra: &x\n  self: *x\n`);
    f.commit("cyclic extra key");
    const r = await gate(f);
    expect(r.violations.filter((v) => v.severity === "error").map((v) => v.rule)).not.toContain(
      "CORR-GATE-01",
    );
    f.cleanup();
  });
  it("a HEAD forge.yaml with cyclic correctness: is not refused", async () => {
    const f = fx();
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace(
          "correctness:\n  mode: enforce\n  tier: standard\n",
          "correctness: &c\n  mode: enforce\n  tier: standard\n  self: *c\n",
        ),
    );
    f.commit("cyclic correctness");
    const r = await gate(f);
    expect(r.violations.filter((v) => v.severity === "error").map((v) => v.rule)).not.toContain(
      "CORR-GATE-01",
    );
    f.cleanup();
  });
});

describe("CX-59/60 candidates: git read failure fails open", () => {
  it("ls-tree failure leaves support-glob-frozen files unjudged (fail-open)", async () => {
    const f = fx({
      extraFiles: { "frozen/x.txt": "v1\n", "sub/keep.txt": "k\n" },
    });
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("support: []", 'support: ["frozen/**"]'),
    );
    const base = f.commit("support glob over frozen/**");
    corruptTree(f, "sub"); // shared by base and head
    f.write("frozen/x.txt", "v2 — weakened\n");
    f.commit("edit frozen support file");
    const r = await gate(f, { base });
    // The support-file edit must be a weakening; a null ls-tree silently froze nothing.
    expect(r.weakenings.length).toBeGreaterThan(0);
    expect(rules(r)).toContain("CORR-GATE-02");
    f.cleanup();
  });
  it("changedPaths failure launders a foreign file through --accept-weakening", async () => {
    const f = fx({
      forgeYamlAppend: "policy:\n  mutable: [project]\n",
      extraFiles: { "sub/keep.txt": "k\n" },
    });
    // HEAD: a policy-key weakening (judged without ls-tree) + a foreign file +
    // a change inside sub/ so the HEAD sub-tree differs and git diff recurses.
    f.write("forge.yaml", f.read("forge.yaml") + "extraTop: 1\n");
    f.write("foreign.txt", "not part of the weakening\n");
    f.write("sub/keep.txt", "k2\n");
    const head = f.commit("weakening + foreign + sub change");
    // Corrupt the HEAD-side sub/ tree object — `git diff` cannot enumerate.
    const sha = f.git(["rev-parse", `${head}:sub`]);
    const obj = path.join(f.root, ".git", "objects", sha.slice(0, 2), sha.slice(2));
    chmodSync(obj, 0o644);
    writeFileSync(obj, "corrupt-not-zlib");
    const r = await gate(f, { acceptWeakening: "op: add extraTop" });
    // The diff could not be enumerated — granting isolation must refuse, not
    // accept: a null diff launders foreign.txt into "isolated".
    expect(r.acceptedWeakening).toBeNull();
    expect(
      r.violations.some((v) => v.rule === "CORR-GATE-02" && /mixed-weakening/.test(v.message)),
    ).toBe(true);
    f.cleanup();
  });
  it("ls-tree failure leaves mode flips unjudged (fail-open)", async () => {
    const f = fx({ extraFiles: { "sub/keep.txt": "k\n" } });
    corruptTree(f, "sub");
    // Ported: a single net flip against base — the probe's 755→644 two-commit
    // sequence netted to 644==644, judging nothing (net-zero chmod artifact).
    chmodSync(path.join(f.root, ORACLE_PATH), 0o755);
    f.commit("chmod +x");
    const r = await gate(f);
    expect(r.weakenings.length).toBeGreaterThan(0);
    f.cleanup();
  });
});

describe("CX-47 closure: sideFrom filters non-string compassDocs", () => {
  it("compassDocs: [1, docs/requirements.xml] does not crash", async () => {
    const f = fx();
    commitForgeYaml(
      f,
      BASE_YAML.replace(
        "    correctnessManifest: docs/correctness.yaml\n",
        "    correctnessManifest: docs/correctness.yaml\n    compassDocs: [1, docs/requirements.xml]\n",
      ),
    );
    const r = await gate(f);
    expect(r).toBeTruthy();
    f.cleanup();
  });
});

describe("CX-48 closure: oracleTimeoutMs must be finite within [1, 2^31-1]", () => {
  const mk = async (timeout: string) => {
    const f = fx();
    commitForgeYaml(
      f,
      BASE_YAML.replace(
        "correctness:\n  mode: enforce\n  tier: standard\n",
        `correctness:\n  mode: enforce\n  tier: standard\n  oracleTimeoutMs: ${timeout}\n`,
      ),
    );
    return f;
  };
  for (const t of [".inf", "2147483648", "0.5", "0", "-5", "abc"]) {
    it(`oracleTimeoutMs: ${t} falls back to default — no fabricated timeout`, async () => {
      const f = await mk(t);
      const r = await gate(f);
      const timeouts = r.violations.filter(
        (v) => v.rule === "CORR-GATE-07" && /timed out/.test(v.message),
      );
      expect(timeouts.length).toBe(0);
      f.cleanup();
    });
  }
  it("oracleTimeoutMs: 1 is in the sanctioned range and really bounds the run", async () => {
    const f = await mk("1");
    const r = await gate(f);
    expect(r.violations.some((v) => v.rule === "CORR-GATE-07" && /timed out/.test(v.message))).toBe(
      true,
    );
    f.cleanup();
  });
});

describe("CX-49 closure: tagged scalars reach the schema probe", () => {
  it("project.name: !!timestamp (Date) surfaces configError like the loader", () => {
    const body = "schema: forge/config@1\nproject: {name: !!timestamp 2020-01-01}\npaths: {}\n";
    expect(() => parseForgeConfigDocument(body, "forge.yaml")).toThrow();
    const d = sideFrom(body, () => null);
    expect(settingsFromForgeDoc(d.forgeDoc, d.forgeYamlUnreadable).configError).not.toBeNull();
  });
  it("paths: !!omap — the loader tolerates it; the gate must not fabricate", () => {
    const body =
      "schema: forge/config@1\nproject: {name: x}\npaths: !!omap\n  - rfcsDir: docs/rfcs\n";
    expect(() => parseForgeConfigDocument(body, "forge.yaml")).not.toThrow();
    const d = sideFrom(body, () => null);
    expect(settingsFromForgeDoc(d.forgeDoc, d.forgeYamlUnreadable).configError).toBeNull();
  });
  it("project.name: plain timestamp string is a string — both accept", () => {
    const body = "schema: forge/config@1\nproject: {name: 2020-01-01}\npaths: {}\n";
    expect(() => parseForgeConfigDocument(body, "forge.yaml")).not.toThrow();
    const d = sideFrom(body, () => null);
    expect(settingsFromForgeDoc(d.forgeDoc, d.forgeYamlUnreadable).configError).toBeNull();
  });
});

describe("CX-50 closure: DAG aliases leaf normally", () => {
  it("a shared anchor revisited from a sibling is not cyclic", () => {
    const body =
      "schema: forge/config@1\nproject: {name: x}\npaths: {}\na: &y [1, 2]\nb: *y\nc: *y\n";
    expect(() => parseForgeConfigDocument(body, "forge.yaml")).not.toThrow();
    const d = sideFrom(body, () => null);
    expect(settingsFromForgeDoc(d.forgeDoc, d.forgeYamlUnreadable).configError).toBeNull();
  });
});

describe("CX-51 closure: declared-policy strip drops frozen binding subkeys", () => {
  it("mutable:[bindings] + checkRun rebind + accept → isolated accept", async () => {
    const f = fx({ forgeYamlAppend: "policy:\n  mutable: [bindings]\n" });
    // Rebind checkRun — the declared-policy strip drops it from the key diff,
    // while the dedicated RFC-1580 binding check still reports a weakening.
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "echo {file}"'),
    );
    f.commit("rebind checkRun");
    const r = await gate(f, { acceptWeakening: "op: runner swap approved" });
    const mixed = r.violations.find(
      (v) => v.rule === "CORR-GATE-02" && /mixed-weakening/.test(v.message),
    );
    expect(mixed).toBeUndefined();
    // The binding weakening exists and the diff is forge.yaml-only → accepted.
    expect(r.acceptedWeakening).toBe("op: runner swap approved");
    f.cleanup();
  });
});

describe("CX-52 closure: forge.yaml never byte-frozen by freezeFiles", () => {
  it("freezeFiles: [*.yaml] + a frozen-key forge.yaml edit reports policy-key, not policy-file", async () => {
    const f = fx({ forgeYamlAppend: 'policy:\n  freezeFiles: ["*.yaml"]\n' });
    f.write("forge.yaml", f.read("forge.yaml") + "extraTop: 1\n");
    f.commit("add undeclared key");
    const r = await gate(f, { policyOnly: true });
    const kinds = wk(r);
    expect(kinds.some((k) => k.startsWith("policy-key:"))).toBe(true);
    expect(kinds.some((k) => k.startsWith("policy-file:forge.yaml"))).toBe(false);
    f.cleanup();
  });
  it("freezeFiles glob matching forge.yaml does not whitelist a non-isolated diff", async () => {
    const f = fx({ forgeYamlAppend: 'policy:\n  freezeFiles: ["*.yaml"]\n' });
    f.write("frozen-file-marker", "");
    f.write("forge.yaml", f.read("forge.yaml") + "extraTop: 1\n");
    f.write("hooks/setup.sh", "#!/bin/sh\nexit 0\n");
    f.commit("undeclared key + foreign hooks file");
    const r = await gate(f, { acceptWeakening: "op: whatever" });
    expect(r.acceptedWeakening).toBeNull();
    f.cleanup();
  });
});

describe("CX-53 closure: base manifest support: !-glob is malformed", () => {
  it("support: ['!docs/**'] at --base refuses CORR-GATE-01", async () => {
    const f = fx();
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("support: []", 'support: ["!docs/**"]'),
    );
    const base = f.commit("negated support glob");
    const r = await gate(f, { base });
    expect(rules(r)).toContain("CORR-GATE-01");
    expect(r.violations.some((v) => /negation/.test(v.message))).toBe(true);
    f.cleanup();
  });
  it("a !-negation adopted at HEAD (not base) is inert for this diff", async () => {
    const f = fx();
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("support: []", 'support: ["!docs/**"]'),
    );
    f.commit("adopt negated support glob");
    const r = await gate(f);
    expect(r).toBeTruthy();
    f.cleanup();
  });
});

describe("CX-54 closure: blob-equal mode flips on frozen files are weakenings", () => {
  it("100644→100755 chmod on a frozen oracle reports frozen-file", async () => {
    const f = fx();
    chmodSync(path.join(f.root, ORACLE_PATH), 0o755);
    f.commit("chmod +x frozen oracle");
    const r = await gate(f);
    expect(wk(r).some((k) => k === `frozen-file:${ORACLE_PATH}`)).toBe(true);
    expect(r.weakenings.find((w) => w.subject === ORACLE_PATH)?.message).toMatch(
      /mode changed 100644 → 100755/,
    );
    f.cleanup();
  });
  it("100644→100755 on a frozen policy file reports a weakening", async () => {
    const f = fx({
      forgeYamlAppend: "policy:\n  freezeFiles: [hooks/**]\n",
      extraFiles: { "hooks/x.sh": "#!/bin/sh\nexit 0\n" },
    });
    chmodSync(path.join(f.root, "hooks/x.sh"), 0o755);
    f.commit("chmod +x");
    const r = await gate(f, { policyOnly: true });
    // modeWeakenings reports the documented `frozen-file` kind for every
    // blob-equal mode flip (module header contract), whichever set froze it.
    expect(wk(r).some((k) => k === "frozen-file:hooks/x.sh")).toBe(true);
    f.cleanup();
  });
  it("a verifier-trailer chmod commit exempts the mode weakening", async () => {
    const f = fx();
    chmodSync(path.join(f.root, ORACLE_PATH), 0o755);
    verifierCommit(f.git, ORACLE_PATH, "verifier: chmod");
    const r = await gate(f);
    expect(wk(r).some((k) => k === `frozen-file:${ORACLE_PATH}`)).toBe(false);
    f.cleanup();
  });
  it("a file→symlink flip with identical blob text reports a mode weakening", async () => {
    const f = fx({ extraFiles: { "tools/target.txt": "x\n" } });
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("support: []", 'support: ["frozen/**"]'),
    );
    f.write("frozen/link", "tools/target.txt");
    const base = f.commit("frozen file holding the future target text");
    f.git(["rm", "-q", "frozen/link"]);
    mkdirSync(path.join(f.root, "frozen"), { recursive: true });
    symlinkSync("tools/target.txt", path.join(f.root, "frozen/link"));
    f.git(["add", "frozen/link"]);
    f.git(["commit", "-qm", "symlink flip"]);
    const r = await gate(f, { base });
    // Same blob payload (the link text), mode 100644 → 120000.
    expect(wk(r).some((k) => k === "frozen-file:frozen/link")).toBe(true);
    expect(r.weakenings.find((w) => w.subject === "frozen/link")?.message).toMatch(
      /mode changed 100644 → 120000/,
    );
    f.cleanup();
  });
});

describe("CX-55 closure: inert-policy note says malformed policy refuses", () => {
  it("no base policy + malformed HEAD policy → note says 'refuses', not 'binds'", async () => {
    const f = fx();
    commitForgeYaml(f, `${BASE_YAML}policy: 5\n`, "adopt malformed policy");
    const r = await gate(f);
    const note = r.violations.find((v) => /policy checks inert/.test(v.message));
    expect(note?.message).toMatch(/malformed/);
    expect(note?.message).not.toMatch(/binds the next integration/);
    f.cleanup();
  });
});

describe("policy surface — structural probes", () => {
  it("a top-level __proto__ key added at HEAD is a policy-key weakening", async () => {
    const f = fx({ forgeYamlAppend: "policy:\n  mutable: [project]\n" });
    f.write("forge.yaml", f.read("forge.yaml") + "__proto__:\n  x: 1\n");
    f.commit("add proto key");
    const r = await gate(f, { policyOnly: true });
    expect(wk(r).some((k) => /policy-key/.test(k))).toBe(true);
    f.cleanup();
  });
  it("mutable: ['bindings.commands.checkRun'] (dotted leaf) does NOT release the checkRun freeze", async () => {
    const f = fx({
      forgeYamlAppend: 'policy:\n  mutable: ["bindings.commands.checkRun"]\n',
    });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "echo {file}"'),
    );
    f.commit("rebind checkRun");
    const r = await gate(f);
    expect(wk(r).some((k) => /binding/.test(k))).toBe(true);
    f.cleanup();
  });
  it("additive: [bindings] + checkRun change is a policy-key weakening", async () => {
    const f = fx({ forgeYamlAppend: "policy:\n  additive: [bindings]\n" });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "echo {file}"'),
    );
    f.commit("rebind checkRun under additive");
    const r = await gate(f, { policyOnly: true });
    expect(wk(r).some((k) => /policy-key/.test(k))).toBe(true);
    f.cleanup();
  });
  it("additive: [bindings] + a NEW leaf under bindings is legal", async () => {
    const f = fx({ forgeYamlAppend: "policy:\n  additive: [bindings]\n" });
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace('checkRun: "node {file}"', 'checkRun: "node {file}"\n    newCommand: "true"'),
    );
    f.commit("add a new binding leaf");
    const r = await gate(f, { policyOnly: true });
    expect(wk(r).every((k) => !/policy-key/.test(k))).toBe(true);
    f.cleanup();
  });
  it("policy: {} (empty map) is a well-formed deny-all declaration", async () => {
    const f = fx({ forgeYamlAppend: "policy: {}\n" });
    f.write("forge.yaml", f.read("forge.yaml") + "extraTop: 1\n");
    f.commit("undeclared key");
    const r = await gate(f, { policyOnly: true });
    expect(wk(r).some((k) => /policy-key/.test(k))).toBe(true);
    f.cleanup();
  });
  it("policy: [] and bare policy: are malformed → CORR-GATE-01", async () => {
    for (const pol of ["policy: []\n", "policy:\n", "policy: scalar\n"]) {
      const f = fx({ forgeYamlAppend: pol });
      const r = await gate(f, { policyOnly: true });
      expect(rules(r), `policy ${JSON.stringify(pol)}`).toContain("CORR-GATE-01");
      f.cleanup();
    }
  });
  it("mutable: ['!x'] is a key name, not a glob — well-formed", async () => {
    const f = fx({ forgeYamlAppend: 'policy:\n  mutable: ["!x"]\n' });
    const r = await gate(f, { policyOnly: true });
    expect(rules(r)).not.toContain("CORR-GATE-01");
    f.cleanup();
  });
});

describe("forge.yaml parse robustness", () => {
  it("a scalar forge.yaml refuses CORR-GATE-01", async () => {
    const f = fx();
    commitForgeYaml(f, "hello\n");
    const r = await gate(f, { policyOnly: true });
    expect(rules(r)).toContain("CORR-GATE-01");
    f.cleanup();
  });
  it("an array forge.yaml refuses CORR-GATE-01", async () => {
    const f = fx();
    commitForgeYaml(f, "[a, b]\n");
    const r = await gate(f, { policyOnly: true });
    expect(rules(r)).toContain("CORR-GATE-01");
    f.cleanup();
  });
  it("a multi-document forge.yaml refuses CORR-GATE-01", async () => {
    const f = fx();
    commitForgeYaml(f, "a: 1\n---\nb: 2\n");
    const r = await gate(f, { policyOnly: true });
    expect(rules(r)).toContain("CORR-GATE-01");
    f.cleanup();
  });
  it("a UTF-16 forge.yaml refuses CORR-GATE-01 without crashing", async () => {
    const f = fx();
    f.write("forge.yaml", Buffer.from("a: 1\n", "utf16le").toString("latin1"));
    f.commit("utf16");
    const r = await gate(f, { policyOnly: true });
    expect(rules(r)).toContain("CORR-GATE-01");
    f.cleanup();
  });
  it("a deeply nested forge.yaml refuses CORR-GATE-01 without crashing", async () => {
    const f = fx();
    const n = 100000;
    commitForgeYaml(f, "a: " + "[".repeat(n) + "1" + "]".repeat(n) + "\n");
    const r = await gate(f, { policyOnly: true });
    expect(rules(r)).toContain("CORR-GATE-01");
    f.cleanup();
  });
  it("an empty forge.yaml refuses CORR-GATE-01", async () => {
    const f = fx();
    commitForgeYaml(f, "");
    const r = await gate(f, { policyOnly: true });
    expect(rules(r)).toContain("CORR-GATE-01");
    f.cleanup();
  });
  it("a forge.yaml deleted at HEAD under a declared policy weakens", async () => {
    const f = fx({ forgeYamlAppend: "policy:\n  mutable: [project]\n" });
    f.git(["rm", "-q", "forge.yaml"]);
    f.git(["commit", "-qm", "delete forge.yaml"]);
    const r = await gate(f, { policyOnly: true });
    expect(rules(r)).toContain("CORR-GATE-02");
    f.cleanup();
  });
});

describe("accept path — isolation contours", () => {
  it("a whitespace-only --accept-weakening reason never accepts", async () => {
    const f = fx({
      forgeYamlAppend: "policy:\n  freezeFiles: [frozen/**]\n",
      extraFiles: { "frozen/x": "1\n" },
    });
    f.write("frozen/x", "2\n");
    f.commit("weaken");
    const r = await gate(f, { acceptWeakening: "   " });
    expect(r.acceptedWeakening).toBeNull();
    expect(rules(r)).toContain("CORR-GATE-02");
    f.cleanup();
  });
  it("--accept-weakening on a clean diff is inert", async () => {
    const f = fx({ forgeYamlAppend: "policy:\n  freezeFiles: [frozen/**]\n" });
    f.commit("no changes");
    const r = await gate(f, { policyOnly: true, acceptWeakening: "op: nothing" });
    expect(r.status).toBe("pass");
    expect(r.acceptedWeakening).toBeNull();
    f.cleanup();
  });
  it("a foreign file alongside a policy weakening is mixed-weakening", async () => {
    const f = fx({
      forgeYamlAppend: "policy:\n  freezeFiles: [frozen/**]\n",
      extraFiles: { "frozen/x": "1\n" },
    });
    f.write("frozen/x", "2\n");
    f.write("other.ts", "export {};\n");
    f.commit("weaken + foreign");
    const r = await gate(f, { acceptWeakening: "op: frozen swap" });
    expect(r.acceptedWeakening).toBeNull();
    expect(r.violations.some((v) => /mixed-weakening/.test(v.message))).toBe(true);
    f.cleanup();
  });
  it("a mutable-key forge.yaml edit bundled with a weakening is foreign", async () => {
    const f = fx({
      forgeYamlAppend: "policy:\n  mutable: [project]\n  freezeFiles: [frozen/**]\n",
      extraFiles: { "frozen/x": "1\n" },
    });
    f.write("frozen/x", "2\n");
    f.write("forge.yaml", f.read("forge.yaml").replace("name: gate-fixture", "name: renamed"));
    f.commit("weaken + legal mutable edit");
    const r = await gate(f, { acceptWeakening: "op: frozen swap" });
    // Doc contract: the session diff must be confined to frozen-set paths.
    expect(r.acceptedWeakening).toBeNull();
    f.cleanup();
  });
  it("an additive-key forge.yaml edit bundled with a weakening stays isolated", async () => {
    const f = fx({
      forgeYamlAppend: "policy:\n  additive: [paths]\n  freezeFiles: [frozen/**]\n",
      extraFiles: { "frozen/x": "1\n" },
    });
    f.write("frozen/x", "2\n");
    f.write("forge.yaml", f.read("forge.yaml").replace("paths: {}", "paths:\n  newDir: docs/x"));
    f.commit("weaken + additive leaf add");
    const r = await gate(f, { acceptWeakening: "op: frozen swap" });
    expect(r.acceptedWeakening).toBe("op: frozen swap");
    f.cleanup();
  });
  it("a deleted frozen file deleted by a verifier commit counts isolated", async () => {
    const f = fx({
      forgeYamlAppend: "policy:\n  freezeFiles: [frozen/**]\n",
      extraFiles: { "frozen/x": "1\n" },
    });
    f.git(["rm", "-q", "frozen/x"]);
    f.git([
      "commit",
      "-qm",
      "verifier: drop frozen/x\n\nX-Expectation-Origin: independent-verifier\nX-Verifier-Report: frozen/x",
    ]);
    f.write("frozen/y", "3\n");
    f.commit("weaken by addition");
    const r = await gate(f, { acceptWeakening: "op: add frozen/y" });
    expect(r.acceptedWeakening).toBe("op: add frozen/y");
    f.cleanup();
  });
  it("adopting policy: inside an accepted weakening session is not foreign (CX-36)", async () => {
    const f = fx();
    f.write(
      "docs/correctness.yaml",
      "schema: forge/correctness-manifest@1\nentries: []\nsupport: []\nexemptions: []\n",
    );
    f.write("forge.yaml", f.read("forge.yaml") + "policy:\n  mutable: [project]\n");
    f.commit("drop entries + adopt policy");
    const r = await gate(f, { acceptWeakening: "op: retire entries, adopt policy" });
    expect(r.acceptedWeakening).toBe("op: retire entries, adopt policy");
    f.cleanup();
  });
});

describe("inert-policy note invariants", () => {
  const inertNotes = (r: { violations: { message: string }[] }) =>
    r.violations.filter((v) => /policy checks inert/.test(v.message)).length;
  it("exactly one inert note on enforce contour with no policy", async () => {
    const f = fx();
    const r = await gate(f);
    expect(inertNotes(r)).toBe(1);
    f.cleanup();
  });
  it("exactly one inert note on warn contour", async () => {
    const f = fx({ mode: "warn" });
    const r = await gate(f);
    expect(inertNotes(r)).toBe(1);
    f.cleanup();
  });
  it("exactly one inert note on the exempt early return", async () => {
    const f = fx({ mode: "exempt" });
    const r = await gate(f);
    expect(inertNotes(r)).toBe(1);
    expect(r.status).toBe("exempt");
    f.cleanup();
  });
  it("exactly one inert note under --policy-only", async () => {
    const f = fx();
    const r = await gate(f, { policyOnly: true });
    expect(inertNotes(r)).toBe(1);
    f.cleanup();
  });
});

describe("exempt contour judging declared policy (CX-29)", () => {
  it("exempt×exempt + declared base policy + policy weakening refuses", async () => {
    const f = fx({
      mode: "exempt",
      forgeYamlAppend: "policy:\n  freezeFiles: [frozen/**]\n",
      extraFiles: { "frozen/x": "1\n" },
    });
    f.write("frozen/x", "2\n");
    f.commit("weaken a frozen file");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(rules(r)).toContain("CORR-GATE-02");
    f.cleanup();
  });
  it("exempt×exempt + declared base policy + clean diff passes exempt", async () => {
    const f = fx({ mode: "exempt", forgeYamlAppend: "policy:\n  freezeFiles: [frozen/**]\n" });
    f.commit("nothing");
    const r = await gate(f);
    expect(r.status).not.toBe("fail");
    f.cleanup();
  });
});

describe("review record robustness", () => {
  it("a cyclic review record does not crash the gate", async () => {
    const f = fx({ review: false });
    const rel = "docs/correctness/reviews/cyclic.yaml";
    f.write(rel, "schema: forge/oracle-review@1\noracles: &o\n  - check: *o\nverdict: pass\n");
    verifierCommit(f.git, rel);
    const r = await gate(f);
    expect(r).toBeTruthy();
    f.cleanup();
  });
  it("a review record dir bound at a file does not crash", async () => {
    const f = fx();
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace(
          "    correctnessManifest: docs/correctness.yaml\n",
          "    correctnessManifest: docs/correctness.yaml\n    oracleReviewsDir: forge.yaml\n",
        ),
    );
    f.commit("rebind reviews dir to a file");
    const r = await gate(f);
    expect(r).toBeTruthy();
    f.cleanup();
  });
});

describe("misc structural edges", () => {
  it("checkRun adoption under a DECLARED contour is a binding weakening — CX-77", async () => {
    // Pre-CX-77 this was documented adoption — the verifier proved it
    // fail-open: a session-bound checkRun runs its own runner and attests
    // without executing the oracle. Adoption under a declared contour now
    // lands only through --accept-weakening.
    const f = fx();
    f.write("forge.yaml", f.read("forge.yaml").replace('    checkRun: "node {file}"\n', ""));
    const base = f.commit("drop checkRun at base");
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("  commands:\n", '  commands:\n    checkRun: "node {file}"\n'),
    );
    f.commit("adopt checkRun");
    const r = await gate(f, { base });
    expect(wk(r).some((k) => /binding/.test(k))).toBe(true);
    f.cleanup();
  });
  it("a mode flip on an anchor-source file (not in frozen files) is unjudged — documented", async () => {
    const f = fx();
    chmodSync(path.join(f.root, "apps/api/src/dispatch.ts"), 0o755);
    f.commit("chmod anchor source");
    const r = await gate(f);
    expect(wk(r).every((k) => !/dispatch\.ts/.test(k))).toBe(true);
    f.cleanup();
  });
  it("a git mv of a frozen file is a weakening and the new path is foreign", async () => {
    const f = fx();
    f.git(["mv", ORACLE_PATH, "test/renamed.oracle.ts"]);
    f.git(["commit", "-qm", "rename oracle"]);
    const r = await gate(f);
    expect(r.weakenings.length).toBeGreaterThan(0);
    f.cleanup();
  });
  it("a frozen file replaced by a directory reports a byte weakening", async () => {
    const f = fx();
    f.git(["rm", "-q", ORACLE_PATH]);
    f.write("test/dispatch.oracle.ts/inside.ts", "export {};\n");
    f.commit("file to dir");
    const r = await gate(f);
    expect(wk(r).some((k) => /dispatch\.oracle\.ts/.test(k))).toBe(true);
    f.cleanup();
  });
  it("support: ['['] malformed glob does not crash", async () => {
    const f = fx();
    f.write("docs/correctness.yaml", manifestYaml({}).replace("support: []", 'support: ["["]'));
    f.commit("lbracket support");
    const r = await gate(f);
    expect(r).toBeTruthy();
    f.cleanup();
  });
  it("freezeFiles: ['x/../forge.yaml'] leaves forge.yaml judged by the key strip alone", async () => {
    const f = fx({ forgeYamlAppend: 'policy:\n  freezeFiles: ["x/../forge.yaml"]\n' });
    f.write("forge.yaml", f.read("forge.yaml") + "extraTop: 1\n");
    f.commit("undeclared key");
    const r = await gate(f, { policyOnly: true });
    expect(wk(r).some((k) => /policy-key/.test(k))).toBe(true);
    expect(wk(r).every((k) => !/policy-file:forge\.yaml/.test(k))).toBe(true);
    f.cleanup();
  });
  it("a file under BOTH support and freezeFiles globs reports both kinds — documented overlap", async () => {
    const f = fx({
      forgeYamlAppend: "policy:\n  freezeFiles: [frozen/**]\n",
      extraFiles: { "frozen/x": "1\n" },
    });
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("support: []", 'support: ["frozen/**"]'),
    );
    const base = f.commit("dual freeze");
    f.write("frozen/x", "2\n");
    f.commit("weaken dual-frozen file");
    const r = await gate(f, { base });
    const kinds = wk(r).filter((k) => /frozen\/x/.test(k));
    expect(kinds.length).toBeGreaterThan(0);
    f.cleanup();
  });
  it("policy-only releases the binding check under mutable:[bindings] — documented", async () => {
    const f = fx({ forgeYamlAppend: "policy:\n  mutable: [bindings]\n" });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "echo {file}"'),
    );
    f.commit("rebind under policy-only");
    const r = await gate(f, { policyOnly: true });
    expect(wk(r).every((k) => !/binding/.test(k))).toBe(true);
    f.cleanup();
  });
});
