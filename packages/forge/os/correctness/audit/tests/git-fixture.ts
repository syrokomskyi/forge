/*
<MODULE_CONTRACT>
<purpose>RFC-1579: temp git repositories for correctness.audit tests — a D1
consumer shape (apps/api/wrangler.jsonc + migrations + src), a base commit,
and helpers to edit the working tree or the index afterwards.</purpose>
<non-goals>
  <item>Not production code — imported by *.test.ts only.</item>
  <item>Never exports GIT_DIR — every git call passes cwd explicitly.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial fixture.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
</CHANGE_SUMMARY>
*/
// test-adjacency: exempt — no test reason: test support module, exercised by every audit test

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const WRANGLER = `{
  // D1 consumer
  "name": "api",
  "d1_databases": [
    { "binding": "DB", "database_name": "steward", "database_id": "x", "migrations_dir": "migrations", },
  ],
}
`;

export const MIGRATION = `CREATE TABLE openers (id TEXT PRIMARY KEY, target TEXT NOT NULL, sent_at TEXT);
CREATE TABLE candidates (id TEXT PRIMARY KEY, state TEXT NOT NULL);
`;

export const FORGE_YAML = `schema: forge/config@1
project:
  name: fixture
bindings:
  schema: forge/bindings@1
  commands:
    test: pnpm test
    verify: pnpm exec tsx scripts/verify-dispatch.ts
  paths: {}
`;

/** Code that reads and writes both tables, so ledger.orphans stays quiet. */
export const BASE_CODE = `export async function dispatch(db: D1) {
  await db.prepare("INSERT INTO openers (id, target) VALUES (?, ?)").bind("a", "b").run();
  await db.prepare("SELECT id, target FROM openers WHERE target = ?").bind("b").all();
  await db.prepare("UPDATE candidates SET state = ? WHERE id = ?").bind("queued", "c").run();
  return db.prepare("SELECT id, state FROM candidates").all();
}
`;

export interface GitFixture {
  root: string;
  base: string;
  write(rel: string, body: string): void;
  git(args: string[]): string;
  commit(message: string): string;
  cleanup(): void;
}

export function makeGitFixture(files: Record<string, string> = {}): GitFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "forge-audit-"));
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
  const defaults: Record<string, string> = {
    "forge.yaml": FORGE_YAML,
    "apps/api/wrangler.jsonc": WRANGLER,
    "apps/api/migrations/0001_init.sql": MIGRATION,
    "apps/api/src/dispatch.ts": BASE_CODE,
  };
  for (const [rel, body] of Object.entries({ ...defaults, ...files })) write(rel, body);
  const base = commit("base");
  return {
    root,
    base,
    write,
    git,
    commit,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
