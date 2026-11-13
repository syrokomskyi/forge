/*
<MODULE_CONTRACT>
<purpose>RFC-1580: temp git repositories for correctness.gate tests — a D1
product with a manifest, a code anchor, real node oracles (checkRun
`node {file}`) that attest through the forge test-side helpers, and an
optional committed oracle review record.</purpose>
<non-goals>
  <item>Not production code — imported by *.test.ts only.</item>
  <item>Never exports GIT_DIR — every git call passes cwd explicitly.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: initial fixture.</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
</CHANGE_SUMMARY>
*/
// test-adjacency: exempt — no test reason: test support module, exercised by every gate test

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the forge test-side helpers, importable by node oracles (type stripping). */
export const HELPERS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../src/correctness/index.ts",
);

const MARK = "@ai-" + "invariant";

export const MIGRATION = "CREATE TABLE candidates (id TEXT PRIMARY KEY, state TEXT NOT NULL);\n";

/** An oracle body: builds the real schema on node:sqlite and attests it. */
export const L1_ORACLE = `import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { attestSubstrate } from ${JSON.stringify(HELPERS)};
const db = new DatabaseSync(":memory:");
db.exec(readFileSync("apps/api/migrations/0001_init.sql", "utf8"));
attestSubstrate(db, { level: "L1", engine: "node:sqlite" });
`;

/** Attests a schemaless double — must not count as L1. */
export const MOCK_ORACLE = `import { DatabaseSync } from "node:sqlite";
import { attestSubstrate } from ${JSON.stringify(HELPERS)};
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE anything (x)");
attestSubstrate(db, { level: "L1", engine: "mock" });
`;

/** L2 lifecycle oracle: writes a row, then verifies the production log line's claim. */
export const lifecycleOracle = (claimed: string) => `import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { attestSubstrate, verifyAnchorEvents } from ${JSON.stringify(HELPERS)};
const db = new DatabaseSync(":memory:");
db.exec(readFileSync("apps/api/migrations/0001_init.sql", "utf8"));
db.prepare("INSERT INTO candidates (id, state) VALUES (?, ?)").run("c_1", "queued");
attestSubstrate(db, { level: "L2", engine: "node:sqlite" });
const line = JSON.stringify({ "forge.anchor": "INV-dispatch-01", ref: { table: "candidates", key: { id: "c_1" }, column: "state", value: ${JSON.stringify(claimed)} } });
verifyAnchorEvents([line], db);
`;

export interface GateFixtureOptions {
  mode?: "warn" | "enforce";
  tier?: "standard" | "high";
  seam?: "data" | "lifecycle";
  substrate?: "L1" | "L2";
  oracle?: string;
  review?: boolean;
}

export interface GateFixture {
  root: string;
  base: string;
  write(rel: string, body: string): void;
  read(rel: string): string;
  git(args: string[]): string;
  commit(message: string): string;
  cleanup(): void;
}

export const ORACLE_PATH = "test/dispatch.oracle.ts";

export function manifestYaml(opts: GateFixtureOptions, extraEntries = ""): string {
  return `schema: forge/correctness-manifest@1
entries:
  - id: CM-dispatch-01
    source: req
    ref: REQ-01
    seam: ${opts.seam ?? "data"}
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:${ORACLE_PATH}
        substrate: ${opts.substrate ?? "L1"}
${extraEntries}support: []
exemptions: []
`;
}

export function reviewYaml(entries: { check: string; content: string }[]): string {
  return `schema: forge/oracle-review@1
reviewedAt: 2026-11-13T10:00:00Z
isolation: subagent
candidate: deadbeef
export: "rfc.verify.workspace --manifest"
verdict: pass
oracles:
${entries
  .map(
    (e) =>
      `  - check: ${e.check}\n    sha256: "${createHash("sha256").update(e.content).digest("hex")}"\n    verdict: pass\n    attestedHandleIsUnderTest: true`,
  )
  .join("\n")}
`;
}

export function makeGateFixture(opts: GateFixtureOptions = {}): GateFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "forge-gate-"));
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
  const oracle = opts.oracle ?? L1_ORACLE;
  write(
    "forge.yaml",
    `schema: forge/config@1
project:
  name: gate-fixture
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
    verify: "node scripts/verify.mjs"
  paths:
    compassDocs: [docs/requirements.xml]
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: ${opts.mode ?? "enforce"}
  tier: ${opts.tier ?? "standard"}
`,
  );
  write(
    "docs/requirements.xml",
    '<requirements>\n  <meta><document-id>requirements</document-id></meta>\n  <requirement id="REQ-01">Never two openers</requirement>\n</requirements>\n',
  );
  write(
    "apps/api/wrangler.jsonc",
    '{ "d1_databases": [{ "binding": "DB", "database_name": "main", "database_id": "x" }] }\n',
  );
  write("apps/api/migrations/0001_init.sql", MIGRATION);
  write(
    "apps/api/src/dispatch.ts",
    `export function dispatch(): void {\n  // ${MARK}[INV-dispatch-01]: dispatch moves an approved candidate to queued exactly once\n  //   (checked-by: test:${ORACLE_PATH})\n}\n`,
  );
  write(ORACLE_PATH, oracle);
  write("docs/correctness.yaml", manifestYaml(opts));
  if (opts.review !== false) {
    write(
      "docs/correctness/reviews/2026-11-13-base.yaml",
      reviewYaml([{ check: `test:${ORACLE_PATH}`, content: oracle }]),
    );
  }
  const base = commit("base");
  return {
    root,
    base,
    write,
    read: (rel) => readFileSync(path.join(root, rel), "utf8"),
    git,
    commit,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
