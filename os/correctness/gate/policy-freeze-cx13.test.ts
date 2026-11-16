/*
RFC-1615 acceptance verification — round 12 (adversarial).
Every `it` asserts the EXPECTED contract; a failure is a counterexample.
Re-tests CX-68..72 fixes, then hunts new classes in the read/anchor layers.
*/

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessGate, type GateOptions } from "./run.ts";
import { GateRepo } from "./repo.ts";
import {
  makeGateFixture,
  verifierCommit,
  manifestYaml,
  L1_ORACLE,
  ORACLE_PATH,
  type GateFixture,
} from "./tests/gate-fixture.ts";

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

/** Overwrite the loose object for `rev:path` with garbage so content reads fail but tree entries still resolve. */
const corruptBlob = (f: GateFixture, revPath: string): string => {
  const sha = f.git(["rev-parse", revPath]);
  const obj = path.join(f.root, ".git", "objects", sha.slice(0, 2), sha.slice(2));
  chmodSync(obj, 0o644);
  writeFileSync(obj, "corrupt-loose-object-not-zlib");
  return sha;
};

/** Amend pending writes into the fixture's base commit (rewrite history) and return the new base sha. */
const amendBase = (f: GateFixture): string => {
  f.git(["add", "-A"]);
  f.git(["commit", "-q", "--amend", "--no-edit"]);
  return f.git(["rev-parse", "HEAD"]);
};

const MARK = "@ai-" + "invariant";
const STMT = "dispatch moves an approved candidate to queued exactly once";
const anchorComment = (stmt = STMT) =>
  `// ${MARK}[INV-dispatch-01]: ${stmt}\n//   (checked-by: test:${ORACLE_PATH})\n`;

// ===========================================================================
// Round-12 fix verification — CX-68/70 multi-carrier + divergent copies
// ===========================================================================

describe("CX-68 multi-carrier anchor removal", () => {
  const twoCarrier = () =>
    fx({
      extraFiles: {
        "apps/api/src/helper.ts": `${anchorComment()}export function helper(): void {}\n`,
      },
    });

  it("drop marker from ONE of two carriers → NO anchor-removed (survives verbatim)", async () => {
    const f = twoCarrier();
    f.write(
      "apps/api/src/dispatch.ts",
      "export function dispatch(): void {\n  // marker dropped here\n}\n",
    );
    f.commit("drop the marker from one carrier only");
    const r = await gate(f);
    expect(
      r.weakenings.some((w) => w.kind === "anchor-removed"),
      "anchor still exists verbatim in apps/api/src/helper.ts",
    ).toBe(false);
  });

  it("drop marker from ALL carriers → anchor-removed fires", async () => {
    const f = twoCarrier();
    f.write("apps/api/src/dispatch.ts", "export function dispatch(): void {}\n");
    f.write("apps/api/src/helper.ts", "export function helper(): void {}\n");
    f.commit("drop both carriers");
    const r = await gate(f);
    expect(r.weakenings.some((w) => w.kind === "anchor-removed")).toBe(true);
  });

  it("git mv one carrier + drop its copy; sibling untouched → NO anchor-removed", async () => {
    const f = twoCarrier();
    const dropped = f
      .read("apps/api/src/dispatch.ts")
      .split("\n")
      .filter((l) => !l.includes(MARK) && !l.includes("checked-by"))
      .join("\n");
    f.write("apps/api/src/dispatch2.ts", dropped);
    f.git(["rm", "-q", "apps/api/src/dispatch.ts"]);
    f.commit("rename carrier, drop its copy");
    const r = await gate(f);
    expect(r.weakenings.some((w) => w.kind === "anchor-removed")).toBe(false);
  });

  it("git mv of EVERY carrier + drop everywhere → anchor-removed", async () => {
    const f = twoCarrier();
    for (const rel of ["apps/api/src/dispatch.ts", "apps/api/src/helper.ts"]) {
      const dropped = f
        .read(rel)
        .split("\n")
        .filter((l) => !l.includes(MARK) && !l.includes("checked-by"))
        .join("\n");
      f.write(`${rel.replace(".ts", "2.ts")}`, dropped);
      f.git(["rm", "-q", rel]);
    }
    f.commit("rename all carriers, drop all copies");
    const r = await gate(f);
    expect(r.weakenings.some((w) => w.kind === "anchor-removed")).toBe(true);
  });
});

describe("CX-70 divergent base copies (frozen.anchors id→Set<sha>)", () => {
  // aaaa.ts sorts before dispatch.ts and carries statement B; dispatch.ts carries the fixture's A.
  const divergent = () =>
    fx({
      extraFiles: {
        "apps/api/src/aaaa.ts": `${anchorComment("a different but base-frozen statement text")}export function a(): void {}\n`,
      },
    });

  it("cosmetic edit to the NON-first carrier (dispatch.ts, stmt A) → no anchor-reworded", async () => {
    const f = divergent();
    f.write(
      "apps/api/src/dispatch.ts",
      `${anchorComment()}export function dispatch(): void {\n  // cosmetic change\n}\n`,
    );
    f.commit("cosmetic edit to dispatch carrier");
    const r = await gate(f);
    expect(r.weakenings.some((w) => w.kind === "anchor-reworded")).toBe(false);
  });

  it("cosmetic edit to the OTHER divergent carrier (aaaa.ts, stmt B) → no anchor-reworded", async () => {
    const f = divergent();
    f.write(
      "apps/api/src/aaaa.ts",
      `${anchorComment("a different but base-frozen statement text")}export function a(): void {\n  // cosmetic\n}\n`,
    );
    f.commit("cosmetic edit to aaaa carrier");
    const r = await gate(f);
    expect(r.weakenings.some((w) => w.kind === "anchor-reworded")).toBe(false);
  });

  it("genuine reword of ONE divergent copy → anchor-reworded", async () => {
    const f = divergent();
    f.write(
      "apps/api/src/dispatch.ts",
      `${anchorComment("a reworded statement not seen at base")}export function dispatch(): void {}\n`,
    );
    f.commit("reword one divergent copy");
    const r = await gate(f);
    expect(r.weakenings.some((w) => w.kind === "anchor-reworded")).toBe(true);
  });
});

// ===========================================================================
// Round-12 fix verification — CX-69 late unreadableReads re-check in finish()
// ===========================================================================

describe("CX-69 late-flag re-check in finish()", () => {
  it("corrupt HEAD review-record blob → 'a git read failed' + fail", async () => {
    const f = fx();
    const rel = "docs/correctness/reviews/2026-11-13-base.yaml";
    f.write(rel, f.read(rel) + "# touched\n");
    verifierCommit(f.git, rel);
    corruptBlob(f, `HEAD:${rel}`);
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("a git read failed"))).toBe(true);
  });

  it("exempt×exempt with corrupt base files() → status fail, not exempt", async () => {
    const f = fx({ mode: "exempt" });
    corruptBlob(f, `${f.base}:test`); // test/ tree → files(base) fails inside readFrozenSet
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("a git read failed"))).toBe(true);
  });

  it("bundle JSON carries unreadableReads", async () => {
    const f = fx();
    const rel = "docs/correctness/reviews/2026-11-13-base.yaml";
    f.write(rel, f.read(rel) + "# touched\n");
    verifierCommit(f.git, rel);
    corruptBlob(f, `HEAD:${rel}`);
    const out = await run(f);
    if (!out.ok) throw new Error(out.usageError);
    expect(out.result.status).toBe("fail");
    const bundle = JSON.parse(readFileSync(out.result.bundlePath, "utf8")) as {
      unreadableReads?: string[];
    };
    expect(Array.isArray(bundle.unreadableReads)).toBe(true);
    expect((bundle.unreadableReads ?? []).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Round-12 fix verification — CX-71 git log failure tri-state
// ===========================================================================

describe("CX-71 git log failure", () => {
  it("corrupt mid-range tree → NO fabricated frozen-file weakening + flag", async () => {
    const f = fx();
    f.write(ORACLE_PATH, "// verifier-amended oracle v2\n" + L1_ORACLE);
    verifierCommit(f.git, "docs/correctness/reviews/2026-11-14-v2.yaml");
    f.write("test/other.ts", "export const y = 1;\n");
    f.commit("unrelated test dir change");
    f.write("test/another.ts", "export const z = 1;\n");
    f.commit("second unrelated test dir change");
    const c3 = f.git(["rev-parse", "HEAD~1"]);
    corruptBlob(f, `${c3}:test`);
    const r = await gate(f);
    expect(r.weakenings.some((w) => w.kind === "frozen-file")).toBe(false);
    expect(msgs(r).some((m) => m.includes("a git read failed"))).toBe(true);
    expect(r.status).toBe("fail");
  });

  it("origin derivation does NOT promote viaTrailer on unreadable history", async () => {
    const f = fx();
    f.write(ORACLE_PATH, "// verifier-amended oracle v2\n" + L1_ORACLE);
    verifierCommit(f.git, "docs/correctness/reviews/2026-11-14-v2.yaml");
    f.write("test/other.ts", "export const y = 1;\n");
    f.commit("unrelated test dir change");
    f.write("test/another.ts", "export const z = 1;\n");
    f.commit("second unrelated test dir change");
    const c3 = f.git(["rev-parse", "HEAD~1"]);
    corruptBlob(f, `${c3}:test`);
    const out = await run(f);
    if (!out.ok) throw new Error(out.usageError);
    const oracle = out.bundle.entries[0]?.oracles[0];
    expect(oracle?.origin === "verified" && oracle.originDetail.includes("trailer")).toBe(false);
  });
});

// ===========================================================================
// Round-12 fix verification — CX-72 byte-level UTF-8 validation
// ===========================================================================

describe("CX-72 byte-level UTF-8 in listings", () => {
  const nameFF = Buffer.from([0x73, 0x63, 0x72, 0xff, 0x2e, 0x73, 0x68]); // "scr\xff.sh"

  it("a filename with a REAL U+FFFD codepoint does NOT flag", async () => {
    const f = fx();
    f.write("nonutf8b/scr�.sh", "v1\n");
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("support: []", 'support: ["nonutf8b/**"]'),
    );
    const base = amendBase(f);
    const r = await gate(f, { base });
    expect(msgs(r).every((m) => !m.includes("non-UTF-8 path"))).toBe(true);
  });

  it("a genuinely non-UTF-8 filename (\\xff byte) DOES flag", async () => {
    const f = fx();
    mkdirSync(path.join(f.root, "nonutf8"), { recursive: true });
    writeFileSync(
      Buffer.concat([Buffer.from(`${path.join(f.root, "nonutf8")}/`), nameFF]),
      "v1\n",
    );
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("support: []", 'support: ["nonutf8/**"]'),
    );
    const base = amendBase(f);
    const r = await gate(f, { base });
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("non-UTF-8 path") || m.includes("a git read failed"))).toBe(
      true,
    );
  });

  it("documented degraded path: run-only OriginGit (no runExit) keeps the U+FFFD heuristic", async () => {
    const f = fx();
    f.write("nonutf8b/scr�.sh", "v1\n");
    f.commit("add legal U+FFFD file");
    const repo = new GateRepo(f.root);
    delete (repo.git as { runExit?: unknown }).runExit;
    const out = await repo.listing(["ls-tree", "-r", "-z", "--name-only", "HEAD"], "ls-tree HEAD");
    expect(out).not.toBeNull();
    // The decoded-string fallback flags a legal U+FFFD name — documented stub-port
    // degradation (production createOriginGit always provides runExit + bytes).
    expect(repo.unreadableReads.some((r) => r.includes("non-UTF-8"))).toBe(true);
  });
});

// ===========================================================================
// NEW counterexample hunts
// ===========================================================================

describe("multi-carrier edge residuals", () => {
  const twoCarrier = () =>
    fx({
      extraFiles: {
        "apps/api/src/helper.ts": `${anchorComment()}export function helper(): void {}\n`,
      },
    });

  it("anchor moved to a NEW non-carrier file while all old carriers touched → no weakening", async () => {
    const f = twoCarrier();
    // Both old carriers drop the marker; a brand-new file carries it verbatim.
    f.write("apps/api/src/dispatch.ts", "export function dispatch(): void {}\n");
    f.write("apps/api/src/helper.ts", "export function helper(): void {}\n");
    f.write("apps/api/src/newhome.ts", `${anchorComment()}export function moved(): void {}\n`);
    f.commit("move anchor to a new file, drop old copies");
    const r = await gate(f);
    expect(
      r.weakenings.filter((w) => w.kind.startsWith("anchor-")),
      "the anchor exists verbatim at HEAD (moved, not removed)",
    ).toEqual([]);
  });

  it("a NEW divergent copy added while the original carrier is untouched → anchor-reworded", async () => {
    const f = fx();
    // dispatch.ts (carrier) stays untouched; a changed file adds a divergent copy.
    f.write(
      "apps/api/src/extra.ts",
      `${anchorComment("a divergent statement never seen at base")}export function e(): void {}\n`,
    );
    f.commit("add divergent copy in a new file");
    const r = await gate(f);
    // The contract: every changed copy must carry a base sha — a divergent addition weakens the id's statement set.
    expect(r.weakenings.some((w) => w.kind === "anchor-reworded")).toBe(true);
  });

  it("cross-copy sha borrowing: rewording copy A to copy B's recorded sha is consistent (anchor survives verbatim)", async () => {
    // Divergent base copies: aaaa.ts carries B, dispatch.ts carries A.
    const f = fx({
      extraFiles: {
        "apps/api/src/aaaa.ts": `${anchorComment("a different but base-frozen statement text")}export function a(): void {}\n`,
      },
    });
    // Reword the aaaa.ts copy from B to A — the id still exists verbatim (A) in dispatch.ts.
    // Under the CX-68 rule dropping B's copy ENTIRELY is already legal (anchor survives);
    // converging it to A is strictly less destructive, so no weakening is the consistent verdict.
    f.write(
      "apps/api/src/aaaa.ts",
      `${anchorComment()}export function a(): void {}\n`,
    );
    f.commit("converge divergent copy onto the other recorded sha");
    const r = await gate(f);
    expect(r.weakenings.filter((w) => w.kind.startsWith("anchor-"))).toEqual([]);
  });

  it("a bound-but-absent anchor at base appearing at head → no anchor weakening (nothing was frozen)", async () => {
    const f = fx();
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("INV-dispatch-01", "INV-ghost-99"),
    );
    f.write("apps/api/src/dispatch.ts", "export function dispatch(): void {\n  // no markers\n}\n");
    const base = amendBase(f);
    // HEAD: the ghost anchor now EXISTS.
    f.write("apps/api/src/dispatch.ts", `${anchorComment().replace("INV-dispatch-01", "INV-ghost-99")}export function dispatch(): void {}\n`);
    f.commit("add the previously-absent anchor");
    const r = await gate(f, { base });
    expect(r.weakenings.filter((w) => w.kind.startsWith("anchor-"))).toEqual([]);
  });
});

describe("accept-path + late-flag ordering", () => {
  it("acceptedWeakening granted, then origin-derivation read flags → fail + honest bundle", async () => {
    // A proof: spec file (.yaml — not an anchor-source candidate) is shown ONLY
    // inside deriveOrigin — AFTER the accept check. Corrupt its HEAD blob: no
    // pre-accept read touches its content (blob/mode reads resolve shas only).
    const f = fx({
      oracle: L1_ORACLE,
      extraFiles: { "specs/inv.spec.yaml": "kind: proof\nentry: apps/api/src/dispatch.ts\n" },
    });
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
      - check: proof:specs/inv.spec.yaml
        substrate: L1
support: []
exemptions: []
`,
    );
    // The anchor's checked-by must name the proof oracle (CORR-05).
    f.write(
      "apps/api/src/dispatch.ts",
      `export function dispatch(): void {\n  // ${MARK}[INV-dispatch-01]: ${STMT}\n  //   (checked-by: proof:specs/inv.spec.yaml)\n}\n`,
    );
    const base = amendBase(f);
    f.write("specs/inv.spec.yaml", "kind: proof\nentry: apps/api/src/dispatch.ts\n# edited\n");
    f.commit("edit the proof spec (frozen file)");
    corruptBlob(f, "HEAD:specs/inv.spec.yaml");
    const out = await run(f, { base, acceptWeakening: "operator reviewed" });
    if (!out.ok) throw new Error(out.usageError);
    // The accept was honestly granted on a complete picture; the LATE read failure flips status to fail.
    expect(out.result.status).toBe("fail");
    expect(msgs(out.result).some((m) => m.includes("a git read failed"))).toBe(true);
    const bundle = out.bundle;
    expect((bundle.unreadableReads ?? []).length).toBeGreaterThan(0);
    // The recorded accept must remain visible — the bundle is honest about what was accepted.
    expect(out.result.acceptedWeakening).toBe("operator reviewed");
    expect(bundle.weakenings.some((w) => w.accepted)).toBe(true);
  });

  it("early + late flags dedup to ONE 'a git read failed' violation; bundle lists all", async () => {
    const f = fx();
    f.write(ORACLE_PATH, "// weakened\n");
    f.commit("weaken oracle");
    // Early flag: corrupt base test/ tree → files(base) fails inside readFrozenSet.
    corruptBlob(f, `${f.base}:test`);
    // Late flag: corrupt HEAD review-record blob → read in readReviewRecords.
    const rel = "docs/correctness/reviews/2026-11-13-base.yaml";
    corruptBlob(f, `HEAD:${rel}`);
    const out = await run(f);
    if (!out.ok) throw new Error(out.usageError);
    const gitReadViolations = out.result.violations.filter((v) =>
      v.message.includes("a git read failed"),
    );
    expect(gitReadViolations.length).toBe(1);
    expect((out.bundle.unreadableReads ?? []).length).toBeGreaterThanOrEqual(2);
    expect(out.result.status).toBe("fail");
  });
});

describe("history-read flagging beyond lastCommitBody", () => {
  it("a corrupt tree reachable only by the -G range walk denies requirement origin — must surface 'a git read failed'", async () => {
    // Custom history: C1 draft rfc + files → C2 accept → C3 add rfc-0002 (unique docs/rfcs tree)
    // → C4 remove rfc-0002 (=base) → C5 unrelated. Corrupt C3's docs/rfcs tree: only the
    // --follow -G walk over docs/rfcs hits it; log -1 -- checkfile, ls-tree, diff all pass.
    const root = mkdtempSync(path.join(os.tmpdir(), "forge-gate-req-"));
    const git = (a: string[]) =>
      execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
    const write = (rel: string, body: string) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), body);
    };
    const build = () => {
      git(["init", "-q", "-b", "develop"]);
      git(["config", "user.email", "t@t.t"]);
      git(["config", "user.name", "t"]);
      write(
        "forge.yaml",
        `schema: forge/config@1
project:
  name: req-fixture
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
  paths:
    compassDocs: [docs/requirements.xml]
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: enforce
  tier: standard
`,
      );
      write(
        "docs/requirements.xml",
        '<requirements>\n  <meta><document-id>requirements</document-id></meta>\n  <requirement id="REQ-01">x</requirement>\n</requirements>\n',
      );
      write(
        "docs/rfcs/rfc-0001-foo.md",
        `---
status: draft
---
# RFC-0001 Foo

## Acceptance criteria

- [x] AC-1: the check holds
`,
      );
      write(
        "apps/api/src/dispatch.ts",
        `export function dispatch(): void {\n  // ${MARK}[INV-dispatch-01]: ${STMT}\n  //   (checked-by: test:test/check.ts)\n}\n`,
      );
      write("test/check.ts", "export const probe = 1;\n");
      write("apps/x.txt", "x1\n");
      write(
        "docs/correctness.yaml",
        `schema: forge/correctness-manifest@1
entries:
  - id: CM-dispatch-01
    source: rfc-ac
    ref: RFC-0001/AC-1
    seam: data
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:test/check.ts
        substrate: L1
support: []
exemptions: []
`,
      );
      git(["add", "-A"]);
      git(["commit", "-qm", "c1 draft rfc + files"]);
      write(
        "docs/rfcs/rfc-0001-foo.md",
        readFileSync(path.join(root, "docs/rfcs/rfc-0001-foo.md"), "utf8").replace(
          "status: draft",
          "status: accepted",
        ),
      );
      // CX-79: governed provenance on the acceptance transition.
      git(["commit", "-qam", "c2 accept rfc\n\nX-RFC: RFC-0001"]);
      write("docs/rfcs/rfc-0002-tmp.md", "tmp\n");
      git(["add", "-A"]);
      git(["commit", "-qm", "c3 add rfc-0002 (unique docs/rfcs tree)"]);
      git(["rm", "-q", "docs/rfcs/rfc-0002-tmp.md"]);
      git(["commit", "-qm", "c4 remove rfc-0002"]);
      const base = git(["rev-parse", "HEAD"]);
      write("apps/x.txt", "x2\n");
      git(["commit", "-qam", "c5 unrelated"]);
      return base;
    };
    const base = build();
    try {
      // Control: uncorrupted — the -G range resolves and the oracle derives requirement origin.
      const clean = await runCorrectnessGate(root, { base, bundleDir: `${root}/.bundles` });
      if (!clean.ok) throw new Error(clean.usageError);
      expect(
        clean.bundle.entries[0]?.oracles[0]?.origin,
        "control: without the corrupt tree the oracle derives requirement origin",
      ).toBe("requirement");

      // Corrupt C3's docs/rfcs tree — reachable only from the -G walk of the rfc path.
      const t = git(["rev-parse", "HEAD~2:docs/rfcs"]);
      const obj = path.join(root, ".git", "objects", t.slice(0, 2), t.slice(2));
      chmodSync(obj, 0o644);
      writeFileSync(obj, "corrupt-tree-not-zlib");
      const out = await runCorrectnessGate(root, {
        base,
        bundleDir: `${root}/.bundles2`,
      });
      if (!out.ok) throw new Error(out.usageError);
      // Expected: the failed -G log read is surfaced — a silent map to null denies
      // requirement origin AND invisibly mis-attributes the verdict to "self".
      expect(
        msgs(out.result).some((m) => m.includes("a git read failed")),
        `violations: ${JSON.stringify(msgs(out.result))}`,
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("frozen-glob path-type edges", () => {
  it("a directory→file flip inside a frozen support glob reports ONE weakening, not two", async () => {
    const f = fx();
    // Base: directory `scripts/tool/` with a file — support glob `scripts/tool` matches nothing yet.
    f.write("scripts/tool/inner.sh", "echo hi\n");
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("support: []", 'support: ["scripts/tool"]'),
    );
    const base = amendBase(f);
    // HEAD: dir replaced by a FILE at the glob-matched path.
    f.git(["rm", "-q", "scripts/tool/inner.sh"]);
    f.write("scripts/tool", "#!/bin/sh\necho tool\n");
    f.commit("dir to file at glob path");
    const r = await gate(f, { base });
    const forPath = r.weakenings.filter((w) => w.subject === "scripts/tool");
    expect(
      forPath.length,
      `expected exactly one weakening for scripts/tool, got ${JSON.stringify(forPath)}`,
    ).toBe(1);
  });

  it("a file→directory flip at a frozen glob path reports ONE weakening (the file is gone)", async () => {
    const f = fx();
    // Base: a real FILE at the glob path → frozen by the glob.
    f.write("scripts/tool", "#!/bin/sh\necho tool\n");
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("support: []", 'support: ["scripts/tool"]'),
    );
    const base = amendBase(f);
    // HEAD: the file is replaced by a directory.
    f.git(["rm", "-q", "scripts/tool"]);
    f.write("scripts/tool/inner.sh", "echo hi\n");
    f.commit("file to dir at glob path");
    const r = await gate(f, { base });
    const forPath = r.weakenings.filter((w) => w.subject === "scripts/tool");
    expect(
      forPath.length,
      `expected exactly one weakening for scripts/tool, got ${JSON.stringify(forPath)}`,
    ).toBe(1);
  });
});

describe("linked worktree (.git FILE)", () => {
  it("gate in a linked worktree: commonDir resolves to main .git; bundle written, no crash", async () => {
    const f = fx();
    const wt = `${f.root}-wt`;
    f.git(["worktree", "add", wt, "-b", "gate-wt"]);
    try {
      const out = await runCorrectnessGate(wt, { base: f.base });
      if (!out.ok) throw new Error(out.usageError);
      // .git is a FILE here — the bundle must land under the real common dir, never crash ENOTDIR.
      expect(existsSync(out.result.bundlePath)).toBe(true);
      expect(out.result.bundlePath).toContain(path.join(".git", "forge", "gate-reports"));
    } finally {
      f.git(["worktree", "remove", "--force", wt]);
    }
  });
});

describe("path/object-type conflations", () => {
  it("manifest binding pointing at a DIRECTORY → judged, no crash", async () => {
    const f = fx();
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("docs/correctness.yaml", "docs"),
    );
    f.commit("manifest binding to a dir");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(r.weakenings.some((w) => w.kind === "binding" || w.kind === "entry-deleted")).toBe(true);
  });

  it("forge.yaml as a symlink at HEAD → forgeYamlUnreadable refuse, no crash", async () => {
    const f = fx();
    f.git(["rm", "-q", "forge.yaml"]);
    symlinkSync("apps/api/src/dispatch.ts", path.join(f.root, "forge.yaml"));
    f.commit("forge.yaml to symlink");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("forge.yaml"))).toBe(true);
  });

  it("a corrupt HEAD carrier blob must NOT fabricate anchor-removed — only the read flag", async () => {
    const f = fx();
    // Touch the carrier cosmetically, commit, then corrupt its HEAD blob:
    // show() fails while the tree entry resolves — the copy cannot be READ,
    // which is not the same as the marker being gone.
    f.write(
      "apps/api/src/dispatch.ts",
      `${anchorComment()}export function dispatch(): void {\n  // cosmetic\n}\n`,
    );
    f.commit("touch the carrier");
    corruptBlob(f, "HEAD:apps/api/src/dispatch.ts");
    const out = await run(f);
    if (!out.ok) throw new Error(out.usageError);
    expect(out.result.status).toBe("fail");
    expect(msgs(out.result).some((m) => m.includes("a git read failed"))).toBe(true);
    expect(
      out.result.weakenings.some((w) => w.kind === "anchor-removed"),
      "an unreadable copy is not a removed anchor — 'removed' is a claim the failed read cannot support",
    ).toBe(false);
  });

  it("forge.yaml as a gitlink → fail closed, no crash", async () => {
    const f = fx();
    // Plant a gitlink at forge.yaml (simulated submodule pointer).
    f.git(["rm", "-q", "forge.yaml"]);
    const fakeSubSha = f.git(["rev-parse", "HEAD"]);
    f.git(["update-index", "--add", "--cacheinfo", `160000,${fakeSubSha},forge.yaml`]);
    f.commit("forge.yaml to gitlink");
    const r = await gate(f);
    expect(r.status).toBe("fail");
  });
});

describe("read-flag labels", () => {
  it("a failed git log records 'log <rel>' in unreadableReads", async () => {
    const f = fx();
    f.write(ORACLE_PATH, "// verifier-amended oracle v2\n" + L1_ORACLE);
    verifierCommit(f.git, "docs/correctness/reviews/2026-11-14-v2.yaml");
    f.write("test/other.ts", "export const y = 1;\n");
    f.commit("unrelated test dir change");
    f.write("test/another.ts", "export const z = 1;\n");
    f.commit("second unrelated test dir change");
    const c3 = f.git(["rev-parse", "HEAD~1"]);
    corruptBlob(f, `${c3}:test`);
    const out = await run(f);
    if (!out.ok) throw new Error(out.usageError);
    const reads = out.bundle.unreadableReads ?? [];
    expect(reads.some((r) => r.startsWith("log ") && r.includes(ORACLE_PATH))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Baseline sanity
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

  it("healthy run with bundleDir set emits no new commonDir flag", async () => {
    const f = fx();
    const r = await gate(f);
    expect(r.status).toBe("pass");
    expect(msgs(r).every((m) => !m.includes("git-common-dir"))).toBe(true);
  });
});
