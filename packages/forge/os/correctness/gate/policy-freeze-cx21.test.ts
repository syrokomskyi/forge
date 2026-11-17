/*
 * Round-20 adversarial probes for the correctness gate (RFC-1615).
 * Every test asserts the SECURE verdict — a failure is a live counterexample.
 * Targeted surfaces: sameTarget/posix.normalize binding compares, checkRun
 * argv divergence, rfcPath rank parity vs the worktree findRfcFile,
 * pruneEmpties/canon tag collisions, accept-isolation laundering.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canon,
  diffWeakenings,
  policyLeaves,
  policyWeakenings,
  sideFrom,
  type CorrectnessSide,
  type FrozenSet,
} from "./frozen.ts";
import { rfcPath } from "./origin.ts";
import type { GateRepo } from "./repo.ts";
import { runCorrectnessGate } from "./run.ts";
import { checkRunArgv } from "./runner.ts";
import { resolveRfcRef } from "../references.ts";
import { makeGateFixture, type GateFixture } from "./tests/gate-fixture.ts";

const fixtures: GateFixture[] = [];
const dirs: string[] = [];
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.cleanup());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const fx = (o: Parameters<typeof makeGateFixture>[0] = {}) => {
  const f = makeGateFixture(o);
  fixtures.push(f);
  return f;
};
const gate = async (f: GateFixture, acceptWeakening?: string) => {
  const out = await runCorrectnessGate(f.root, {
    base: f.base,
    bundleDir: `${f.root}/.bundles`,
    acceptWeakening,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
};

/* ---------------------------------------------------------------- helpers */

const side = (yaml: string): CorrectnessSide => sideFrom(yaml, () => null);
const frozenOf = (yaml: string): FrozenSet =>
  ({
    base: side(yaml),
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
  }) as FrozenSet;

const CONTOUR = `paths: {}
bindings:
  commands:
    checkRun: "node {file}"
  paths:
    compassDocs: [docs/requirements.xml]
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: enforce
  tier: standard
`;

const withCheckRun = (cmd: string) =>
  CONTOUR.replace('checkRun: "node {file}"', `checkRun: "${cmd}"`);

/** A GateRepo whose ls-tree returns `files` for the rfcsDir pathspec. */
const repoListing = (files: string[], prefix = "docs/rfcs"): GateRepo =>
  ({
    unreadableReads: [],
    listing: async () => files.map((f) => `${prefix}/${f}`).join("\0") + "\0",
  }) as unknown as GateRepo;

/** Build a real worktree `docs/rfcs` matching `files` and resolve RFC-0001/AC-1 via findRfcFile. */
const worktreeWinner = (files: string[]): string | null => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rfcref-"));
  dirs.push(root);
  for (const rel of files) {
    const abs = path.join(root, "docs/rfcs", rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "## Acceptance criteria\n\n- [ ] AC-1: x\n");
  }
  const res = resolveRfcRef(root, "docs/rfcs", "RFC-0001/AC-1", "AC");
  return res.ok ? res.rfcFile : null;
};

/** ls-tree-flavoured rfcPath winner for the same tree (paths emitted like git: full repo-root paths). */
const gitWinner = async (files: string[]): Promise<string | null> =>
  rfcPath(repoListing(files), "HEAD", "docs/rfcs", "RFC-0001");

/* ---------------------------------------------------------------- CX-126/127 */

describe("CX-126/127: sameTarget checkRun divergence (normalize crosses the argv boundary)", () => {
  // `checkRunArgv` splits on whitespace and spawns argv[0]; path.posix.normalize
  // folds `./` and `x/../` BEFORE tokenization, so two DIFFERENT argv vectors
  // (different executables) are judged "same target" — the runner rebind is
  // invisible to CORR-GATE-02. Next integration inherits the rebound binding
  // and `spawn("<repo>/...")` executes a session-committed file as the runner.
  it("CX-126a: 'node {file}' → './node {file}' rebinds argv[0] to a repo file and must report a binding weakening", () => {
    const w = diffWeakenings(
      frozenOf(withCheckRun("node {file}")),
      side(withCheckRun("./node {file}")),
    );
    expect(checkRunArgv("./node {file}", "f.ts")[0]).toBe("./node"); // spawn: <cwd>/node
    expect(
      w.filter((x) => x.kind === "binding" && x.subject === "bindings.commands.checkRun").length,
      "checkRun './' rebind judged same while argv[0] resolves a different executable",
    ).toBeGreaterThan(0);
  });

  it("CX-126b: 'node {file}' → 'sub/../node {file}' hides a repo-relative executable behind '..' collapse", () => {
    const w = diffWeakenings(
      frozenOf(withCheckRun("node {file}")),
      side(withCheckRun("sub/../node {file}")),
    );
    expect(checkRunArgv("sub/../node {file}", "f.ts")[0]).toBe("sub/../node");
    expect(
      w.filter((x) => x.kind === "binding" && x.subject === "bindings.commands.checkRun").length,
      "checkRun '..' rebind judged same while argv[0] resolves a different executable",
    ).toBeGreaterThan(0);
  });

  it("CX-127: 'node {file}' → 'pnpm exec/../node {file}' swaps the whole executable — normalize pops a whitespace-containing segment", () => {
    const w = diffWeakenings(
      frozenOf(withCheckRun("node {file}")),
      side(withCheckRun("pnpm exec/../node {file}")),
    );
    expect(checkRunArgv("pnpm exec/../node {file}", "f.ts")).toEqual([
      "pnpm",
      "exec/../node",
      "f.ts",
    ]);
    expect(
      w.filter((x) => x.kind === "binding" && x.subject === "bindings.commands.checkRun").length,
      "checkRun argv[0] changed node→pnpm with zero reported weakening",
    ).toBeGreaterThan(0);
  });

  it("e2e: a planted executable + './node' rebind is not judged as a weakening at all", async () => {
    const f = fx({ mode: "warn" });
    f.write("node", "#!/bin/sh\n# planted runner\nexec /bin/true\n");
    chmodSync(path.join(f.root, "node"), 0o755);
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "./node {file}"'),
    );
    f.commit("plant runner + rebind checkRun");
    const r = await gate(f);
    // secure verdict: CORR-GATE-02 names the checkRun rebind — a './' argv[0] is NOT the same target
    expect(
      r.violations.filter(
        (v) => v.rule === "CORR-GATE-02" && /bindings\.commands\.checkRun/.test(v.message),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("e2e stage-2: once the './node' binding is integrated, the next gate RUNS the planted repo binary as the oracle runner", async () => {
    const f = fx();
    // Stage 1 (already proven unjudged above): plant an executable and rebind.
    f.write("node", `#!/bin/sh\necho pwned > "${"R"}EPO-PWNED"\nexit 0\n`);
    chmodSync(path.join(f.root, "node"), 0o755);
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "./node {file}"'),
    );
    f.commit("plant runner + rebind checkRun");
    const poisonedBase = f.git(["rev-parse", "HEAD"]);
    // Stage 2: an unrelated session diff — the gate now runs the PLANTED
    // './node' as the oracle runner (base binding wins over head's).
    f.write("apps/api/src/unrelated.ts", "export const y = 2;\n");
    f.commit("unrelated");
    const out = await runCorrectnessGate(f.root, {
      base: poisonedBase,
      bundleDir: `${f.root}/.bundles`,
    });
    if (!out.ok) throw new Error(out.usageError);
    void out;
    // secure verdict: the oracle runner is the PATH 'node', never <repo>/node —
    // the planted binary must NOT execute.
    expect(existsSync(path.join(f.root, "REPO-PWNED")), "session binary ran as oracle runner").toBe(
      false,
    );
  });
});

/* ---------------------------------------------------------------- CX-128 */

describe("CX-128: canon/policyLeaves cycle sentinels collide with literal strings", () => {
  it("CX-128a: canon({self:'cycle'}) must differ from canon({self: <the same object>}) — sentinel/string collision", () => {
    const cyc: Record<string, unknown> = {};
    cyc["self"] = cyc;
    // If canon cannot tell a literal 'cycle' string from a real cycle, a byte
    // change under a kept (non-frozen) key is invisible to the isolation strip.
    expect(canon({ self: "cycle" })).not.toBe(canon(cyc));
  });

  it("CX-128b: policyLeaves '<cycle>' leaf must differ from a literal '<cycle>' string", () => {
    const cyc: Record<string, unknown> = {};
    cyc["self"] = cyc;
    const before = policyLeaves({ self: "<cycle>" });
    const after = policyLeaves(cyc);
    expect(canon(before.get('["self"]'))).not.toBe(canon(after.get('["self"]')));
  });

  it("CX-128c: an additive key whose existing leaf becomes a cycle reports policy-key", () => {
    const baseYaml = `policy:\n  mutable: []\n  additive: [k]\nk:\n  self: "<cycle>"\n`;
    const headYaml = `policy:\n  mutable: []\n  additive: [k]\nk: &k\n  self: *k\n`;
    const w = policyWeakenings(frozenOf(baseYaml), side(headYaml));
    expect(w.filter((x) => x.kind === "policy-key").length).toBeGreaterThan(0);
  });

  it("CX-128d: a frozen key whose leaf becomes a cycle still diffs at the key level", () => {
    const baseYaml = `policy:\n  mutable: []\n  additive: []\nk:\n  self: "cycle"\n`;
    const headYaml = `policy:\n  mutable: []\n  additive: []\nk: &k\n  self: *k\n`;
    const w = policyWeakenings(frozenOf(baseYaml), side(headYaml));
    expect(w.filter((x) => x.kind === "policy-key").length).toBeGreaterThan(0);
  });

  it("CX-128e e2e: 'self: \"cycle\"' → 'self: *cycle' in a kept key launders through --accept-weakening", async () => {
    const f = fx({ mode: "warn" });
    // base: a kept (non-frozen) top-level key carrying the sentinel-looking string
    f.write("forge.yaml", f.read("forge.yaml") + `extra:\n  self: "cycle"\n`);
    f.commit("base extra key");
    const base2 = f.git(["rev-parse", "HEAD"]);
    // head: same shape but the leaf is a real YAML cycle + a real binding weakening
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace(`extra:\n  self: "cycle"`, `extra: &extra\n  self: *extra`),
    );
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "true {file}"'),
    );
    f.commit("cycle swap + checkRun weaken");
    const out = await runCorrectnessGate(f.root, {
      base: base2,
      bundleDir: `${f.root}/.bundles`,
      acceptWeakening: "operator: checkRun swap",
    });
    if (!out.ok) throw new Error(out.usageError);
    const mixed = out.result.violations.filter(
      (v) => v.rule === "CORR-GATE-02" && /mixed-weakening/.test(v.message),
    );
    // secure verdict: 'extra' is a foreign non-frozen key → its byte change must
    // make forge.yaml non-isolated → mixed-weakening, NOT an accepted weakening.
    expect(mixed.length, "cycle-collided foreign change laundered as isolated").toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------- CX-129 */

describe("CX-129: YAML-controlled NUL in a binding path must refuse, not crash", () => {
  it("manifestPath with a NUL byte → structured refusal, not a rejected promise", async () => {
    const f = fx();
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("correctnessManifest: docs/correctness.yaml", 'correctnessManifest: "a\\0b.yaml"'),
    );
    f.commit("nul path");
    const out = await runCorrectnessGate(f.root, {
      base: f.base,
      bundleDir: `${f.root}/.bundles`,
    });
    // secure verdict: the gate reports and refuses; it never throws TypeError out of execFile
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.status).toBe("fail");
  });
});

/* ---------------------------------------------------------------- CX-120..123 regressions */

describe("regressions CX-120..CX-123 still hold", () => {
  it("CX-120: a literal backslash in a path binding is still a weakening (POSIX char, different file)", () => {
    const w = diffWeakenings(
      frozenOf(CONTOUR),
      side(
        CONTOUR.replace(
          "correctnessManifest: docs/correctness.yaml",
          "correctnessManifest: docs\\\\correctness.yaml",
        ),
      ),
    );
    expect(w.some((x) => x.subject === "bindings.paths.correctnessManifest")).toBe(true);
  });

  it("CX-122: a leading-space path binding is still a weakening", () => {
    const w = diffWeakenings(
      frozenOf(CONTOUR),
      side(
        CONTOUR.replace(
          "correctnessManifest: docs/correctness.yaml",
          'correctnessManifest: " docs/correctness.yaml"',
        ),
      ),
    );
    expect(w.some((x) => x.subject === "bindings.paths.correctnessManifest")).toBe(true);
  });

  it("CX-123: whitespace-collapsed checkRun spellings remain same (regression — must NOT flag)", () => {
    const w = diffWeakenings(
      frozenOf(withCheckRun("node   {file}")),
      side(withCheckRun("node {file}")),
    );
    expect(w.filter((x) => x.subject === "bindings.commands.checkRun").length).toBe(0);
  });

  it("CX-121: rfcPath rank uses code-unit order (locale 'a'<'Z' trap), files beat dirs", async () => {
    // root file beats archive subtree
    expect(await gitWinner(["rfc-0001-root.md", "archive/rfc-0001-arch.md"])).toBe(
      "docs/rfcs/rfc-0001-root.md",
    );
    // dir 'a' descends before dir 'Z' (LIFO over code-unit sort [Z,a])
    expect(await gitWinner(["archive/Z/rfc-0001-z.md", "archive/a/rfc-0001-a.md"])).toBe(
      "docs/rfcs/archive/a/rfc-0001-a.md",
    );
    // a file at a level beats any dir at that level regardless of name
    expect(await gitWinner(["archive/a/rfc-0001-in.md", "archive/rfc-0001-zfile.md"])).toBe(
      "docs/rfcs/archive/rfc-0001-zfile.md",
    );
  });
});

/* ---------------------------------------------------------------- rfcPath parity sweep */

describe("rfcPath ↔ findRfcFile traversal parity", () => {
  const trees: string[][] = [
    ["rfc-0001-a.md"],
    ["archive/rfc-0001-a.md"],
    ["rfc-0001-a.md", "archive/rfc-0001-b.md"],
    ["archive/a/rfc-0001-x.md", "archive/b/rfc-0001-y.md"],
    ["archive/z/rfc-0001-x.md", "archive/rfc-0001-top.md"],
    [
      "archive/deep/a/rfc-0001-x.md",
      "archive/deep/b/rfc-0001-y.md",
      "archive/deep/rfc-0001-top.md",
    ],
    ["archive/é/rfc-0001-e.md", "archive/z/rfc-0001-z.md"],
    ["archive/1/rfc-0001-d.md", "archive/9/rfc-0001-n.md", "rfc-0001-root.md"],
    ["x/rfc-0001-notinscope.md", "archive/rfc-0001-a.md"],
    ["archive.md", "archive/rfc-0001-a.md"],
    ["archive/rfc-0001-a.md/rfc-0001-b.md"], // dir named like an rfc file containing one
  ];
  for (const files of trees) {
    it(`parity: [${files.join(", ")}]`, async () => {
      const git = await gitWinner(files);
      const wt = worktreeWinner(files);
      // same winner (or both null) — the base-anchored resolver must pick the
      // file the worktree resolver would.
      expect(git).toBe(wt);
    });
  }
});

/* ---------------------------------------------------------------- CX-130+ misc */

describe("misc surfaces", () => {
  it("accept-isolation: a planted sibling under paths: is foreign, not stripped", async () => {
    const f = fx({ mode: "warn" });
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("paths: {}", "paths:\n  rfcsDir: docs/rfcs\n  planted: foreign")
        .replace('checkRun: "node {file}"', 'checkRun: "true {file}"'),
    );
    f.commit("rebind + plant paths.planted");
    const r = await gate(f, "operator: rebind");
    expect(
      r.violations.filter((v) => v.rule === "CORR-GATE-02" && /mixed-weakening/.test(v.message))
        .length,
    ).toBeGreaterThan(0);
  });

  it("oracleReviewsDir glob pathspec: 'docs/**' bound at head is a weakening (frozen binding)", () => {
    const w = diffWeakenings(frozenOf(CONTOUR), side(CONTOUR + "bindings2: {}"));
    // no reviewsDir in base — adding one under a declared contour is a binding add
    const head = side(
      CONTOUR.replace(
        "correctnessManifest: docs/correctness.yaml",
        "correctnessManifest: docs/correctness.yaml\n    oracleReviewsDir: docs/**",
      ),
    );
    const w2 = diffWeakenings(frozenOf(CONTOUR), head);
    expect(
      w2.filter((x) => x.subject === "bindings.paths.oracleReviewsDir").length,
    ).toBeGreaterThan(0);
    void w;
  });

  it("NUL byte inside a plain (non-binding) changed path cannot occur from git — but a NUL rfcsDir must not crash", async () => {
    const f = fx();
    f.write("forge.yaml", f.read("forge.yaml").replace("paths: {}", 'paths:\n  rfcsDir: "a\\0b"'));
    f.commit("nul rfcsDir");
    const out = await runCorrectnessGate(f.root, {
      base: f.base,
      bundleDir: `${f.root}/.bundles`,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.status).toBe("fail");
  });
});
