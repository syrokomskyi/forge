/*
<MODULE_CONTRACT>
<purpose>RFC-1615 round-21 adversarial re-probe — verify-only. Every test
asserts the SECURE behavior of the correctness-gate surface; a failing
assertion is a live counterexample (numbered CX-130+ in the round report).
Coverage: PATH-runner guard gaps (CX-126/CX-127), the CYCLE sentinel
(CX-128), NUL/execFile guards (CX-129), binding-compare regressions
(trailing slash, quoted argv tokens, backslash folding), the policy
surface, oracle origin/rfc parity, and the flow-side bootstrap degrade
(baseAdoptedGate).</purpose>
<non-goals>
  <item>No production fixes — probes only.</item>
</non-goals>
</MODULE_CONTRACT>
*/
// test-adjacency: exempt — verification probes for the correctness gate (RFC-1615 r21)

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessGate } from "./run.ts";
import {
  canon,
  diffWeakenings,
  policyLeaves,
  policyWeakenings,
  sideFrom,
  type CorrectnessSide,
  type FrozenSet,
} from "./frozen.ts";
import { checkRunArgv, runOracle } from "./runner.ts";
import { GateRepo } from "./repo.ts";
import { readReviewRecords, rfcPath } from "./origin.ts";
import { runCorrectnessStep } from "../../flow/correctness-step.ts";
import { createOriginGit } from "../../rfc/verification-origin.ts";
import { ambientIo } from "../../../src/utils/io.ts";
import { setVerifierGitBinForTests } from "../../../src/utils/verifier-git.ts";
import {
  L1_ORACLE,
  MIGRATION,
  ORACLE_PATH,
  makeGateFixture,
  manifestYaml,
  reviewYaml,
  verifierCommit,
  type GateFixture,
} from "./tests/gate-fixture.ts";

const fixtures: GateFixture[] = [];
const minis: { cleanup(): void }[] = [];
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.cleanup());
  minis.splice(0).forEach((m) => m.cleanup());
});

const fx = (o: Parameters<typeof makeGateFixture>[0] = {}) => {
  const f = makeGateFixture(o);
  fixtures.push(f);
  return f;
};

const gate = async (
  f: { root: string },
  base: string,
  opts: { acceptWeakening?: string; policyOnly?: boolean } = {},
) => {
  const out = await runCorrectnessGate(f.root, {
    base,
    bundleDir: `${f.root}/.bundles`,
    ...opts,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
};

const rules = (r: { violations: { rule: string }[] }) => r.violations.map((v) => v.rule);
const msgs = (r: { violations: { message: string }[] }) => r.violations.map((v) => v.message);

/* ── hermetic mini-repo (custom base forge.yaml) ─────────────────────── */

interface Mini {
  root: string;
  git(args: string[]): string;
  write(rel: string, body: string): void;
  commit(message: string): string;
  head(): string;
  cleanup(): void;
}

const mini = (files: Record<string, string>): Mini => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gate-r21-"));
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "develop"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  git(["add", "-A"]);
  git(["commit", "-qm", "product"]);
  const m: Mini = {
    root,
    git,
    write,
    commit: (message: string) => {
      git(["add", "-A"]);
      git(["commit", "-qm", message, "--allow-empty"]);
      return git(["rev-parse", "HEAD"]);
    },
    head: () => git(["rev-parse", "HEAD"]),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  minis.push(m);
  return m;
};

/** JSON double-quote is YAML-safe for the escapes used here (`\u0000`, `\\`, `\"`). */
const y = (s: string): string => JSON.stringify(s);

/** A working contour at a custom forge.yaml + file set, with a verifier review record. */
const CONTOUR = (forgeYaml: string, files: Record<string, string> = {}): Mini => {
  const m = mini({
    "forge.yaml": forgeYaml,
    "docs/requirements.xml":
      '<requirements>\n  <meta><document-id>requirements</document-id></meta>\n  <requirement id="REQ-01">Never two openers</requirement>\n</requirements>\n',
    "apps/api/wrangler.jsonc":
      '{ "d1_databases": [{ "binding": "DB", "database_name": "main", "database_id": "x" }] }\n',
    "apps/api/migrations/0001_init.sql": MIGRATION,
    "apps/api/src/dispatch.ts": `export function dispatch(): void {\n  // @ai-invariant[INV-dispatch-01]: dispatch moves an approved candidate to queued exactly once\n  //   (checked-by: test:${ORACLE_PATH})\n}\n`,
    [ORACLE_PATH]: L1_ORACLE,
    "docs/correctness.yaml": manifestYaml({}),
    ...files,
  });
  const rel = "docs/correctness/reviews/2026-11-13-base.yaml";
  m.write(rel, reviewYaml([{ check: `test:${ORACLE_PATH}`, content: L1_ORACLE }]));
  verifierCommit(m.git, rel);
  return m;
};

const FY = (checkRun: string | null, extra = "") => `schema: forge/config@1
project:
  name: mini
bindings:
  commands:${checkRun === null ? " {}" : `\n    checkRun: ${y(checkRun)}`}
  paths:
    compassDocs: [docs/requirements.xml]
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: enforce
  tier: standard
${extra}`;

/* ── unit side/frozen stubs ──────────────────────────────────────────── */

const sideOf = (fy: string, manifest: string | null = null): CorrectnessSide =>
  sideFrom(fy, () => manifest);

const frozenOf = (fy: string, manifest: string | null = null): FrozenSet => ({
  base: sideOf(fy, manifest),
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

const kinds = (ws: { kind: string }[]) => ws.map((w) => w.kind);

const ORACLE_BODY = 'import { writeFileSync } from "node:fs";\nwriteFileSync("ORACLE-RAN", "1");\n';
const spawnRun = (m: Mini, template: string, file: string, tag = "r") =>
  runOracle({ cwd: m.root, template, file, runDir: `${m.root}/${tag}`, timeoutMs: 10_000 });

/* ════════════════════ A · oracle-runner PATH guard (CX-126/CX-127) ════ */

describe("A: checkRun argv + PATH-runner guard", () => {
  it("checkRunArgv collapses whitespace and substitutes {file} token-wise", () => {
    expect(checkRunArgv("  node   {file}  ", "a.ts")).toEqual(["node", "a.ts"]);
    expect(checkRunArgv("{file}", "sub/oracle.ts")).toEqual(["sub/oracle.ts"]);
    expect(checkRunArgv("node --flag={file} tail", "f.ts")).toEqual([
      "node",
      "--flag=f.ts",
      "tail",
    ]);
    // Quoting is literal argv, not shell syntax — "a b" stays two tokens.
    expect(checkRunArgv('node "a b" {file}', "f.ts")).toEqual(["node", '"a', 'b"', "f.ts"]);
    expect(checkRunArgv("", "f.ts")).toEqual([]);
  });

  it("argv[0] with a separator is refused without executing (CX-126)", async () => {
    const m = mini({
      "oracle.mjs": ORACLE_BODY,
      evil: "#!/bin/sh\ntouch EVIL-RAN\n",
    });
    chmodSync(`${m.root}/evil`, 0o755);
    const r = await spawnRun(m, "./evil {file}", "oracle.mjs");
    expect(r.failureClass).toBe("spawn");
    expect(r.outputTail).toMatch(/PATH executable/);
    expect(existsSync(`${m.root}/EVIL-RAN`)).toBe(false);
  });

  it("deep, absolute and windows-style argv[0] paths are refused (CX-126)", async () => {
    const m = mini({ "oracle.mjs": ORACLE_BODY });
    for (const [i, t] of [
      "a/b/evil {file}",
      "/usr/bin/node {file}",
      "/bin/sh -c {file}",
      "C:\\\\x {file}",
      ".\\\\evil {file}",
    ].entries()) {
      const r = await spawnRun(m, t, "oracle.mjs", `r${i}`);
      expect(r.failureClass, `${t} must refuse`).toBe("spawn");
      expect(r.exitCode).toBeNull();
    }
  });

  it("{file} as argv[0]: a slashed oracle path is refused (CX-127); a bare name hits PATH and fails spawn", async () => {
    const m = mini({ "sub/oracle.mjs": ORACLE_BODY });
    const slashed = await spawnRun(m, "{file}", "sub/oracle.mjs", "r1");
    expect(slashed.failureClass).toBe("spawn");
    expect(slashed.outputTail).toMatch(/PATH executable/);
    const bare = await spawnRun(m, "{file}", "oracle.mjs", "r2");
    // No separator → PATH lookup — never the worktree file — ENOENT spawn.
    expect(bare.failureClass).toBe("spawn");
    expect(existsSync(`${m.root}/ORACLE-RAN`)).toBe(false);
  });

  it("node {file} still runs the oracle (no false refusal)", async () => {
    const m = mini({ "oracle.mjs": ORACLE_BODY });
    const r = await spawnRun(m, "node {file}", "oracle.mjs");
    expect(r.failureClass).toBe("none");
    expect(r.exitCode).toBe(0);
    expect(existsSync(`${m.root}/ORACLE-RAN`)).toBe(true);
  });

  it("a NUL byte in a checkRun token is a synchronous spawn failure, never a rejection (CX-129)", async () => {
    const m = mini({ "oracle.mjs": ORACLE_BODY });
    const arg = await spawnRun(m, "node a\0b {file}", "oracle.mjs", "r1");
    expect(arg.failureClass).toBe("spawn");
    expect(arg.exitCode).toBeNull();
    const argv0 = await spawnRun(m, "n\0ode {file}", "oracle.mjs", "r2");
    expect(argv0.failureClass).toBe("spawn");
    expect(existsSync(`${m.root}/ORACLE-RAN`)).toBe(false);
  });

  it("launcher argv[0]s (env/sh) resolve via PATH but delegate to repo files — documented equivalence class with `node ./x`", async () => {
    const m = mini({ "marker.sh": "#!/bin/sh\ntouch LAUNCHER-RAN\n" });
    chmodSync(`${m.root}/marker.sh`, 0o755);
    const env = await spawnRun(m, "env ./marker.sh", "oracle.mjs", "r1");
    // The argv[0] guard judges argv[0] only; the delegated path is the same
    // capability `node ./x`/`sh ./x` already grants a frozen template — the
    // report records this as a trust-model observation, not a bypass.
    expect(env.failureClass).toBe("none");
    expect(existsSync(`${m.root}/LAUNCHER-RAN`)).toBe(true);
    rmSync(`${m.root}/LAUNCHER-RAN`);
    const sh = await spawnRun(m, "sh ./marker.sh", "oracle.mjs", "r2");
    expect(sh.failureClass).toBe("none");
    expect(existsSync(`${m.root}/LAUNCHER-RAN`)).toBe(true);
  });

  it("e2e: checkRun rebinding to ./node is a binding weakening, not an equal target (CX-126)", async () => {
    const f = fx();
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "./node {file}"'),
    );
    f.commit("rebind checkRun to a repo-relative runner");
    const r = await gate(f, f.base);
    expect(rules(r)).toContain("CORR-GATE-02");
    expect(msgs(r).some((m) => /bindings\.commands\.checkRun changed/.test(m))).toBe(true);
    expect(r.status).toBe("fail");
  });

  it('e2e: base checkRun "{file}" makes the oracle file argv[0] and is refused (CX-127)', async () => {
    const m = CONTOUR(FY("{file}"));
    const r = await gate(m, m.head());
    expect(rules(r)).toContain("CORR-GATE-07");
    expect(msgs(r).some((s) => /PATH executable/.test(s))).toBe(true);
    expect(r.status).toBe("fail");
  });
});

/* ════════════════════ B · CYCLE sentinel (CX-128) ════════════════════ */

describe("B: CYCLE sentinel", () => {
  it("canon emits bare <cycle> only for true ancestor cycles — a literal string stays quoted", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(canon(o)).toBe('{"self":<cycle>}');
    expect(canon("<cycle>")).toBe('"<cycle>"');
    expect(canon(o)).not.toBe(canon({ self: "<cycle>" }));
    // Other branches are prefixed — no ordinary value reaches the bare form.
    expect(canon(NaN)).toBe("num:NaN");
    expect(canon(-0)).toBe("num:-0");
    expect(canon(0)).toBe("0");
    expect(canon(Infinity)).toBe("num:Infinity");
    expect(canon(5n)).toBe("int:5");
    expect(canon(new Date(0))).toBe("date:0");
    expect(canon(new Set(["<cycle>"]))).toBe('set:{"<cycle>"}');
    expect(canon(new Map([["<cycle>", 1]]))).toBe('map:{"<cycle>":1}');
    expect(canon(Uint8Array.from([1, 2]))).toBe("bin:1,2");
    expect(canon(undefined)).toBe("null");
    expect(canon(null)).toBe("null");
  });

  it("policyLeaves stores the sentinel on a true cycle, never on a literal string or shared alias", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    const leaves = policyLeaves({ x: cyc });
    expect(canon(leaves.get('["x"]["self"]'))).toBe("<cycle>");
    // literal `"<cycle>"` is a different leaf value (CX-128)
    const lit = policyLeaves({ x: { self: "<cycle>" } });
    expect(canon(lit.get('["x"]["self"]'))).toBe('"<cycle>"');
    // shared non-cyclic alias — the WeakSet unwinds per branch (CX-21)
    const shared = { k: 1 };
    const dag = policyLeaves({ a: shared, b: shared });
    expect(canon(dag.get('["a"]["k"]'))).toBe("1");
    expect(canon(dag.get('["b"]["k"]'))).toBe("1");
    // empty containers contribute no leaves (CX-2)
    expect(policyLeaves({ a: {} }).size).toBe(0);
    expect(policyLeaves({ a: [] }).size).toBe(0);
    expect(policyLeaves({ a: null }).size).toBe(0);
  });

  it("YAML aliases can carry a real cycle — the leaf diff flags it vs a plain value but not vs an identical cycle", () => {
    const cyclic = "k: 1\nself: &x\n  k: 1\n  self: *x\n";
    const cyc = parseYaml(cyclic) as Record<string, unknown>;
    const diffLeaf = (b: unknown, a: unknown) => {
      const before = policyLeaves(b);
      const after = policyLeaves(a);
      return [...before.keys(), ...after.keys()].filter(
        (p) => !before.has(p) || !after.has(p) || canon(before.get(p)) !== canon(after.get(p)),
      );
    };
    expect(diffLeaf({ k: 1, self: "<cycle>" }, cyc).length).toBeGreaterThan(0);
    const cyc2 = parseYaml(cyclic) as Record<string, unknown>;
    expect(diffLeaf(cyc, cyc2).length).toBe(0);
  });
});

/* ════════════════════ C · NUL / execFile guards (CX-129) ═════════════ */

describe("C: NUL and execFile guards", () => {
  it("GateRepo read paths flag a NUL pathspec instead of crashing", async () => {
    const m = mini({ "a.txt": "x\n" });
    const repo = new GateRepo(m.root);
    const head = m.head();
    expect(await repo.show(head, "a\0b.txt")).toBeNull();
    expect(repo.unreadableReads.length).toBeGreaterThan(0);
    const u = repo.unreadableReads.length;
    expect(await repo.listing(["ls-tree", "-z", head, "--", ":(literal)a\0b"], "nul")).toBeNull();
    expect(repo.unreadableReads.length).toBeGreaterThan(u);
  });

  it("createOriginGit run/runExit catch the synchronous execFile throw on NUL args", async () => {
    const m = mini({ "a.txt": "x\n" });
    const git = createOriginGit(m.root);
    expect(await git.run(["show", "HEAD:a\0b"])).toBeNull();
    expect(await git.runExit!(["ls-tree", "-z", "HEAD", "--", ":(literal)a\0b"])).toBeNull();
    // showMany: NUL reaches stdin only — git answers per-spec, never a crash
    const many = await git.showMany!(["HEAD:a.txt", "HEAD:a\0b"]);
    if (many !== null) {
      expect(many[0]).toBe("x\n");
      expect(many[1]).toBeNull();
    }
  });

  it("e2e: a NUL oracleReviewsDir binding fails closed, not as an empty review set", async () => {
    const f = fx();
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace(
          "correctnessManifest: docs/correctness.yaml",
          `correctnessManifest: docs/correctness.yaml\n    oracleReviewsDir: "docs/x\\0y"`,
        ),
    );
    f.commit("bind a NUL reviews dir");
    const r = await gate(f, f.base);
    expect(r.status).toBe("fail");
    expect(rules(r)).toContain("CORR-GATE-01");
    expect(msgs(r).some((s) => /a git read failed/.test(s))).toBe(true);
  });

  it("e2e: a NUL check target fails closed through the listing ledger", async () => {
    const f = fx();
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace(`check: test:${ORACLE_PATH}`, 'check: "test:a\\0b.ts"'),
    );
    f.commit("rebind to a NUL oracle path");
    const r = await gate(f, f.base);
    expect(r.status).toBe("fail");
    expect(rules(r)).toContain("CORR-GATE-01");
  });

  it("e2e: a NUL correctnessManifest binding fails closed", async () => {
    const f = fx();
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("correctnessManifest: docs/correctness.yaml", 'correctnessManifest: "docs/x\\0y"'),
    );
    f.commit("NUL manifest binding");
    const r = await gate(f, f.base);
    expect(r.status).toBe("fail");
    expect(rules(r)).toContain("CORR-GATE-01");
  });

  it("e2e: a NUL checkRun at base is a spawn failure (CORR-GATE-07), not a gate crash (CX-129)", async () => {
    const m = CONTOUR(FY("n\0ode {file}"));
    const r = await gate(m, m.head());
    expect(r.status).toBe("fail");
    expect(rules(r)).toContain("CORR-GATE-07");
  });
});

/* ════════════════════ D · binding-compare regressions ════════════════ */

describe("D: binding compare — posix-normalize paths, exact checkRun", () => {
  const FYt = (manifest: string, extra = "") => `schema: forge/config@1
bindings:
  commands: {checkRun: "node {file}"}
  paths:
    compassDocs: [docs/req.xml]
    correctnessManifest: ${manifest}
correctness: {mode: enforce}
${extra}`;

  it("resolution-equivalent path spellings stay equal", () => {
    const base = frozenOf(FYt("docs/c.yaml"));
    for (const spelling of [
      "./docs/c.yaml",
      "docs//c.yaml",
      "docs/../docs/c.yaml",
      "docs/x/../c.yaml",
    ]) {
      const ws = diffWeakenings(base, sideOf(FYt(y(spelling))));
      expect(ws, spelling).toEqual([]);
    }
  });

  it("literal-filename spellings stay differences (backslash, space, trailing slash)", () => {
    const base = frozenOf(FYt("docs/c.yaml"));
    for (const spelling of ["docs\\c.yaml", "docs /c.yaml", "docs/c.yaml ", "docs/c.yaml/"]) {
      const ws = diffWeakenings(base, sideOf(FYt(y(spelling))));
      expect(kinds(ws), spelling).toContain("binding");
    }
  });

  it("checkRun: whitespace collapse equalizes; path-normalization would not (CX-126/CX-127)", () => {
    const base = frozenOf(FYt("docs/c.yaml"));
    const change = (cmd: string) =>
      kinds(
        diffWeakenings(
          base,
          sideOf(FYt("docs/c.yaml").replace('{checkRun: "node {file}"}', `{checkRun: ${y(cmd)}}`)),
        ),
      );
    expect(change("node  {file}")).toEqual([]); // collapse — same argv
    expect(change("./node {file}")).toContain("binding");
    expect(change("a/../node {file}")).toContain("binding");
    expect(change("node/./{file}")).toContain("binding");
    expect(change("{file}")).toContain("binding");
    // quoted argv tokens stay distinct from bare ones — argv-exact compare
    expect(change('node "a b" {file}')).toContain("binding");
    expect(change("node a b {file}")).toContain("binding");
  });

  it("sideFrom keeps raw path spelling (no backslash/whitespace folding)", () => {
    const s = sideOf(FYt("docs/c.yaml").replace("docs/c.yaml", "docs\\c.yaml"));
    expect(s.manifestPath).toBe("docs\\c.yaml");
    const s2 = sideOf(FYt(y(" docs/c.yaml ")));
    expect(s2.manifestPath).toBe(" docs/c.yaml ");
    // checkRun IS whitespace-collapsed at capture time
    const s3 = sideOf(
      FYt("docs/c.yaml").replace('checkRun: "node {file}"', 'checkRun: "  node   {file}  "'),
    );
    expect(s3.checkRun).toBe("node {file}");
  });

  it("binding adds under a declared contour are weakenings (CX-77/78)", () => {
    const base = frozenOf(FYt("docs/c.yaml"));
    const reviews = sideOf(
      FYt("docs/c.yaml").replace(
        "correctnessManifest: docs/c.yaml",
        "correctnessManifest: docs/c.yaml\n    oracleReviewsDir: docs/planted",
      ),
    );
    expect(diffWeakenings(base, reviews).map((w) => w.subject)).toContain(
      "bindings.paths.oracleReviewsDir",
    );
    const rfcs = sideOf(FYt("docs/c.yaml") + "paths:\n  rfcsDir: docs/planted\n");
    expect(diffWeakenings(base, rfcs).map((w) => w.subject)).toContain("paths.rfcsDir");
    const inv = sideOf(
      FYt("docs/c.yaml").replace(
        "correctnessManifest: docs/c.yaml",
        "correctnessManifest: docs/c.yaml\n    invariantsFile: docs/planted.md",
      ),
    );
    expect(diffWeakenings(base, inv).map((w) => w.subject)).toContain(
      "bindings.paths.invariantsFile",
    );
  });

  it("compassDocs judged as a normalized list — add/drop/reorder flagged, spelling folds", () => {
    const base = frozenOf(FYt("docs/c.yaml"));
    const drop = sideOf(
      FYt("docs/c.yaml").replace("compassDocs: [docs/req.xml]", "compassDocs: []"),
    );
    expect(diffWeakenings(base, drop).map((w) => w.subject)).toContain(
      "bindings.paths.compassDocs",
    );
    const reordered = frozenOf(
      FYt("docs/c.yaml").replace(
        "compassDocs: [docs/req.xml]",
        "compassDocs: [docs/a.xml, docs/b.xml]",
      ),
    );
    const rev = sideOf(
      FYt("docs/c.yaml").replace(
        "compassDocs: [docs/req.xml]",
        "compassDocs: [docs/b.xml, docs/a.xml]",
      ),
    );
    expect(diffWeakenings(reordered, rev).map((w) => w.subject)).toContain(
      "bindings.paths.compassDocs",
    );
    const spelled = sideOf(
      FYt("docs/c.yaml").replace("compassDocs: [docs/req.xml]", "compassDocs: [./docs/req.xml]"),
    );
    expect(diffWeakenings(base, spelled)).toEqual([]);
  });

  it("mode, tier, and audit.allow diffs", () => {
    const baseAllow = `schema: forge/config@1
bindings:
  commands: {checkRun: "node {file}"}
  paths: {correctnessManifest: docs/c.yaml}
correctness:
  mode: enforce
  audit:
    allow: [{check: c1, subject: s1}]
`;
    const base = frozenOf(baseAllow);
    const lowered = sideOf(baseAllow.replace("mode: enforce", "mode: warn"));
    expect(kinds(diffWeakenings(base, lowered))).toContain("mode");
    const exempt = sideOf(baseAllow.replace("mode: enforce", "mode: exempt"));
    expect(kinds(diffWeakenings(base, exempt))).toContain("mode");
    const high = frozenOf(baseAllow.replace("mode: enforce", "mode: enforce\n  tier: high"));
    expect(kinds(diffWeakenings(high, sideOf(baseAllow)))).toContain("tier");
    const allowAdded = sideOf(
      baseAllow.replace(
        "[{check: c1, subject: s1}]",
        "[{check: c1, subject: s1}, {check: c2, subject: s2}]",
      ),
    );
    expect(kinds(diffWeakenings(base, allowAdded))).toContain("allow");
  });
});

/* ════════════════════ E · policy surface + remaining gate ═══════════ */

describe("E1: policy declaration parse (deny-by-default)", () => {
  const fy = (policy: string) =>
    `schema: forge/config@1\ncorrectness: {mode: enforce}\npolicy: ${policy}\n`;
  it("malformed shapes flag, absent stays inert, declared maps arm", () => {
    expect(sideOf("schema: x\n")).toMatchObject({ policy: null, policyMalformed: false });
    expect(sideOf(fy("{}"))).toMatchObject({ policyMalformed: false });
    expect(sideOf(fy("")).policyMalformed).toBe(true); // policy: null is malformed (CX-8)
    expect(sideOf(fy("[]")).policyMalformed).toBe(true);
    expect(sideOf(fy('"s"')).policyMalformed).toBe(true);
    expect(sideOf(fy("{mutable: x}")).policyMalformed).toBe(true);
    expect(sideOf(fy("{mutable: [1]}")).policyMalformed).toBe(true);
    expect(sideOf(fy('{freezeFiles: ["!g"]}')).policyMalformed).toBe(true); // !-negation (CX-53 class)
    expect(sideOf(fy('{freezeFiles: ["hooks/**"]}')).policyMalformed).toBe(false);
    expect(sideOf(fy("{unknown: [x]}")).policyMalformed).toBe(false); // arms with empty lists
    expect(sideOf(fy("{unknown: [x]}")).policy).toEqual({
      mutable: [],
      additive: [],
      freezeFiles: [],
    });
  });
});

describe("E2: policyWeakenings — frozen keys, additive leaves, __proto__, BigInt/NaN/-0", () => {
  /** A full document: the named stanza is the only variable. */
  const DOC = (agent: string, custom: string, policy: string, extra = "") => `schema: forge/config@1
project: {name: t}
bindings:
  commands: {checkRun: "node {file}"}
  paths: {correctnessManifest: docs/c.yaml}
correctness: {mode: enforce}
${agent}
${custom}
${extra}${policy}
`;
  const A = "agent:\n  key: base";
  const C = "custom:\n  list: [a, b]";
  const P = "policy:\n  mutable: [agent]\n  additive: [custom]";
  const BASE = DOC(A, C, P);
  const w = (nowYaml: string) => kinds(policyWeakenings(frozenOf(BASE), sideOf(nowYaml)));

  it("mutable keys change or drop freely; additive keys grow but never lose/change leaves", () => {
    expect(w(DOC("agent:\n  key: other", C, P))).toEqual([]);
    expect(w(DOC(A, "custom:\n  list: [a, b, c]", P))).toEqual([]);
    expect(w(DOC(A, "custom:\n  list: [a]", P))).toContain("policy-key");
    expect(w(DOC(A, "custom:\n  list: [a, c]", P))).toContain("policy-key");
    expect(w(DOC("", C, P))).toEqual([]); // a mutable key may be removed
    expect(w(DOC(A, "", P))).toContain("policy-key"); // an additive key may not
  });

  it("undeclared top-level keys, frozen-key changes, and a policy: edit are flagged", () => {
    expect(w(DOC(A, C, P, "newkey: 1\n"))).toContain("policy-key");
    expect(w(DOC(A, C, P).replace("name: t", "name: u"))).toContain("policy-key");
    expect(w(DOC(A, C, P).replace("mode: enforce", "mode: warn"))).toContain("policy-key");
    expect(w(DOC(A, C, "policy:\n  mutable: [other]\n  additive: [custom]"))).toContain(
      "policy-decl",
    );
    expect(subjOf([], BASE, DOC(A, C, P, "newkey: 1\n"))).toContain("newkey");
  });

  it("__proto__ own-key addition is flagged, never reads through the chain (CX-13)", () => {
    const now = sideOf(DOC(A, C, P, "__proto__:\n  polluted: true\n"));
    expect(Object.hasOwn(now.forgeDoc, "__proto__")).toBe(true);
    const ws = policyWeakenings(frozenOf(BASE), now);
    expect(kinds(ws)).toContain("policy-key");
    expect(ws.map((x) => x.subject)).toContain("__proto__");
  });

  it("BigInt, NaN, -0 leaves are distinct canonical values (CX-14/CX-22)", () => {
    const docLeaf = (leaf: string) => DOC(A, C, P, `leaf: ${leaf}\n`);
    const leafBase = frozenOf(docLeaf("9007199254740993"));
    const wl = (leaf: string) => kinds(policyWeakenings(leafBase, sideOf(docLeaf(leaf))));
    expect(wl("9007199254740992")).toContain("policy-key");
    expect(wl("9007199254740993")).toEqual([]);
    expect(wl(".nan")).toContain("policy-key");
    expect(wl("-0")).toContain("policy-key");
    expect(wl("0")).toContain("policy-key"); // 0 ≠ BigInt — same as any change
  });

  it("a literal '<cycle>' leaf and a true cycle leaf never compare equal (CX-128)", () => {
    const docLeaf = (leaf: string) => DOC(A, C, P, `leaf: ${leaf}\n`);
    const litBase = frozenOf(docLeaf('{self: "<cycle>"}'));
    const cycNow = sideOf(docLeaf("&x\n  self: *x"));
    expect(kinds(policyWeakenings(litBase, cycNow))).toContain("policy-key");
    const cycBase = frozenOf(docLeaf("&x\n  self: *x"));
    const litNow = sideOf(docLeaf('{self: "<cycle>"}'));
    expect(kinds(policyWeakenings(cycBase, litNow))).toContain("policy-key");
    // identical cycles on both sides: no fabricated diff
    const cycNow2 = sideOf(docLeaf("&x\n  self: *x"));
    expect(kinds(policyWeakenings(cycBase, cycNow2))).toEqual([]);
  });
});

const subjOf = (_k: string[], baseYaml: string, nowYaml: string) =>
  policyWeakenings(frozenOf(baseYaml), sideOf(nowYaml)).map((x) => x.subject);

describe("E3: policy surface e2e — freezeFiles, accept isolation, exempt contour", () => {
  const POLICY = `policy:
  mutable: [agent]
  additive: [custom]
  freezeFiles: ["hooks/**"]
agent:
  key: base
custom:
  list: [a]
`;
  it("a new file matching freezeFiles is a policy-file weakening; a mutable edit is not", async () => {
    const f = fx({
      forgeYamlAppend: POLICY,
      extraFiles: { "hooks/run.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/new.sh", "#!/bin/sh\necho planted\n");
    f.commit("add a hook");
    const r = await gate(f, f.base);
    expect(msgs(r).some((m) => /policy-file|policy\.freezeFiles/.test(m))).toBe(true);
    expect(r.status).toBe("fail");
    const f2 = fx({ forgeYamlAppend: POLICY });
    f2.write("forge.yaml", f2.read("forge.yaml").replace("key: base", "key: changed"));
    f2.commit("mutable key edit");
    expect((await gate(f2, f2.base)).status).toBe("pass");
  });

  it("--accept-weakening: an isolated policy-file weakening accepts; a mutable-key edit makes the diff foreign", async () => {
    const f = fx({
      forgeYamlAppend: POLICY,
      extraFiles: { "hooks/run.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/run.sh", "#!/bin/sh\necho weakened\n");
    f.commit("edit a frozen hook");
    const iso = await gate(f, f.base, { acceptWeakening: "operator: hook refresh" });
    expect(iso.acceptedWeakening).toBe("operator: hook refresh");
    expect(rules(iso)).not.toContain("CORR-GATE-02");
    const f2 = fx({
      forgeYamlAppend: POLICY,
      extraFiles: { "hooks/run.sh": "#!/bin/sh\nexit 0\n" },
    });
    f2.write("hooks/run.sh", "#!/bin/sh\necho weakened\n");
    f2.write("forge.yaml", f2.read("forge.yaml").replace("key: base", "key: changed"));
    f2.commit("frozen hook + mutable key");
    const mixed = await gate(f2, f2.base, { acceptWeakening: "operator: hook refresh" });
    expect(mixed.acceptedWeakening).toBeNull();
    expect(msgs(mixed).some((m) => /mixed-weakening/.test(m))).toBe(true);
    const f3 = fx({ forgeYamlAppend: POLICY });
    f3.write("hooks/planted.sh", "#!/bin/sh\nexit 0\n");
    f3.write("src/planted.ts", "export const x = 1;\n");
    f3.commit("foreign file rides along");
    const foreign = await gate(f3, f3.base, { acceptWeakening: "operator: hook refresh" });
    expect(msgs(foreign).some((m) => /mixed-weakening/.test(m))).toBe(true);
  });

  it("exempt×exempt still judges a declared policy surface (CX-29)", async () => {
    const f = fx({
      mode: "exempt",
      forgeYamlAppend: POLICY,
      extraFiles: { "hooks/run.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/new.sh", "#!/bin/sh\necho planted\n");
    f.commit("extend the frozen surface");
    const r = await gate(f, f.base);
    expect(msgs(r).some((m) => /policy-file/.test(m))).toBe(true);
    expect(r.status).toBe("fail");
    const clean = fx({ mode: "exempt" });
    expect((await gate(clean, clean.base)).status).toBe("exempt");
  });

  it("--policy-only judges the declared policy surface without oracle runs", async () => {
    const f = fx({ forgeYamlAppend: POLICY });
    f.write("hooks/planted.sh", "#!/bin/sh\necho hi\n");
    f.commit("extend frozen surface");
    const r = await gate(f, f.base, { policyOnly: true });
    expect(msgs(r).some((m) => /policy-file/.test(m))).toBe(true);
    expect(r.status).toBe("fail");
  });
});

/* ════════════════════ F · oracle origin + rfc parity ═════════════════ */

describe("F: rfcPath traversal parity + review records + self-origin", () => {
  const RFC = (name: string) => `---\nid: RFC-0001\nstatus: draft\n---\n# ${name}\n`;
  it("rfcPath mirrors findRfcFile: root files first, archive subtree in reverse-lexical dirs", async () => {
    const m = mini({
      "docs/rfcs/rfc-0001-root.md": RFC("root"),
      "docs/rfcs/archive/rfc-0001-arc.md": RFC("arc"),
      "docs/rfcs/archive/zzz/rfc-0001-z.md": RFC("z"),
      "docs/rfcs/archive/aaa/rfc-0001-a.md": RFC("a"),
      "docs/rfcs/other/rfc-0001-o.md": RFC("out-of-scope"),
    });
    const repo = new GateRepo(m.root);
    const h1 = m.head();
    expect(await rfcPath(repo, h1, "docs/rfcs", "RFC-0001")).toBe("docs/rfcs/rfc-0001-root.md");
    m.git(["rm", "-q", "docs/rfcs/rfc-0001-root.md"]);
    const h2 = m.commit("remove root rfc");
    expect(await rfcPath(repo, h2, "docs/rfcs", "RFC-0001")).toBe(
      "docs/rfcs/archive/rfc-0001-arc.md",
    );
    m.git(["rm", "-q", "docs/rfcs/archive/rfc-0001-arc.md"]);
    const h3 = m.commit("remove archive root rfc");
    expect(await rfcPath(repo, h3, "docs/rfcs", "RFC-0001")).toBe(
      "docs/rfcs/archive/zzz/rfc-0001-z.md",
    );
    m.git(["rm", "-q", "docs/rfcs/archive/zzz/rfc-0001-z.md"]);
    const h4 = m.commit("remove z");
    expect(await rfcPath(repo, h4, "docs/rfcs", "RFC-0001")).toBe(
      "docs/rfcs/archive/aaa/rfc-0001-a.md",
    );
    m.git(["rm", "-q", "docs/rfcs/archive/aaa/rfc-0001-a.md"]);
    const h5 = m.commit("remove a");
    expect(await rfcPath(repo, h5, "docs/rfcs", "RFC-0001")).toBeNull(); // other/ is out of scope
  });

  it("rfcsDir '.', './' and '' resolve to a repository-root pathspec (CX-115)", async () => {
    const m = mini({
      "rfc-0001-root.md": RFC("root"),
      "archive/rfc-0001-arc.md": RFC("arc"),
      "docs/rfc-0001-nested.md": RFC("out"),
    });
    const repo = new GateRepo(m.root);
    const head = m.head();
    for (const dir of [".", "./", ""]) {
      expect(await rfcPath(repo, head, dir, "RFC-0001"), dir).toBe("rfc-0001-root.md");
    }
    m.git(["rm", "-q", "rfc-0001-root.md"]);
    const h2 = m.commit("rm root");
    expect(await rfcPath(repo, h2, ".", "RFC-0001")).toBe("archive/rfc-0001-arc.md");
  });

  it("readReviewRecords treats '.', './', '' as the repository root (CX-115)", async () => {
    const m = mini({ "a.txt": "x\n" });
    const rel = "reviews/r.yaml";
    m.write(rel, reviewYaml([{ check: "test:x.ts", content: "body" }]));
    verifierCommit(m.git, rel);
    const repo = new GateRepo(m.root);
    const head = m.head();
    for (const dir of [".", "./", ""]) {
      const rows = await readReviewRecords(repo, head, dir);
      expect(
        rows.some((r) => r.record === rel),
        dir,
      ).toBe(true);
    }
    expect(repo.unreadableReads).toEqual([]);
    const scoped = await readReviewRecords(repo, head, "reviews");
    expect(scoped.map((r) => r.record)).toEqual([rel]);
  });

  it("e2e: an oracle with no review record and no verifier trailers is self (CORR-GATE-03)", async () => {
    const f = fx({ review: false });
    const r = await gate(f, f.base);
    expect(rules(r)).toContain("CORR-GATE-03");
    expect(rules(r)).toContain("CORR-GATE-08");
    expect(r.status).toBe("fail");
  });
});

/* ════════════════════ G · remaining structural surface ══════════════ */

describe("G: remaining structural surface", () => {
  it("warn mode never downgrades structural weakening/refusal rules", async () => {
    const f = fx({ mode: "warn" });
    f.write(
      "docs/correctness.yaml",
      "schema: forge/correctness-manifest@1\nentries: []\nsupport: []\nexemptions: []\n",
    );
    f.commit("drop the entry");
    const r = await gate(f, f.base);
    const g02 = r.violations.filter((v) => v.rule === "CORR-GATE-02");
    expect(g02.length).toBeGreaterThan(0);
    expect(g02.every((v) => v.severity === "error")).toBe(true);
    expect(r.status).toBe("fail");
  });

  it("a chmod-only flip on a frozen file is a mode weakening (CX-54)", async () => {
    const f = fx();
    chmodSync(path.join(f.root, ORACLE_PATH), 0o755);
    f.commit("chmod the oracle");
    const r = await gate(f, f.base);
    expect(msgs(r).some((m) => /mode changed 100644 → 100755/.test(m))).toBe(true);
    expect(r.status).toBe("fail");
  });

  it("a reworded frozen anchor is an anchor weakening (CX-70)", async () => {
    const f = fx();
    f.write(
      "apps/api/src/dispatch.ts",
      f
        .read("apps/api/src/dispatch.ts")
        .replace(
          "dispatch moves an approved candidate to queued exactly once",
          "dispatch does something else entirely",
        ),
    );
    f.commit("reword the anchor");
    const r = await gate(f, f.base);
    expect(msgs(r).some((m) => /anchor.*(reworded|statement changed)/i.test(m))).toBe(true);
    expect(r.status).toBe("fail");
  });

  it("a `!` support glob in the base manifest refuses as CORR-GATE-01 (CX-53)", async () => {
    const m = CONTOUR(FY("node {file}"), {
      "docs/correctness.yaml": manifestYaml({}).replace("support: []", 'support: ["!test/**"]'),
    });
    const r = await gate(m, m.head());
    expect(rules(r)).toContain("CORR-GATE-01");
    expect(msgs(r).some((s) => /`!` negation/.test(s))).toBe(true);
    expect(r.status).toBe("fail");
  });

  it("a forged verifier trailer exempts its own file's byte diff — disclosed trailer trust, not a gap", async () => {
    const f = fx();
    f.write(ORACLE_PATH, L1_ORACLE + "// comment\n");
    f.git(["add", "-A"]);
    f.git([
      "commit",
      "-qm",
      "weaken oracle\n\nX-Expectation-Origin: independent-verifier\nX-Verifier-Report: docs/correctness/reviews/x.yaml",
    ]);
    const r = await gate(f, f.base);
    // The trailer pair exempts the byte diff and promotes origin to verified
    // — agent-writable by design (BUNDLE_LIMITATIONS disclosure).
    expect(msgs(r).some((m) => /frozen file .*changed without the verifier/.test(m))).toBe(false);
    expect(rules(r)).not.toContain("CORR-GATE-02");
  });
});

/* ════════════════════ H · flow-side bootstrap degrade (baseAdoptedGate) ══ */

describe("H: baseAdoptedGate — a downgrade must not degrade on an adopted base", () => {
  // The hardened boundary channel (gitEvidence/verifierSpawn) deliberately
  // bypasses io.exec and session PATH — stub injection lands on the resolved
  // binary seam or on real repo fixtures instead (CX-46..52).
  const UNKNOWN_BIN = "#!/bin/sh\necho '  ✖ Unknown command: correctness.gate' >&2\nexit 1\n";

  /** Real repo + real unknown-command forge; forge.yaml (or none) committed at HEAD. */
  async function stepAt(fy: string | null, base = "HEAD") {
    const repo = mkdtempSync(path.join(os.tmpdir(), "cx22-step-"));
    minis.push({ cleanup: () => rmSync(repo, { recursive: true, force: true }) });
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).toString().trim();
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);
    if (fy !== null) writeFileSync(path.join(repo, "forge.yaml"), fy);
    mkdirSync(path.join(repo, "node_modules", ".bin"), { recursive: true });
    writeFileSync(path.join(repo, "node_modules", ".bin", "forge"), UNKNOWN_BIN);
    chmodSync(path.join(repo, "node_modules", ".bin", "forge"), 0o755);
    writeFileSync(path.join(repo, "seed.txt"), "s\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "fixture"]);
    return runCorrectnessStep(ambientIo, { primary: repo, worktree: repo, base });
  }

  it("canonical adopted spellings refuse a forge downgrade; a non-adopted base degrades", async () => {
    for (const fy of [
      "bindings:\n  paths:\n    correctnessManifest: docs/c.yaml\n",
      "correctness:\n  mode: enforce\n",
      "correctness:\n",
    ]) {
      const r = await stepAt(fy);
      expect(r.refusal, fy).toBeDefined();
      expect(r.status).toBe("not-run");
    }
    const r = await stepAt("bindings:\n  paths:\n    correctnessManifest: null\nother: 1\n");
    expect(r.refusal).toBeUndefined();
    expect(r.warning?.ruleId).toBe("FLOW-INT-18");
  });

  // CX-130: `sideFrom` binds every one of these; `baseAdoptedGate`'s line
  // regexes see none. Each is a live downgrade-laundering reproduction.
  for (const [label, fy] of [
    ["space before colon", "bindings:\n  paths:\n    correctnessManifest : docs/c.yaml\n"],
    ["quoted key", 'bindings:\n  paths:\n    "correctnessManifest": docs/c.yaml\n'],
    ["flow-style bindings", "bindings: {paths: {correctnessManifest: docs/c.yaml}}\n"],
    ["flow-style section", "correctness: {mode: enforce}\n"],
    ["indented section", " correctness:\n  mode: enforce\n"],
  ] as const) {
    it(`CX-130 (${label}): baseAdoptedGate must see the adopted contour, not degrade`, async () => {
      const r = await stepAt(fy);
      expect(r.refusal).toBeDefined();
    });
  }

  it("CX-131: a failed `git show base:forge.yaml` is unknown adoption, not 'not adopted'", async () => {
    // A base that exists as an object but is not a commit — `ls-tree` exits
    // 128 on the real binary, the same failure the io.exec stub used to fake.
    const r = await stepAt("x: 1\n", "0000000000000000000000000000000000000000");
    expect(r.refusal, "a failed base read must fail closed, not degrade").toBeDefined();
  });

  it("a failed git spawn inside baseAdoptedGate is an unreadable read — structured refusal, never degrades", async () => {
    // The resolved-binary seam is the in-process injection point; a spawn
    // ENOENT reports exitCode -1 → unreadable → refusal.
    setVerifierGitBinForTests(path.join(os.tmpdir(), "cx22-no-such-git"));
    try {
      const r = await stepAt("x: 1\n");
      expect(r.refusal, "a failed spawn is unreadable, not 'not adopted'").toBeDefined();
      expect(r.warning).toBeUndefined();
    } finally {
      setVerifierGitBinForTests(undefined);
    }
  });
});
