/*
RFC-1615 round-18 adversarial verification — counterexample probes CX-116+.
Test-only file: never touches gate source. Fixture model copied from
tests/gate-fixture.ts so probes can control commit ordering (base-anchored
reads need real history).
*/

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessGate } from "./run.ts";
import { rfcPath } from "./origin.ts";
import { GateRepo } from "./repo.ts";

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
  git(args: string[], msg?: string): string;
  commit(message: string): string;
  cleanup(): void;
}

const repos: Repo[] = [];
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()));

function makeRepo(): Repo {
  const root = mkdtempSync(path.join(os.tmpdir(), "forge-gate-r18-"));
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

function forgeYaml(opts: { mode?: string; extra?: string } = {}): string {
  return `schema: forge/config@1
project:
  name: gate-r18
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
  paths:
    compassDocs: [docs/requirements.xml]
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: ${opts.mode ?? "enforce"}
  tier: standard
${opts.extra ?? ""}`;
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
exemptions: []
`;

function seedContour(r: Repo): void {
  r.write("forge.yaml", forgeYaml());
  r.write(
    "docs/requirements.xml",
    '<requirements>\n  <meta><document-id>requirements</document-id></meta>\n  <requirement id="REQ-01">x</requirement>\n</requirements>\n',
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

describe("CX-116: rfcPath archive order — nested subtree must not beat a direct child", () => {
  it("rfcPath returns the direct archive child (worktree findRfcFile parity)", async () => {
    const r = makeRepo();
    seedContour(r);
    r.write("docs/rfcs/archive/2020/rfc-0100-a.md", RFC("RFC-0100", "accepted", ["AC-1"]));
    r.write("docs/rfcs/archive/rfc-0100-b.md", RFC("RFC-0100", "accepted", ["AC-2"]));
    const head = r.commit("two same-id rfc files under archive");
    const repo = new GateRepo(r.root);
    // findRfcFile (references.ts) iterates a directory's sorted names and
    // returns a direct matching file before descending into pushed subdirs —
    // the direct child archive/rfc-0100-b.md wins there. The gate's ls-tree
    // preorder lists the 2020/ subtree first instead.
    const found = await rfcPath(repo, head, "docs/rfcs", "RFC-0100");
    expect(found).toBe("docs/rfcs/archive/rfc-0100-b.md");
  });

  it("a ref only the direct child declares must resolve (gate currently refuses it)", async () => {
    const r = makeRepo();
    seedContour(r);
    r.write("docs/rfcs/archive/2020/rfc-0100-a.md", RFC("RFC-0100", "accepted", ["AC-1"]));
    r.write("docs/rfcs/archive/rfc-0100-b.md", RFC("RFC-0100", "accepted", ["AC-2"]));
    r.write("test/old.ts", L1_ORACLE);
    const base = r.commit("base with rfc files and old oracle");
    // Session adds an rfc-ac entry referencing AC-2 — declared only in the
    // direct archive child (the file the worktree resolver picks).
    r.write(
      "docs/correctness.yaml",
      MANIFEST_ONE.replace(
        "support:",
        `  - id: CM-rfc-01
    source: rfc-ac
    ref: RFC-0100/AC-2
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
    r.write(
      "docs/correctness/reviews/2026-11-13-base.yaml",
      reviewRecord(`test:${ORACLE_PATH}`, L1_ORACLE),
    );
    verifierCommit(r, "docs/correctness/reviews/2026-11-13-base.yaml");
    r.commit("add rfc-ac entry");
    const res = await gate(r, base);
    const corr03 = res.violations.find((v) => /CORR-03/.test(v.message));
    expect(corr03?.message ?? "").not.toMatch(/declares no AC-2/);
  });
});

describe("CX-117: resolveImplementationRange — glob chars in the resolved rfc path borrow sibling acceptance", () => {
  it("a never-accepted rfc file must not inherit acceptance provenance from a glob-matched sibling", async () => {
    const r = makeRepo();
    seedContour(r);
    // The file rfcPath resolves for RFC-0300 (literal `*` in the name, sorts
    // first). It stays `draft` forever — no acceptance transition exists.
    r.write("docs/rfcs/rfc-0300-a*.md", RFC("RFC-0300", "draft", ["AC-1"]));
    // A same-prefix sibling the glob `rfc-0300-a*.md` also matches — it gets a
    // real governed acceptance commit BEFORE the base.
    r.write("docs/rfcs/rfc-0300-accepted.md", RFC("RFC-0300", "draft", ["AC-9"]));
    // The oracle file: byte-identical at the sibling's acceptance commit and HEAD.
    r.write("test/old.ts", L1_ORACLE);
    r.commit("seed rfc files and old oracle");
    r.write("docs/rfcs/rfc-0300-accepted.md", RFC("RFC-0300", "accepted", ["AC-9"]));
    r.git(["add", "-A"]);
    r.git(["commit", "-qm", "accept sibling\n\nX-RFC: RFC-0300"]);
    r.write("noise.txt", "x");
    const base = r.commit("unrelated");
    // Session adds an rfc-ac entry bound to the DRAFT file's AC-1.
    r.write(
      "docs/correctness.yaml",
      MANIFEST_ONE.replace(
        "support:",
        `  - id: CM-rfc-01
    source: rfc-ac
    ref: RFC-0300/AC-1
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
    r.write(
      "docs/correctness/reviews/2026-11-13-base.yaml",
      reviewRecord(`test:${ORACLE_PATH}`, L1_ORACLE),
    );
    verifierCommit(r, "docs/correctness/reviews/2026-11-13-base.yaml");
    r.commit("add rfc-ac entry whose rfc was never accepted");
    const res = await gate(r, base);
    // With a literal pathspec the -G log over the RESOLVED file finds no
    // status: accepted transition — range.base is null, the oracle is self and
    // CORR-GATE-03 fires. The glob borrows the sibling's acceptance instead.
    expect(rules(res)).toContain("CORR-GATE-03");
  });
});

describe("CX-118: binding compares use raw strings — same-target respellings fabricate weakenings", () => {
  it("`./`-prefixed correctnessManifest resolves identically — must not report a binding change", async () => {
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
          "correctnessManifest: ./docs/correctness.yaml",
        ),
    );
    r.commit("respell manifest binding");
    const res = await gate(r, base);
    expect(
      res.violations.filter((v) => /correctnessManifest/.test(v.message)).map((v) => v.message),
    ).toEqual([]);
  });

  it("checkRun whitespace-only respell produces the same argv — must not report a binding change", async () => {
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
      r.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "node  {file}"'),
    );
    r.commit("respell checkRun");
    const res = await gate(r, base);
    expect(res.violations.filter((v) => /checkRun/.test(v.message)).map((v) => v.message)).toEqual(
      [],
    );
  });
});

describe("CX-119: pruneEmpties treats tagged containers (Set/Map/Date) as empty — mixed diffs launder under --accept-weakening", () => {
  it("a !!set commands diff inside forge.yaml must still count as foreign", async () => {
    const r = makeRepo();
    // warn mode: the tagged commands value is schema-invalid (CORR-01 warning
    // only) and checkRun unbound is not an enforce error.
    r.write(
      "forge.yaml",
      `schema: forge/config@1
project:
  name: gate-cx119
paths: {}
bindings:
  schema: forge/bindings@1
  commands: !!set
    runA:
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
    const base = r.commit("base with tagged commands container");
    // Session: drop the entry (real weakening) AND change the tagged set's
    // members — a non-frozen-key forge.yaml change that must make the diff
    // mixed. empty() prunes the Set as if it were {}: the diff vanishes.
    r.write(
      "docs/correctness.yaml",
      "schema: forge/correctness-manifest@1\nentries: []\nsupport: []\nexemptions: []\n",
    );
    r.write("forge.yaml", r.read("forge.yaml").replace("    runA:", "    runB:"));
    r.commit("drop entry + mutate tagged commands");
    const res = await gate(r, base, "operator: retire the entry");
    expect(rules(res)).toContain("CORR-GATE-02");
    expect(res.violations.find((v) => /mixed-weakening/.test(v.message))?.message).toMatch(
      /forge\.yaml/,
    );
  });
});
