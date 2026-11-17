/*
RFC-1615 round-19 adversarial verification — counterexample probes CX-120+.
Test-only file: never touches gate source. Harness copied from
policy-freeze-cx19.test.ts / tests/gate-fixture.ts so probes control commit
ordering (base-anchored reads need real history).
*/

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessGate } from "./run.ts";
import { readReviewRecords, rfcPath } from "./origin.ts";
import { GateRepo } from "./repo.ts";
import { resolveRfcRef } from "../references.ts";

const HELPERS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/correctness/index.ts",
);
const MARK = "@ai-" + "invariant";
const MIGRATION = "CREATE TABLE candidates (id TEXT PRIMARY KEY, state TEXT NOT NULL);\n";
const ORACLE_PATH = "test/dispatch.oracle.ts";
const L1_ORACLE = `import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { attestSubstrate } from ${JSON.stringify(HELPERS)};
const db = new DatabaseSync(":memory:");
db.exec(readFileSync("apps/api/migrations/0001_init.sql", "utf8"));
attestSubstrate(db, { level: "L1", engine: "node:sqlite" });
`;

interface Repo {
  root: string;
  write(rel: string, body: string): void;
  read(rel: string): string;
  git(args: string[]): string;
  commit(message: string): string;
  cleanup(): void;
}

const repos: Repo[] = [];
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()));

function makeRepo(): Repo {
  const root = mkdtempSync(path.join(os.tmpdir(), "forge-gate-r19-"));
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
  const repo: Repo = {
    root,
    write,
    read: (rel) => readFileSync(path.join(root, rel), "utf8"),
    git,
    commit,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  repos.push(repo);
  return repo;
}

function forgeYaml(
  opts: { mode?: string; extraPaths?: string; extraBindings?: string } = {},
): string {
  return `schema: forge/config@1
project:
  name: gate-r19
paths:
  rfcsDir: docs/rfcs
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
  paths:
    compassDocs: [docs/requirements.xml]
    correctnessManifest: docs/correctness.yaml
    oracleReviewsDir: docs/correctness/reviews
    invariantsFile: docs/invariants.md
${opts.extraBindings ?? ""}correctness:
  mode: ${opts.mode ?? "enforce"}
  tier: standard
${opts.extraPaths ?? ""}`;
}

const MANIFEST_ONE = `schema: forge/correctness-manifest@1
entries:
  - id: CM-dispatch-01
    source: req
    ref: REQ-01
    seam: data
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:${ORACLE_PATH}
        substrate: L1
support: []
exemptions:
  - ref: DNA-1
    kind: unverifiable
    reason: operator approved
`;

function seedContour(r: Repo): void {
  r.write("forge.yaml", forgeYaml());
  r.write(
    "docs/requirements.xml",
    '<requirements>\n  <meta><document-id>requirements</document-id></meta>\n  <requirement id="REQ-01">x</requirement>\n</requirements>\n',
  );
  r.write("docs/invariants.md", "# Invariants\n\n## DNA-1\nDispatch is total.\n");
  r.write(
    "apps/api/wrangler.jsonc",
    '{ "d1_databases": [{ "binding": "DB", "database_name": "main", "database_id": "x" }] }\n',
  );
  r.write("apps/api/migrations/0001_init.sql", MIGRATION);
  r.write(
    "apps/api/src/dispatch.ts",
    `export function dispatch(): void {\n  // ${MARK}[INV-dispatch-01]: dispatch moves a candidate to queued exactly once\n  //   (checked-by: test:${ORACLE_PATH})\n}\n`,
  );
  r.write(ORACLE_PATH, L1_ORACLE);
  r.write("docs/correctness.yaml", MANIFEST_ONE);
}

function reviewRecord(check: string, content: string): string {
  return `schema: forge/oracle-review@1
reviewedAt: 2026-11-13T10:00:00Z
isolation: subagent
candidate: deadbeef
export: "rfc.verify.workspace --manifest"
verdict: pass
oracles:
  - check: ${check}
    sha256: "${createHash("sha256").update(content).digest("hex")}"
    verdict: pass
    attestedHandleIsUnderTest: true
`;
}

function verifierCommit(r: Repo, rel: string): string {
  r.git(["add", "-A"]);
  r.git([
    "commit",
    "-qm",
    `review\n\nX-Expectation-Origin: independent-verifier\nX-Verifier-Report: ${rel}`,
  ]);
  return r.git(["rev-parse", "HEAD"]);
}

const gate = async (r: Repo, base: string, acceptWeakening?: string) => {
  const out = await runCorrectnessGate(r.root, {
    base,
    bundleDir: `${r.root}/.bundles`,
    acceptWeakening,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
};
const rules = (x: { violations: { rule: string }[] }) => x.violations.map((v) => v.rule);

const RFC = (id: string, status: string, acs: string[]) => `---
id: ${id}
status: ${status}
---

## Acceptance criteria

${acs.map((a) => `- [ ] ${a}: criterion ${a}`).join("\n")}
`;

describe("CX-120: `\\` and whitespace respells of correctnessManifest hide a real rebind", () => {
  it("docs\\correctness.yaml (literal backslash file) is a DIFFERENT git path — the rebind must be a weakening", async () => {
    const r = makeRepo();
    seedContour(r);
    r.write(
      "docs/correctness/reviews/2026-11-13-base.yaml",
      reviewRecord(`test:${ORACLE_PATH}`, L1_ORACLE),
    );
    verifierCommit(r, "docs/correctness/reviews/2026-11-13-base.yaml");
    const base = r.git(["rev-parse", "HEAD"]);
    // Session: rebind to a literal-BACKSLASH path (a different file on
    // POSIX/git) and plant a valid emptied manifest there — the live flavor
    // reads docs\correctness.yaml, the gate keeps judging docs/correctness.yaml.
    r.write(
      "forge.yaml",
      r
        .read("forge.yaml")
        .replace(
          "correctnessManifest: docs/correctness.yaml",
          "correctnessManifest: docs\\correctness.yaml",
        ),
    );
    r.write(
      "docs\\correctness.yaml",
      `schema: forge/correctness-manifest@1
entries: []
support: []
exemptions:
  - ref: REQ-01
    kind: unverifiable
    reason: operator approved
  - ref: DNA-1
    kind: unverifiable
    reason: operator approved
`,
    );
    r.commit("rebind manifest to a backslash respell + retire the contour");
    const res = await gate(r, base);
    console.log(
      "CX-120a",
      JSON.stringify({
        status: res.status,
        wk: res.weakenings,
        vio: res.violations.map((v) => v.message),
      }),
    );
    // The rebind is a real weakening (the live binding points at a different
    // file); normalization must not equalize it away.
    expect(res.weakenings.filter((w) => w.kind === "binding")).not.toEqual([]);
    expect(res.status).toBe("fail");
  });

  it('leading-whitespace respell " docs/correctness.yaml" names a different dir — the rebind must be a weakening', async () => {
    const r = makeRepo();
    seedContour(r);
    r.write(
      "docs/correctness/reviews/2026-11-13-base.yaml",
      reviewRecord(`test:${ORACLE_PATH}`, L1_ORACLE),
    );
    verifierCommit(r, "docs/correctness/reviews/2026-11-13-base.yaml");
    const base = r.git(["rev-parse", "HEAD"]);
    r.write(
      "forge.yaml",
      r
        .read("forge.yaml")
        .replace(
          "correctnessManifest: docs/correctness.yaml",
          'correctnessManifest: " docs/correctness.yaml"',
        ),
    );
    r.write(
      " docs/correctness.yaml",
      `schema: forge/correctness-manifest@1
entries: []
support: []
exemptions:
  - ref: REQ-01
    kind: unverifiable
    reason: operator approved
  - ref: DNA-1
    kind: unverifiable
    reason: operator approved
`,
    );
    r.commit("rebind manifest to a leading-space respell");
    const res = await gate(r, base);
    console.log(
      "CX-120b",
      JSON.stringify({
        status: res.status,
        wk: res.weakenings,
        vio: res.violations.map((v) => v.message),
      }),
    );
    expect(res.weakenings.filter((w) => w.kind === "binding")).not.toEqual([]);
    expect(res.status).toBe("fail");
  });
});

describe("CX-121: rfcPath `archive/Z` vs `archive/a` — localeCompare vs code-unit traversal parity", () => {
  it("gate must pick the same file findRfcFile reaches (archive/a pops before archive/Z)", async () => {
    const r = makeRepo();
    seedContour(r);
    // Same id, two archive siblings: `a` (code-unit AFTER Z → popped first by
    // the stack walker) declares AC-2; `Z` declares AC-1.
    r.write("docs/rfcs/archive/Z/rfc-0100-b.md", RFC("RFC-0100", "accepted", ["AC-1"]));
    r.write("docs/rfcs/archive/a/rfc-0100-a.md", RFC("RFC-0100", "accepted", ["AC-2"]));
    const head = r.commit("two same-id rfc files in archive/Z and archive/a");
    // Canonical worktree resolution (references.ts findRfcFile) descends into
    // archive/a/ first: names sort code-unit ["Z","a"], pushed in that order,
    // popped last-first → archive/a/ is searched before archive/Z/.
    const wt = resolveRfcRef(r.root, "docs/rfcs", "RFC-0100/AC-2", "AC");
    expect(wt.ok).toBe(true);
    if (wt.ok) expect(wt.rfcFile).toBe("docs/rfcs/archive/a/rfc-0100-a.md");
    const repo = new GateRepo(r.root);
    const found = await rfcPath(repo, head, "docs/rfcs", "RFC-0100");
    expect(found).toBe("docs/rfcs/archive/a/rfc-0100-a.md");
  });

  it("a ref only the locale-picked file declares must not mint requirement origin", async () => {
    const r = makeRepo();
    seedContour(r);
    // archive/Z/rfc-0100-b.md: accepted BEFORE base with a governed commit and
    // declares AC-1. archive/a/rfc-0100-a.md: draft, declares only AC-2 — the
    // file the canonical resolver reaches first.
    r.write("docs/rfcs/archive/Z/rfc-0100-b.md", RFC("RFC-0100", "draft", ["AC-1"]));
    r.write("docs/rfcs/archive/a/rfc-0100-a.md", RFC("RFC-0100", "draft", ["AC-2"]));
    r.write("test/old.ts", L1_ORACLE);
    r.write(
      "docs/correctness/reviews/2026-11-13-base.yaml",
      reviewRecord(`test:${ORACLE_PATH}`, L1_ORACLE),
    );
    verifierCommit(r, "docs/correctness/reviews/2026-11-13-base.yaml");
    r.commit("seed drafts");
    r.write("docs/rfcs/archive/Z/rfc-0100-b.md", RFC("RFC-0100", "accepted", ["AC-1"]));
    r.git(["add", "-A"]);
    r.git(["commit", "-qm", "accept Z-file\n\nX-RFC: RFC-0100"]);
    const base = r.commit("base");
    // Session adds an rfc-ac entry bound to AC-1 — declared ONLY in the file
    // the gate's locale order resolves (archive/Z). The canonical resolver
    // (findRfcFile → archive/a) declares no AC-1 → CORR-03 must refuse.
    r.write(
      "docs/correctness.yaml",
      MANIFEST_ONE.replace(
        "support:",
        `  - id: CM-rfc-01
    source: rfc-ac
    ref: RFC-0100/AC-1
    seam: data
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:test/old.ts
        substrate: L1
support:`,
      ),
    );
    r.write(
      "apps/api/src/dispatch.ts",
      r
        .read("apps/api/src/dispatch.ts")
        .replace(
          `(checked-by: test:${ORACLE_PATH})`,
          `(checked-by: test:${ORACLE_PATH}, test:test/old.ts)`,
        ),
    );
    r.commit("add rfc-ac entry whose ref only the wrong-picked file declares");
    const res = await gate(r, base);
    console.log(
      "CX-121b",
      JSON.stringify({
        status: res.status,
        wk: res.weakenings,
        vio: res.violations.map((v) => v.message),
      }),
    );
    const corr03 = res.violations.find((v) => /CORR-03/.test(v.message));
    expect(corr03?.message ?? "").toMatch(/declares no AC-1|not found/);
    expect(res.status).toBe("fail");
  });
});

describe("CX-122: `\\` respells of the remaining path bindings hide rebinds", () => {
  it("oracleReviewsDir / invariantsFile / rfcsDir / compassDocs backslash respells are real rebinds", async () => {
    const r = makeRepo();
    seedContour(r);
    r.write(
      "docs/correctness/reviews/2026-11-13-base.yaml",
      reviewRecord(`test:${ORACLE_PATH}`, L1_ORACLE),
    );
    verifierCommit(r, "docs/correctness/reviews/2026-11-13-base.yaml");
    const base = r.git(["rev-parse", "HEAD"]);
    // Session respells every path binding with backslashes — each names a
    // DIFFERENT file/dir on POSIX, so each is a real rebind weakening.
    r.write(
      "forge.yaml",
      r
        .read("forge.yaml")
        .replace("rfcsDir: docs/rfcs", "rfcsDir: docs\\rfcs")
        .replace(
          "oracleReviewsDir: docs/correctness/reviews",
          "oracleReviewsDir: docs\\correctness\\reviews",
        )
        .replace("invariantsFile: docs/invariants.md", "invariantsFile: docs\\invariants.md")
        .replace("compassDocs: [docs/requirements.xml]", "compassDocs: [docs\\requirements.xml]"),
    );
    // Plant the backslash-named targets the live flavor now resolves.
    r.write(
      "docs\\invariants.md",
      "# Invariants\n\n## DNA-1\nDispatch is total.\n## DNA-2\nplanted id\n",
    );
    r.write(
      "docs\\requirements.xml",
      '<requirements>\n  <meta><document-id>requirements</document-id></meta>\n  <requirement id="REQ-01">x</requirement>\n  <requirement id="REQ-PLANTED">planted</requirement>\n</requirements>\n',
    );
    r.commit("respell every path binding with backslashes");
    const res = await gate(r, base);
    console.log(
      "CX-122",
      JSON.stringify({
        status: res.status,
        wk: res.weakenings,
        vio: res.violations.map((v) => v.message),
      }),
    );
    // Four rebinds, each hidden by normalizeRelPath's \\ -> / collapse.
    expect(res.weakenings.filter((w) => w.kind === "binding").length).toBeGreaterThanOrEqual(4);
    expect(res.status).toBe("fail");
  });
});

describe("CX-123: rfcPath same-level file case ordering — localeCompare vs code-unit", () => {
  it("rfc-0100-A.md (code-unit first) vs rfc-0100-a.md (locale first) — gate must mirror findRfcFile", async () => {
    const r = makeRepo();
    seedContour(r);
    r.write("docs/rfcs/rfc-0100-A.md", RFC("RFC-0100", "accepted", ["AC-1"]));
    r.write("docs/rfcs/rfc-0100-a.md", RFC("RFC-0100", "accepted", ["AC-2"]));
    const head = r.commit("same-id files differing only by case at the same level");
    // findRfcFile sorts code-unit: "rfc-0100-A.md" < "rfc-0100-a.md" → picks
    // the uppercase file. localeCompare ranks lowercase first — the gate must
    // not diverge.
    const wt = resolveRfcRef(r.root, "docs/rfcs", "RFC-0100/AC-1", "AC");
    expect(wt.ok).toBe(true);
    if (wt.ok) expect(wt.rfcFile).toBe("docs/rfcs/rfc-0100-A.md");
    const repo = new GateRepo(r.root);
    const found = await rfcPath(repo, head, "docs/rfcs", "RFC-0100");
    expect(found).toBe("docs/rfcs/rfc-0100-A.md");
  });

  it("non-ASCII sibling dirs (archive/é vs archive/z) — localeCompare flips code-unit order too", async () => {
    const r = makeRepo();
    seedContour(r);
    // code-unit: "z"(0x7A) < "é"(0xE9) → pushed z then é → é pops FIRST.
    // locale collation puts é with e → before z → rank picks z: divergent.
    r.write("docs/rfcs/archive/é/rfc-0100-e.md", RFC("RFC-0100", "accepted", ["AC-1"]));
    r.write("docs/rfcs/archive/z/rfc-0100-z.md", RFC("RFC-0100", "accepted", ["AC-2"]));
    const head = r.commit("non-ASCII archive siblings");
    const wt = resolveRfcRef(r.root, "docs/rfcs", "RFC-0100/AC-1", "AC");
    expect(wt.ok).toBe(true);
    if (wt.ok) expect(wt.rfcFile).toBe("docs/rfcs/archive/é/rfc-0100-e.md");
    const repo = new GateRepo(r.root);
    const found = await rfcPath(repo, head, "docs/rfcs", "RFC-0100");
    expect(found).toBe("docs/rfcs/archive/é/rfc-0100-e.md");
  });
});

describe("CX-124 probe — a '/docs/x' binding is unjudgeable by git: refuse, never launder (HOLD)", () => {
  it("leading-slash respell of a same-target path fails closed on the unreadable git read", async () => {
    const r = makeRepo();
    seedContour(r);
    r.write(
      "docs/correctness/reviews/2026-11-13-base.yaml",
      reviewRecord(`test:${ORACLE_PATH}`, L1_ORACLE),
    );
    verifierCommit(r, "docs/correctness/reviews/2026-11-13-base.yaml");
    const base = r.git(["rev-parse", "HEAD"]);
    // The live flavor resolves path.join(root, "/docs/x") → root/docs/x — the
    // SAME file — but `git show rev:/docs/x` cannot address it: the gate must
    // fail closed on the unreadable read, not silently equalize or pass.
    r.write(
      "forge.yaml",
      r
        .read("forge.yaml")
        .replace(
          "correctnessManifest: docs/correctness.yaml",
          "correctnessManifest: /docs/correctness.yaml",
        ),
    );
    r.commit("rebind manifest to an absolute-slash respell");
    const res = await gate(r, base);
    console.log(
      "CX-124",
      JSON.stringify({ status: res.status, rules: rules(res), wk: res.weakenings }),
    );
    expect(res.status).toBe("fail");
    expect(rules(res)).toContain("CORR-GATE-01");
  });
});

describe("CX-125 probe — ls-tree pathspecs match literally: unquoted specs stay safe (HOLD)", () => {
  it("oracleReviewsDir 'docs/revie[wx]s' must not list records under docs/reviews", async () => {
    const r = makeRepo();
    seedContour(r);
    r.write("docs/reviews/2026-11-13-v.yaml", reviewRecord(`test:${ORACLE_PATH}`, L1_ORACLE));
    verifierCommit(r, "docs/reviews/2026-11-13-v.yaml");
    const head = r.git(["rev-parse", "HEAD"]);
    const repo = new GateRepo(r.root);
    // `ls-tree` pathspecs are LITERAL on git 2.53 (`docs/*`, `revie?s` match
    // only literal paths — verified in probe repos): the unquoted spec can
    // never adopt docs/reviews records. Locks in the safe behavior.
    const foreign = await readReviewRecords(repo, head, "docs/revie[wx]s");
    console.log("CX-125", JSON.stringify(foreign.map((x) => x.record)));
    expect(foreign).toEqual([]);
  });

  it("a literal bracketed dir the glob spelling cannot address is invisible to the gate", async () => {
    const r = makeRepo();
    seedContour(r);
    // The literal dir "docs/revie[wx]s" holds a properly-provenanced record —
    // literal ls-tree addressing finds it exactly (no glob reinterpretation).
    r.write("docs/revie[wx]s/2026-11-13-v.yaml", reviewRecord(`test:${ORACLE_PATH}`, L1_ORACLE));
    verifierCommit(r, "docs/revie[wx]s/2026-11-13-v.yaml");
    const head = r.git(["rev-parse", "HEAD"]);
    const repo = new GateRepo(r.root);
    const found = await readReviewRecords(repo, head, "docs/revie[wx]s");
    expect(found).not.toEqual([]);
  });
});

describe("holds: respell tolerance stays argv-exact and strip stays foreign", () => {
  it("checkRun argv change still fires a binding weakening (collapse is argv-exact, not a blind spot)", async () => {
    const r = makeRepo();
    seedContour(r);
    r.write(
      "docs/correctness/reviews/2026-11-13-base.yaml",
      reviewRecord(`test:${ORACLE_PATH}`, L1_ORACLE),
    );
    verifierCommit(r, "docs/correctness/reviews/2026-11-13-base.yaml");
    const base = r.git(["rev-parse", "HEAD"]);
    r.write(
      "forge.yaml",
      r.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "node --eval x {file}"'),
    );
    r.commit("real checkRun argv change");
    const res = await gate(r, base);
    expect(res.weakenings.filter((w) => w.kind === "binding")).not.toEqual([]);
    expect(res.status).toBe("fail");
  });

  it("a !!timestamp under bindings.commands keeps the forge.yaml diff foreign to --accept-weakening", async () => {
    const r = makeRepo();
    r.write(
      "forge.yaml",
      `schema: forge/config@1
project:
  name: gate-r19ts
paths:
  rfcsDir: docs/rfcs
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
    stampedAt: 2026-11-13
  paths:
    compassDocs: [docs/requirements.xml]
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: warn
  tier: standard
`,
    );
    r.write(
      "docs/requirements.xml",
      '<requirements>\n  <meta><document-id>requirements</document-id></meta>\n  <requirement id="REQ-01">x</requirement>\n</requirements>\n',
    );
    r.write("docs/correctness.yaml", MANIFEST_ONE);
    const base = r.commit("base with tagged timestamp under commands");
    // Session: drop the entry (real weakening) AND bump the tagged timestamp —
    // a non-frozen-key change that must keep the diff mixed. A Date reports
    // zero own-keys; pruning it as empty would launder the diff.
    r.write(
      "docs/correctness.yaml",
      "schema: forge/correctness-manifest@1\nentries: []\nsupport: []\nexemptions: []\n",
    );
    r.write("forge.yaml", r.read("forge.yaml").replace("2026-11-13", "2026-11-14"));
    r.commit("drop entry + mutate tagged timestamp");
    const res = await gate(r, base, "operator: retire the entry");
    expect(rules(res)).toContain("CORR-GATE-02");
    expect(res.violations.find((v) => /mixed-weakening/.test(v.message))?.message).toMatch(
      /forge\.yaml/,
    );
  });
});
