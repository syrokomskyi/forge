/*
RFC-1615 round-17 adversarial verification probes — written by the independent
verifier, additive only. Covers the round-16 delta:

  1. `rfcPath` scope/ordering (`.`/`""` rfcsDir, trailing slash, archive-only
     scope, root-beats-archive, case sensitivity, non-archive dirs).
  2. `forgeYamlOnlyFrozenKeys` strip+pruneEmpties (CX-112..114 fix claims +
     laundering attempts: non-frozen siblings, retyped containers, dead keys).
  3. `bindings.paths.invariantsFile` judged binding — canon edge values.
  4. findRfcFile (worktree) parity oracle — where the two resolvers disagree.

Repos are hermetic temp git repos committed at test time; "base" is the
first commit, session edits land in a second commit.
*/

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { diffWeakenings, sideFrom, type FrozenSet } from "./frozen.ts";
import { rfcPath } from "./origin.ts";
import { GateRepo } from "./repo.ts";
import { runCorrectnessGate } from "./run.ts";
import { resolveRfcRef } from "../references.ts";

interface Repo {
  root: string;
  base: string;
  write(rel: string, body: string): void;
  read(rel: string): string;
  git(args: string[]): string;
  commit(message: string): string;
}

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

const mkRepo = (forgeYaml: string, files: Record<string, string> = {}): Repo => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gate-r17-"));
  roots.push(root);
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = (message: string) => {
    git(["add", "-A"]);
    git(["commit", "-qm", message, "--allow-empty"]);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "-q", "-b", "develop"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  write("forge.yaml", forgeYaml);
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  commit("base");
  return {
    root,
    base: git(["rev-parse", "HEAD"]),
    write,
    read: (rel) => readFileSync(path.join(root, rel), "utf8"),
    git,
    commit,
  };
};

const gate = async (r: Repo, extra: { acceptWeakening?: string; policyOnly?: boolean } = {}) => {
  const out = await runCorrectnessGate(r.root, {
    base: r.base,
    bundleDir: `${r.root}/.bundles`,
    ...extra,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
};

const FORGE = (
  paths: string,
  bindingsPaths = "correctnessManifest: docs/correctness.yaml",
) => `schema: forge/config@1
project:
  name: r17
${paths}bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
  paths:
    ${bindingsPaths}
correctness:
  mode: warn
`;

const RFC = (ids: string[]) => `---
id: RFC-0100
status: accepted
---

## Acceptance criteria

${ids.map((i) => `- [ ] ${i}: criterion ${i}`).join("\n")}
`;

const MANIFEST = (ref: string) => `schema: forge/correctness-manifest@1
entries:
  - id: CM-t-01
    source: rfc-ac
    ref: ${ref}
    seam: data
    anchors: [INV-x]
    oracles:
      - check: test:test/ok.ts
        substrate: L0
support: []
exemptions: []
`;

const corr03 = (r: { violations: { message: string }[] }) =>
  r.violations.filter((v) => v.message.includes("CORR-03")).map((v) => v.message);
const weak = (r: { violations: { rule: string; message: string }[] }) =>
  r.violations.filter((v) => v.rule === "CORR-GATE-02").map((v) => v.message);

// A repo where the RFC namespace is exercised under every edge layout.
const RFC_FILES = {
  "docs/rfcs/rfc-0100-root.md": RFC(["AC-1"]),
  "docs/rfcs/archive/rfc-0100-arch.md": RFC(["AC-2"]),
  "docs/rfcs/archive/deep/rfc-0100-deep.md": RFC(["AC-3"]),
  "docs/rfcs/other/rfc-0100-other.md": RFC(["AC-4"]),
  "docs/rfcs/Archive/rfc-0100-cap.md": RFC(["AC-5"]),
  "docs/rfcs/archivefoo/rfc-0100-foo.md": RFC(["AC-6"]),
  "rfc-0100-top.md": RFC(["AC-7"]),
  "archive/rfc-0100-rootarch.md": RFC(["AC-8"]),
};

describe("rfcPath — scope and ordering (CX-113/CX-114)", () => {
  it("root-level match beats archive duplicates", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n"), RFC_FILES);
    const repo = new GateRepo(r.root);
    expect(await rfcPath(repo, r.base, "docs/rfcs", "RFC-0100")).toBe("docs/rfcs/rfc-0100-root.md");
  });

  it("without a root file the first archive-subtree match wins (ls order)", async () => {
    const { "docs/rfcs/rfc-0100-root.md": _d, ...files } = RFC_FILES;
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n"), files);
    const repo = new GateRepo(r.root);
    // ls-tree order inside docs/rfcs/archive: `deep/` sorts before the file —
    // the gate picks archive/deep/rfc-0100-deep.md.
    const rel = await rfcPath(repo, r.base, "docs/rfcs", "RFC-0100");
    expect(rel).toBe("docs/rfcs/archive/deep/rfc-0100-deep.md");
    // …but the worktree findRfcFile checks same-level files before descending —
    // it picks archive/rfc-0100-arch.md. DIVERGENCE (see report O-8).
    const wt = await resolveRfcRef(r.root, "docs/rfcs", "RFC-0100/AC-2", "AC");
    expect(wt.ok ? wt.rfcFile : wt).toBe("docs/rfcs/archive/rfc-0100-arch.md");
  });

  it("trailing slash rfcsDir normalizes identically", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n"), RFC_FILES);
    const repo = new GateRepo(r.root);
    expect(await rfcPath(repo, r.base, "docs/rfcs/", "RFC-0100")).toBe(
      "docs/rfcs/rfc-0100-root.md",
    );
  });

  it('rfcsDir "." scopes to repo root files + root archive/ subtree', async () => {
    const r = mkRepo(FORGE('paths:\n  rfcsDir: "."\n'), RFC_FILES);
    const repo = new GateRepo(r.root);
    expect(await rfcPath(repo, r.base, ".", "RFC-0100")).toBe("rfc-0100-top.md");
    // worktree parity for the same pick
    const wt = await resolveRfcRef(r.root, ".", "RFC-0100/AC-7", "AC");
    expect(wt.ok ? wt.rfcFile : wt).toBe("rfc-0100-top.md");
  });

  it('rfcsDir "" and "./" both resolve like "." (CX-115 fixed)', async () => {
    const r = mkRepo(FORGE('paths:\n  rfcsDir: "."\n'), RFC_FILES);
    const repo = new GateRepo(r.root);
    expect(await rfcPath(repo, r.base, "", "RFC-0100")).toBe("rfc-0100-top.md");
    // CX-115 (fixed): normalizeRelPath("./") → "" no longer reaches the
    // ls-tree pathspec — "." substitutes, so "./" resolves the repo root like
    // the worktree findRfcFile(path.join(root,"./")) does.
    const before = repo.unreadableReads.length;
    expect(await rfcPath(repo, r.base, "./", "RFC-0100")).toBe("rfc-0100-top.md");
    expect(repo.unreadableReads.length).toBe(before);
    const wt = await resolveRfcRef(r.root, "./", "RFC-0100/AC-7", "AC");
    expect(wt.ok ? wt.rfcFile : wt).toBe("rfc-0100-top.md");
  });

  it('rfcsDir " " (whitespace) normalizes to "." and resolves', async () => {
    const r = mkRepo(FORGE('paths:\n  rfcsDir: "."\n'), RFC_FILES);
    const repo = new GateRepo(r.root);
    expect(await rfcPath(repo, r.base, " ", "RFC-0100")).toBe("rfc-0100-top.md");
  });

  it('rfcsDir "." without a root file finds the root archive/ subtree', async () => {
    const { "rfc-0100-top.md": _d, ...files } = RFC_FILES;
    const r = mkRepo(FORGE('paths:\n  rfcsDir: "."\n'), files);
    const repo = new GateRepo(r.root);
    expect(await rfcPath(repo, r.base, ".", "RFC-0100")).toBe("archive/rfc-0100-rootarch.md");
  });

  it("non-archive sibling dirs (other/, Archive/, archivefoo/) are out of scope", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n"), {
      "docs/rfcs/other/rfc-0100-other.md": RFC(["AC-4"]),
      "docs/rfcs/Archive/rfc-0100-cap.md": RFC(["AC-5"]),
      "docs/rfcs/archivefoo/rfc-0100-foo.md": RFC(["AC-6"]),
    });
    const repo = new GateRepo(r.root);
    expect(await rfcPath(repo, r.base, "docs/rfcs", "RFC-0100")).toBeNull();
    // worktree resolver agrees (all three skipped at root level)
    const wt = await resolveRfcRef(r.root, "docs/rfcs", "RFC-0100/AC-4", "AC");
    expect(wt.ok).toBe(false);
  });

  it("rfcsDir that IS the archive dir: direct children + nested archive only", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs/archive\n"), {
      "docs/rfcs/archive/rfc-0100-direct.md": RFC(["AC-1"]),
      "docs/rfcs/archive/sub/rfc-0100-sub.md": RFC(["AC-2"]),
      "docs/rfcs/archive/archive/rfc-0100-nested.md": RFC(["AC-3"]),
    });
    const repo = new GateRepo(r.root);
    // direct child wins (root of the bound dir)
    expect(await rfcPath(repo, r.base, "docs/rfcs/archive", "RFC-0100")).toBe(
      "docs/rfcs/archive/rfc-0100-direct.md",
    );
    // drop the direct child — nested `archive/` still in scope, `sub/` not
    r.git(["rm", "-q", "docs/rfcs/archive/rfc-0100-direct.md"]);
    r.git(["commit", "-qm", "drop", "--allow-empty"]);
    const head = r.git(["rev-parse", "HEAD"]);
    expect(await rfcPath(repo, head, "docs/rfcs/archive", "RFC-0100")).toBe(
      "docs/rfcs/archive/archive/rfc-0100-nested.md",
    );
  });

  it("multi archive subdirs: gate picks ls-first (a/), worktree picks LIFO (b/)", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n"), {
      "docs/rfcs/archive/a/rfc-0100-a.md": RFC(["AC-1"]),
      "docs/rfcs/archive/b/rfc-0100-b.md": RFC(["AC-2"]),
    });
    const repo = new GateRepo(r.root);
    expect(await rfcPath(repo, r.base, "docs/rfcs", "RFC-0100")).toBe(
      "docs/rfcs/archive/a/rfc-0100-a.md",
    );
    // findRfcFile pushes [a,b] onto a stack → b pops first → DIVERGENCE (O-8).
    const wt = await resolveRfcRef(r.root, "docs/rfcs", "RFC-0100/AC-2", "AC");
    expect(wt.ok ? wt.rfcFile : wt).toBe("docs/rfcs/archive/b/rfc-0100-b.md");
  });

  it("rfcsDir outside the repo (.., absolute) resolves nothing, fails closed", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n"), RFC_FILES);
    const repo = new GateRepo(r.root);
    expect(await rfcPath(repo, r.base, "..", "RFC-0100")).toBeNull();
    expect(await rfcPath(repo, r.base, "/abs/path", "RFC-0100")).toBeNull();
  });

  it("rfcsDir naming a blob resolves nothing", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n"), {
      "docs/rfcs": "a file, not a dir\n",
    });
    const repo = new GateRepo(r.root);
    expect(await rfcPath(repo, r.base, "docs/rfcs", "RFC-0100")).toBeNull();
  });

  it("a symlinked archive dir is out of scope for the gate", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n"), {
      "real-archive/rfc-0100-target.md": RFC(["AC-1"]),
      "docs/rfcs/.keep": "",
    });
    symlinkSync("../../real-archive", path.join(r.root, "docs/rfcs/archive"));
    r.commit("link");
    const repo = new GateRepo(r.root);
    expect(await rfcPath(repo, r.git(["rev-parse", "HEAD"]), "docs/rfcs", "RFC-0100")).toBeNull();
    // …while the worktree resolver follows the symlink — divergence documented (O-9).
    const wt = await resolveRfcRef(r.root, "docs/rfcs", "RFC-0100/AC-1", "AC");
    expect(wt.ok).toBe(true);
  });
});

describe("CORR-03 end-to-end through the gate (rfc-ac refs at base)", () => {
  const baseFiles = (ref: string, extra: Record<string, string>) => ({
    "docs/correctness.yaml": MANIFEST(ref),
    "test/ok.ts": 'console.log("ok");\n',
    ...extra,
  });

  it("root-level base RFC wins over an archive duplicate (AC-1 resolves, AC-2 refused)", async () => {
    const r = mkRepo(
      FORGE("paths:\n  rfcsDir: docs/rfcs\n"),
      baseFiles("RFC-0100/AC-1", {
        "docs/rfcs/rfc-0100-root.md": RFC(["AC-1"]),
        "docs/rfcs/archive/rfc-0100-arch.md": RFC(["AC-2"]),
      }),
    );
    r.commit("noop head");
    const res = await gate(r);
    expect(corr03(res).some((m) => m.includes("AC-1"))).toBe(false);
  });

  it("a ref only the archive duplicate declares is refused (root file won)", async () => {
    const r = mkRepo(
      FORGE("paths:\n  rfcsDir: docs/rfcs\n"),
      baseFiles("RFC-0100/AC-2", {
        "docs/rfcs/rfc-0100-root.md": RFC(["AC-1"]),
        "docs/rfcs/archive/rfc-0100-arch.md": RFC(["AC-2"]),
      }),
    );
    r.commit("noop head");
    const res = await gate(r);
    expect(corr03(res).some((m) => m.includes("declares no AC-2"))).toBe(true);
  });

  it('rfcsDir "./" at base resolves rfc-ac refs like "." (CX-115 e2e fixed)', async () => {
    const r = mkRepo(
      FORGE('paths:\n  rfcsDir: "./"\n'),
      baseFiles("RFC-0100/AC-7", { "rfc-0100-top.md": RFC(["AC-7"]) }),
    );
    r.commit("noop head");
    const res = await gate(r);
    // The pathspec "." substitution keeps the read valid — the repo-root RFC
    // resolves and no fabricated ledger flag stands.
    expect(corr03(res).some((m) => m.includes("not found"))).toBe(false);
    expect(res.violations.some((v) => v.message.includes("a git read failed"))).toBe(false);
  });

  it('rfcsDir "." resolves a repo-root RFC through CORR-03', async () => {
    const r = mkRepo(
      FORGE('paths:\n  rfcsDir: "."\n'),
      baseFiles("RFC-0100/AC-7", { "rfc-0100-top.md": RFC(["AC-7"]) }),
    );
    r.commit("noop head");
    const res = await gate(r);
    expect(corr03(res).length).toBe(0);
  });

  it("an RFC only in a non-archive sibling subdir does not resolve", async () => {
    const r = mkRepo(
      FORGE("paths:\n  rfcsDir: docs/rfcs\n"),
      baseFiles("RFC-0100/AC-4", { "docs/rfcs/other/rfc-0100-other.md": RFC(["AC-4"]) }),
    );
    r.commit("noop head");
    const res = await gate(r);
    expect(corr03(res).some((m) => m.includes("not found"))).toBe(true);
  });

  it("archive ordering divergence: AC the worktree-first file lacks can still resolve", async () => {
    // archive/a/ sorts before archive/rfc-0100-z.md → gate judges a/'s copy.
    const r = mkRepo(
      FORGE("paths:\n  rfcsDir: docs/rfcs\n"),
      baseFiles("RFC-0100/AC-9", {
        "docs/rfcs/archive/a/rfc-0100-deep.md": RFC(["AC-9"]),
        "docs/rfcs/archive/rfc-0100-z.md": RFC(["AC-1"]),
      }),
    );
    r.commit("noop head");
    const res = await gate(r);
    // gate resolved AC-9 against archive/a/ — the standalone worktree resolver
    // would have judged archive/rfc-0100-z.md (files before descent) and failed.
    expect(corr03(res).some((m) => m.includes("AC-9"))).toBe(false);
    const wt = await resolveRfcRef(r.root, "docs/rfcs", "RFC-0100/AC-9", "AC");
    expect(wt.ok).toBe(false); // worktree picks z → refuses
  });
});

describe("invariantsFile judged binding (r16 part A) — canon edges", () => {
  const side = (yaml: string) => sideFrom(yaml, () => null);
  const fs = (baseYaml: string): FrozenSet => ({
    base: side(baseYaml),
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
  });
  const FORGE_INV = (inv: string) =>
    `paths: {}\nbindings:\n  paths:\n    correctnessManifest: docs/m.yaml\n    ${inv}\n`;
  const kinds = (baseYaml: string, headYaml: string) =>
    diffWeakenings(fs(baseYaml), side(headYaml)).map((w) => `${w.kind}:${w.subject}`);

  it("bound → non-string retype reports changed→null", () => {
    const w = kinds(FORGE_INV("invariantsFile: docs/inv.md"), FORGE_INV("invariantsFile: 5"));
    expect(w).toContain("binding:bindings.paths.invariantsFile");
  });
  it("bound → absent reports changed→null", () => {
    const w = kinds(FORGE_INV("invariantsFile: docs/inv.md"), FORGE_INV(""));
    expect(w).toContain("binding:bindings.paths.invariantsFile");
  });
  it('bound "" → real path reports a change (base "" is bound-but-empty)', () => {
    const w = kinds(FORGE_INV('invariantsFile: ""'), FORGE_INV("invariantsFile: docs/x"));
    expect(w).toContain("binding:bindings.paths.invariantsFile");
  });
  it("absent → bound under a declared contour reports an add", () => {
    const w = kinds(FORGE_INV(""), FORGE_INV("invariantsFile: docs/x"));
    expect(w).toContain("binding:bindings.paths.invariantsFile");
  });
  it("array/scalar base (non-string → null) → bound reports an add", () => {
    const w = kinds(FORGE_INV("invariantsFile: [a]"), FORGE_INV("invariantsFile: docs/x"));
    expect(w).toContain("binding:bindings.paths.invariantsFile");
  });
  it("identical binds stay silent", () => {
    expect(kinds(FORGE_INV("invariantsFile: docs/x"), FORGE_INV("invariantsFile: docs/x"))).toEqual(
      [],
    );
  });
});

describe("forgeYamlOnlyFrozenKeys — strip + pruneEmpties (CX-112 fix and laundering)", () => {
  // Each probe commits a forge.yaml-only session diff and runs --accept-weakening.
  // PASS = acceptedWeakening set; MIXED = mixed-weakening refusal.
  const accept = async (r: Repo) => {
    const res = await gate(r, { acceptWeakening: "operator decision" });
    return {
      accepted: res.acceptedWeakening,
      mixed: weak(res).filter((m) => m.includes("mixed-weakening")),
      weakenings: res.weakenings.map((w) => `${w.kind}:${w.subject}`),
    };
  };

  it("CX-112: removing a whole `paths:` parent around only frozen subkeys isolates", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n"));
    r.write("forge.yaml", FORGE("", "correctnessManifest: docs/correctness.yaml"));
    r.commit("drop paths");
    const a = await accept(r);
    expect(a.weakenings.some((w) => w.startsWith("binding:paths.rfcsDir"))).toBe(true);
    expect(a.mixed).toEqual([]);
    expect(a.accepted).toBe("operator decision");
  });

  it("CX-112: adding a whole `paths:` parent around only frozen subkeys isolates", async () => {
    const r = mkRepo(FORGE("paths: {}\n"));
    r.write("forge.yaml", FORGE("paths:\n  rfcsDir: docs/rfcs2\n"));
    r.commit("grow paths");
    const a = await accept(r);
    expect(a.mixed).toEqual([]);
    expect(a.accepted).toBe("operator decision");
  });

  it("a non-frozen sibling inside the same parent still breaks isolation", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n  keep: 1\n"));
    r.write("forge.yaml", FORGE("paths:\n  rfcsDir: docs/rfcs2\n  keep: 2\n"));
    r.commit("sibling change");
    const a = await accept(r);
    expect(a.accepted).toBeNull();
    expect(a.mixed.length).toBeGreaterThan(0);
  });

  it("a non-frozen leaf added beside frozen keys breaks isolation", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n"));
    r.write("forge.yaml", FORGE("paths:\n  rfcsDir: docs/rfcs2\n  smuggled: 1\n"));
    r.commit("sneak a leaf");
    const a = await accept(r);
    expect(a.accepted).toBeNull();
    expect(a.mixed.length).toBeGreaterThan(0);
  });

  it("paths retyped map → scalar stays foreign (not pruned away)", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n"));
    r.write("forge.yaml", FORGE('paths: "scalar"\n'));
    r.commit("retype paths");
    const a = await accept(r);
    expect(a.accepted).toBeNull();
    expect(a.mixed.length).toBeGreaterThan(0);
  });

  it("paths retyped map → empty array stays foreign (arrays never prune)", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n"));
    r.write("forge.yaml", FORGE("paths: []\n"));
    r.commit("paths to array");
    const a = await accept(r);
    expect(a.accepted).toBeNull();
    expect(a.mixed.length).toBeGreaterThan(0);
  });

  it("paths retyped map → !!timestamp prunes away (zero-key tagged object)", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n"));
    r.write("forge.yaml", FORGE("paths: !!timestamp 2024-01-01\n"));
    r.commit("paths to date");
    const a = await accept(r);
    // The rfcsDir loss is the reported weakening; the Date-typed container
    // carries zero enumerable keys and prunes — accept succeeds (observation).
    expect(a.mixed).toEqual([]);
    expect(a.accepted).toBe("operator decision");
  });

  it("bindings emptied around ONLY frozen subkeys isolates", async () => {
    const r = mkRepo(
      `schema: forge/config@1
project:
  name: r17
paths: {}
bindings:
  commands:
    checkRun: "node {file}"
  paths:
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: warn
`,
    );
    r.write(
      "forge.yaml",
      `schema: forge/config@1
project:
  name: r17
paths: {}
correctness:
  mode: warn
`,
    );
    r.commit("drop bindings");
    const a = await accept(r);
    expect(a.weakenings.length).toBeGreaterThan(0);
    expect(a.mixed).toEqual([]);
    expect(a.accepted).toBe("operator decision");
  });

  it("a non-frozen sibling key (bindings.schema) still breaks isolation", async () => {
    // FORGE() carries `schema: forge/bindings@1` — removing the whole
    // `bindings:` parent removes the schema leaf too → foreign → mixed.
    const r = mkRepo(FORGE("paths: {}\n", "correctnessManifest: docs/correctness.yaml"));
    r.write(
      "forge.yaml",
      `schema: forge/config@1
project:
  name: r17
paths: {}
correctness:
  mode: warn
`,
    );
    r.commit("drop bindings incl schema");
    const a = await accept(r);
    expect(a.accepted).toBeNull();
    expect(a.mixed.length).toBeGreaterThan(0);
  });

  it("a live sibling under bindings.paths breaks isolation when a weakening exists", async () => {
    // reviewsDir is live-but-unjudged; correctnessManifest change triggers the
    // accept path, and the reviewsDir leaf keeps forge.yaml foreign → mixed.
    const r = mkRepo(
      FORGE("paths: {}\n", "correctnessManifest: docs/correctness.yaml\n    reviewsDir: docs/r"),
    );
    r.write(
      "forge.yaml",
      FORGE("paths: {}\n", "correctnessManifest: docs/correctness2.yaml\n    reviewsDir: docs/r2"),
    );
    r.commit("live sibling + weakening");
    const a = await accept(r);
    expect(
      a.weakenings.some((w) => w.startsWith("binding:bindings.paths.correctnessManifest")),
    ).toBe(true);
    expect(a.accepted).toBeNull();
    expect(a.mixed.length).toBeGreaterThan(0);
  });

  it("dead bindings.paths.rfcsDir is NOT stripped — stays foreign (over-refusal)", async () => {
    const r = mkRepo(FORGE("paths:\n  rfcsDir: docs/rfcs\n"));
    r.write(
      "forge.yaml",
      FORGE(
        "paths:\n  rfcsDir: docs/rfcs2\n",
        "correctnessManifest: docs/correctness.yaml\n    rfcsDir: docs/rfcs2",
      ),
    );
    r.commit("dead key");
    const a = await accept(r);
    // The judged paths.rfcsDir change is a real weakening, but the dead
    // bindings.paths.rfcsDir leaf is unstripped → forge.yaml foreign → mixed.
    expect(a.accepted).toBeNull();
    expect(a.mixed.length).toBeGreaterThan(0);
  });

  it("bindings.paths scalar does not throw and stays foreign", async () => {
    const r = mkRepo(FORGE("paths: {}\n", "correctnessManifest: docs/correctness.yaml"));
    r.write(
      "forge.yaml",
      FORGE("paths: {}\n", "correctnessManifest: docs/correctness.yaml\n    # paths stays\n"),
    );
    // now make bindings.paths a scalar
    r.write(
      "forge.yaml",
      `schema: forge/config@1
project:
  name: r17
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
  paths: "scalar"
correctness:
  mode: warn
`,
    );
    r.commit("scalar paths");
    const a = await accept(r);
    expect(a.accepted).toBeNull();
    expect(a.mixed.length).toBeGreaterThan(0);
  });
});

describe("policy-branch strip with mutable/additive combos", () => {
  const FORGE_POLICY = (policy: string, paths: string) => `schema: forge/config@1
project:
  name: r17
${paths}bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
  paths:
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: warn
policy:
${policy}
`;
  const accept = async (r: Repo) => {
    const res = await gate(r, { acceptWeakening: "operator decision" });
    return {
      accepted: res.acceptedWeakening,
      mixed: weak(res).filter((m) => m.includes("mixed-weakening")),
      weakenings: res.weakenings.map((w) => `${w.kind}:${w.subject}`),
    };
  };

  it("mutable:[paths] + rfcsDir change — judged as binding, still accept-isolated", async () => {
    const r = mkRepo(FORGE_POLICY("  mutable: [paths]\n", "paths:\n  rfcsDir: docs/rfcs\n"));
    r.write("forge.yaml", FORGE_POLICY("  mutable: [paths]\n", "paths:\n  rfcsDir: docs/rfcs2\n"));
    r.commit("rfcsDir under mutable paths");
    const a = await accept(r);
    // mutable frees the policy-key check, never the RFC-1580 binding check.
    expect(a.weakenings.some((w) => w.startsWith("binding:paths.rfcsDir"))).toBe(true);
    expect(a.mixed).toEqual([]);
    expect(a.accepted).toBe("operator decision");
  });

  it("additive:[paths] + rfcsDir change — policy-key + binding, still isolated", async () => {
    const r = mkRepo(FORGE_POLICY("  additive: [paths]\n", "paths:\n  rfcsDir: docs/rfcs\n"));
    r.write("forge.yaml", FORGE_POLICY("  additive: [paths]\n", "paths:\n  rfcsDir: docs/rfcs2\n"));
    r.commit("rfcsDir under additive paths");
    const a = await accept(r);
    expect(a.weakenings.some((w) => w.startsWith("policy-key:"))).toBe(true);
    expect(a.weakenings.some((w) => w.startsWith("binding:paths.rfcsDir"))).toBe(true);
    expect(a.mixed).toEqual([]);
    expect(a.accepted).toBe("operator decision");
  });

  it("mutable:[bindings] + checkRun rebind stays accept-isolated (CX-51 parity)", async () => {
    const r = mkRepo(FORGE_POLICY("  mutable: [bindings]\n", "paths: {}\n"));
    r.write(
      "forge.yaml",
      FORGE_POLICY("  mutable: [bindings]\n", "paths: {}\n").replace(
        'checkRun: "node {file}"',
        'checkRun: "node scripts/x.mjs {file}"',
      ),
    );
    r.commit("checkRun under mutable bindings");
    const a = await accept(r);
    expect(a.weakenings.some((w) => w.startsWith("binding:bindings.commands.checkRun"))).toBe(true);
    expect(a.mixed).toEqual([]);
    expect(a.accepted).toBe("operator decision");
  });

  it("mutable:[bindings] + invariantsFile change strips the judged subkey", async () => {
    const r = mkRepo(
      FORGE_POLICY("  mutable: [bindings]\n", "paths: {}\n").replace(
        "correctnessManifest: docs/correctness.yaml",
        "correctnessManifest: docs/correctness.yaml\n    invariantsFile: docs/inv.md",
      ),
    );
    r.write(
      "forge.yaml",
      FORGE_POLICY("  mutable: [bindings]\n", "paths: {}\n").replace(
        "correctnessManifest: docs/correctness.yaml",
        "correctnessManifest: docs/correctness.yaml\n    invariantsFile: docs/inv2.md",
      ),
    );
    r.commit("invariantsFile under mutable bindings");
    const a = await accept(r);
    expect(a.weakenings.some((w) => w.startsWith("binding:bindings.paths.invariantsFile"))).toBe(
      true,
    );
    expect(a.mixed).toEqual([]);
    expect(a.accepted).toBe("operator decision");
  });

  it("undeclared mutable sibling inside paths still breaks isolation under policy", async () => {
    const r = mkRepo(
      FORGE_POLICY("  mutable: [paths]\n", "paths:\n  rfcsDir: docs/rfcs\n  keep: 1\n"),
    );
    r.write(
      "forge.yaml",
      FORGE_POLICY("  mutable: [paths]\n", "paths:\n  rfcsDir: docs/rfcs2\n  keep: 2\n"),
    );
    r.commit("sibling under mutable");
    const a = await accept(r);
    // `keep` is a mutable-key leaf — it participates in the comparison, so
    // changing it makes the diff non-isolated (conservative over-refusal).
    expect(a.accepted).toBeNull();
    expect(a.mixed.length).toBeGreaterThan(0);
  });
});
