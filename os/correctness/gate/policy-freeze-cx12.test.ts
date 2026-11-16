/*
RFC-1615 acceptance verification — round 11 (adversarial).
Every `it` asserts the EXPECTED contract; a failure is a counterexample.
Re-tests CX-61..67 fixes, then hunts new classes in the content-read layer.
*/

import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessGate, type GateOptions } from "./run.ts";
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

/** Overwrite the loose object for `rev:path` with garbage so content reads fail but trees still resolve. */
const corruptBlob = (f: GateFixture, revPath: string): string => {
  const sha = f.git(["rev-parse", revPath]);
  const obj = path.join(f.root, ".git", "objects", sha.slice(0, 2), sha.slice(2));
  chmodSync(obj, 0o644);
  writeFileSync(obj, "corrupt-loose-object-not-zlib");
  return sha;
};

/** Overwrite the loose object for a commit's `rev^{tree}` or a subdirectory tree. */
const corruptTreeAt = (f: GateFixture, revPath: string): string => corruptBlob(f, revPath);

/** Apply pending writes into the fixture's base commit (rewrite history) and return the new base sha. */
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
// Round-11 fix verification — CX-61..67
// ===========================================================================

describe("CX-61 corrupt committed blobs fail closed", () => {
  it("corrupt shared base+head forge.yaml blob → fail, not silent inert", async () => {
    const f = fx();
    f.write(ORACLE_PATH, "// weakened oracle\n");
    f.commit("weaken oracle");
    corruptBlob(f, `${f.base}:forge.yaml`);
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("a git read failed"))).toBe(true);
  });

  it("corrupt base-only forge.yaml + support-file weakening → fail", async () => {
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

  it("corrupt base manifest blob → fail (not 'no manifest')", async () => {
    const f = fx();
    f.write(ORACLE_PATH, "// weakened oracle\n");
    f.commit("weaken oracle");
    corruptBlob(f, `${f.base}:docs/correctness.yaml`);
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("a git read failed"))).toBe(true);
  });

  it("a corrupt manifest persisted into the NEXT base → fail", async () => {
    const f = fx();
    corruptBlob(f, "HEAD:docs/correctness.yaml");
    const corruptBase = f.git(["rev-parse", "HEAD"]);
    f.write(ORACLE_PATH, "// weakened oracle\n");
    f.commit("weaken oracle");
    const r = await gate(f, { base: corruptBase });
    expect(r.status).toBe("fail");
  });
});

describe("CX-62/63 --accept-weakening on unreadable forge.yaml/manifest", () => {
  it("corrupt HEAD forge.yaml blob → accept refused (isolation unproven)", async () => {
    const f = fx({ forgeYamlAppend: "policy:\n  mutable: [moves]\n" });
    f.write("forge.yaml", f.read("forge.yaml") + "sessionEdit: 1\n");
    f.commit("session forge.yaml edit");
    corruptBlob(f, "HEAD:forge.yaml");
    const r = await gate(f, { acceptWeakening: "operator reviewed the diff" });
    expect(r.status).toBe("fail");
    expect(r.acceptedWeakening).toBeNull();
  });

  it("corrupt HEAD manifest blob → accept refused", async () => {
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
});

describe("CX-64 non-UTF-8 filenames", () => {
  const nameFF = Buffer.from([0x73, 0x63, 0x72, 0xff, 0x2e, 0x73, 0x68]); // "scr\xff.sh"
  const writeNonUtf8 = (f: GateFixture, dir: string, body: string) => {
    mkdirSync(path.join(f.root, dir), { recursive: true });
    writeFileSync(Buffer.concat([Buffer.from(`${path.join(f.root, dir)}/`), nameFF]), body);
  };

  it("byte change to a frozen non-UTF-8 file → judged (fail)", async () => {
    const f = fx();
    writeNonUtf8(f, "nonutf8", "v1\n");
    f.write("nonutf8/placeholder.txt", "x\n");
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("support: []", 'support: ["nonutf8/**"]'),
    );
    const base = amendBase(f);
    writeNonUtf8(f, "nonutf8", "v2\n");
    f.commit("edit non-utf8 frozen file");
    const r = await gate(f, { base });
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("CORR-GATE-02") || m.includes("a git read failed"))).toBe(
      true,
    );
  });

  it("non-UTF-8 path only at HEAD (new file in frozen glob) → flagged", async () => {
    const f = fx();
    f.write("nonutf8/placeholder.txt", "x\n");
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("support: []", 'support: ["nonutf8/**"]'),
    );
    const base = amendBase(f);
    writeNonUtf8(f, "nonutf8", "v1\n");
    f.commit("add non-utf8 frozen-glob file");
    const r = await gate(f, { base });
    expect(r.status).toBe("fail");
  });
});

describe("CX-65 rename-aware changed paths", () => {
  it("git mv of an anchor carrier + marker drop → anchor-removed", async () => {
    const f = fx({
      extraFiles: {
        "apps/api/src/dispatch.ts": `${anchorComment()}export function dispatch(): void {
${Array.from({ length: 40 }, (_, i) => `  // filler line ${i}`).join("\n")}
}
`,
      },
    });
    const dropped = f
      .read("apps/api/src/dispatch.ts")
      .split("\n")
      .filter((l) => !l.includes(MARK) && !l.includes("checked-by"))
      .join("\n");
    f.write("apps/api/src/dispatch2.ts", dropped);
    f.git(["rm", "-q", "apps/api/src/dispatch.ts"]);
    f.commit("rename carrier, drop anchor");
    // Uncommitted copy satisfying the worktree CORR-04 scan (committed side is what matters).
    f.write("src/carrier.ts", `${anchorComment()}export const x = 1;\n`);
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(msgs(r).some((m) => m.includes("CORR-GATE-02") && m.includes("INV-dispatch-01"))).toBe(
      true,
    );
  });
});

describe("CX-66 failed git status", () => {
  it("corrupt .git/index + dirty worktree → git-read-failed violation", async () => {
    const f = fx();
    f.write("apps/api/wrangler.jsonc", "{ /* dirty */ }\n");
    const idx = path.join(f.root, ".git", "index");
    chmodSync(idx, 0o644);
    writeFileSync(idx, "corrupt-index");
    const r = await gate(f);
    expect(msgs(r).some((m) => m.includes("uncommitted") || m.includes("a git read failed"))).toBe(
      true,
    );
  });
});

describe("CX-67 zero-match grep", () => {
  it("base binding an anchor id that exists nowhere → no fabricated git read failure", async () => {
    const f = fx();
    f.write("docs/correctness.yaml", manifestYaml({}).replace("INV-dispatch-01", "INV-ghost-99"));
    f.write("apps/api/src/dispatch.ts", "export function dispatch(): void {\n  // no markers\n}\n");
    const base = amendBase(f);
    const r = await gate(f, { base });
    expect(msgs(r).every((m) => !m.includes("a git read failed"))).toBe(true);
  });
});

// ===========================================================================
// NEW counterexample probes
// ===========================================================================

describe("multi-carrier anchors", () => {
  const twoCarrier = () =>
    fx({
      extraFiles: {
        "apps/api/src/helper.ts": `${anchorComment()}export function helper(): void {}\n`,
      },
    });

  it("CX-68: dropping ONE of two carriers must not report anchor-removed (anchor survives verbatim)", async () => {
    const f = twoCarrier();
    // fileA = apps/api/src/dispatch.ts (fixture carrier), fileB = helper.ts — both carry the marker.
    f.write(
      "apps/api/src/dispatch.ts",
      "export function dispatch(): void {\n  // marker dropped here\n}\n",
    );
    f.commit("drop the marker from one carrier only");
    const r = await gate(f);
    const anchorRemoved = r.weakenings.some((w) => w.kind === "anchor-removed");
    expect(anchorRemoved, "the anchor still exists verbatim in apps/api/src/helper.ts").toBe(false);
  });

  it("CX-68 variant: git mv'd carrier dropping the marker while sibling carrier keeps it", async () => {
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

  it("sanity: moving the sole carrier to a new source file (marker kept) is no weakening", async () => {
    const f = fx();
    f.write("apps/api/src/dispatch-moved.ts", f.read("apps/api/src/dispatch.ts"));
    f.git(["rm", "-q", "apps/api/src/dispatch.ts"]);
    f.commit("move the carrier, marker kept");
    const r = await gate(f);
    expect(r.weakenings.filter((w) => w.kind.startsWith("anchor-"))).toEqual([]);
  });

  it("sanity: dropping ALL carriers still reports anchor-removed", async () => {
    const f = twoCarrier();
    f.write("apps/api/src/dispatch.ts", "export function dispatch(): void {}\n");
    f.write("apps/api/src/helper.ts", "export function helper(): void {}\n");
    f.commit("drop both carriers");
    const r = await gate(f);
    expect(r.weakenings.some((w) => w.kind === "anchor-removed")).toBe(true);
  });

  it("sanity: rewording ONE carrier while sibling keeps old text reports anchor-reworded", async () => {
    const f = twoCarrier();
    f.write(
      "apps/api/src/dispatch.ts",
      `${anchorComment("dispatch moves an approved candidate to queued at least once")}export function dispatch(): void {}\n`,
    );
    f.commit("reword one copy");
    const r = await gate(f);
    expect(r.weakenings.some((w) => w.kind === "anchor-reworded")).toBe(true);
  });

  it("CX-70: a divergent base copy must not fabricate anchor-reworded on an unrelated edit", async () => {
    // Base state: aaaa.ts carries stmt B (first in ls-tree order → the one
    // `frozen.anchors` records), dispatch.ts carries the fixture stmt A — a
    // pre-existing divergent copy the operator committed.
    const f = fx({
      extraFiles: {
        "apps/api/src/aaaa.ts": `${anchorComment("a different but base-frozen statement text")}export function a(): void {}\n`,
      },
    });
    // Edit dispatch.ts cosmetically WITHOUT touching its marker (statement A
    // unchanged since base) — the frozen sha is aaaa.ts's B, so the gate must
    // not read A's unchanged copy as "reworded".
    f.write(
      "apps/api/src/dispatch.ts",
      `${anchorComment()}export function dispatch(): void {\n  // cosmetic change\n}\n`,
    );
    f.commit("cosmetic edit to the divergent carrier");
    const r = await gate(f);
    expect(
      r.weakenings.some((w) => w.kind === "anchor-reworded"),
      "statement A is unchanged since base — the frozen sha belongs to aaaa.ts's copy",
    ).toBe(false);
  });
});

describe("post-emit git read failures", () => {
  it("CX-69: a corrupt HEAD review-record blob must surface 'a git read failed' (reads after the emit)", async () => {
    const f = fx();
    // Re-commit the review record through the verifier workflow so it still counts.
    const rel = "docs/correctness/reviews/2026-11-13-base.yaml";
    f.write(rel, f.read(rel) + "# touched\n");
    verifierCommit(f.git, rel);
    // Corrupt the HEAD blob of the record — ls-tree/diff see the tree entry; only show() fails.
    corruptBlob(f, `HEAD:${rel}`);
    const r = await gate(f);
    expect(msgs(r).some((m) => m.includes("a git read failed"))).toBe(true);
  });

  it("CX-69 variant: the pure-exempt early return drops failed reads on the floor", async () => {
    const f = fx({ mode: "exempt" });
    // Corrupt a base tree — files(base) fails inside readFrozenSet, flag pushed,
    // then the exempt×exempt early return fires BEFORE the unreadable verdict.
    corruptTreeAt(f, `${f.base}:test`);
    const r = await gate(f);
    expect(
      msgs(r).some((m) => m.includes("a git read failed")) || r.status === "fail",
      "an unreadable committed tree must not end in a clean exempt verdict",
    ).toBe(true);
  });
});

describe("lastCommitBody / git log traversal", () => {
  it("CX-71: a corrupt mid-range tree must not silently deny the verifier exemption", async () => {
    const f = fx();
    // C2: verifier commits a change to the frozen oracle.
    f.write(ORACLE_PATH, "// verifier-amended oracle v2\n" + L1_ORACLE);
    verifierCommit(f.git, "docs/correctness/reviews/2026-11-14-v2.yaml");
    // C3: unrelated commit that gives `test/` a NEW tree (so C3:test is unique to C3).
    f.write("test/other.ts", "export const y = 1;\n");
    f.commit("unrelated test dir change");
    // C4: another commit touching test/ again so HEAD:test differs from C3:test.
    f.write("test/another.ts", "export const z = 1;\n");
    f.commit("second unrelated test dir change");
    // Corrupt C3's `test` tree — `git log -1 HEAD -- test/dispatch.oracle.ts`
    // must compare HEAD vs C3 tree entries for the pathspec → hits the corrupt tree.
    const c3 = f.git(["rev-parse", "HEAD~1"]);
    corruptTreeAt(f, `${c3}:test`);
    const r = await gate(f);
    // Expected: the verifier-trailer exemption applies → no frozen-file weakening.
    // (A git-read-failed refusal is also honest; a fabricated frozen-file weakening is not.)
    expect(r.weakenings.some((w) => w.kind === "frozen-file")).toBe(false);
  });
});

describe("path edge cases", () => {
  it("a frozen file replaced by a directory → judged as weakening, no crash", async () => {
    const f = fx();
    f.git(["rm", "-q", ORACLE_PATH]);
    f.write(`${ORACLE_PATH}/nested.ts`, "export const n = 1;\n");
    f.commit("file to directory");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(r.weakenings.some((w) => w.kind === "frozen-file")).toBe(true);
  });

  it("a frozen file replaced by a symlink → byte weakening", async () => {
    const f = fx();
    f.git(["rm", "-q", ORACLE_PATH]);
    mkdirSync(path.dirname(path.join(f.root, ORACLE_PATH)), { recursive: true });
    symlinkSync(path.join(f.root, "apps/api/src/dispatch.ts"), path.join(f.root, ORACLE_PATH));
    f.commit("file to symlink");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(r.weakenings.some((w) => w.kind === "frozen-file")).toBe(true);
  });

  it("CX-72: a filename containing a REAL U+FFFD character must not flag (round-trips cleanly)", async () => {
    const f = fx();
    // U+FFFD as a legitimate UTF-8 character (EF BF BD) — the path round-trips
    // through argv pathspecs; the flag() heuristic cannot distinguish it from
    // mangled bytes, but the contract only needs paths that CANNOT round-trip.
    f.write("nonutf8b/scr�.sh", "v1\n");
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("support: []", 'support: ["nonutf8b/**"]'),
    );
    const base = amendBase(f);
    const r = await gate(f, { base });
    expect(msgs(r).every((m) => !m.includes("non-UTF-8 path"))).toBe(true);
  });
});

describe("accept-path ordering", () => {
  it("corrupt HEAD forge.yaml + policy-key weakening → accept refused before isolation", async () => {
    const f = fx({ forgeYamlAppend: "policy:\n  mutable: [project]\n" });
    // Weakening: frozen top-level key edit + forge.yaml made unreadable.
    f.write("forge.yaml", f.read("forge.yaml").replace("paths: {}", "paths: {a: 1}") + "z: 1\n");
    f.commit("session edit");
    corruptBlob(f, "HEAD:forge.yaml");
    const r = await gate(f, { acceptWeakening: "op" });
    expect(r.acceptedWeakening).toBeNull();
    expect(r.status).toBe("fail");
  });

  it("a foreign (non-frozen) path in the accept session refuses as mixed-weakening", async () => {
    const f = fx();
    f.write(ORACLE_PATH, "// weakened\n");
    f.write("unrelated.txt", "foreign\n");
    f.commit("weakening + foreign file");
    const r = await gate(f, { acceptWeakening: "op" });
    expect(r.acceptedWeakening).toBeNull();
    expect(msgs(r).some((m) => m.includes("mixed-weakening"))).toBe(true);
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

  it("isolated weakening + --accept-weakening grants acceptedReason", async () => {
    const f = fx();
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

  it("corrupt ref to HEAD → gate refuses (usageError or fail, no crash)", async () => {
    const f = fx();
    const headRef = path.join(f.root, ".git", "refs", "heads", "develop");
    writeFileSync(headRef, "not-a-sha\n");
    const out = await run(f);
    if (out.ok) {
      expect(out.result.status).not.toBe("pass");
    } else {
      expect(typeof out.usageError).toBe("string");
    }
  });
});
