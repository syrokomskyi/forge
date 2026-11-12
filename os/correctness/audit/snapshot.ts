/*
<MODULE_CONTRACT>
<purpose>RFC-1579: tree snapshots the correctness auditors read — the working
tree, the staged index, or a base revision. Only audit-relevant files are
loaded (wrangler configs, migration SQL, non-test TypeScript, forge.yaml);
index and revision blobs come from one `git cat-file --batch` process
(RFC-1513 batching path, argv exec per DNA-89).</purpose>
<non-goals>
  <item>Do not check anything out — base reads never touch the working tree.</item>
  <item>Do not interpret file contents — auditors own semantics.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial snapshot sources.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
  <item>RFC-1579: gate line, ecosystem.commit early run, reference page

typescript profile integration-gate.sh runs the primary install's correctness.audit against FLOW_BASE_SHA; werkstatt ecosystem.commit gains EC-34 (correctness.audit --staged, refuses introduced CORR-AUDIT-01..03, warns on CORR-AUDIT-04); in-code CREATE TABLE tables (Durable Object storage) are unverifiable instead of D1 findings; correctness.audit declares generates: []; reference page and agent guides.

Measured on werkstatt (rollout step 3): 7 wrangler D1 configs, ~10 s per run, 3 legacy sql.schema.conform findings (packages/warpgogol-billing-cloudflare against schemas outside the repo), 127 unverifiable statements, no state machines; CORR-AUDIT-04 present (verify equals test) — fixed by the werkstatt gate-wiring queue task.</item>
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
import path from "node:path";

import { createOriginGit } from "../../rfc/verification-origin.ts";
import { listWorkspaceFiles } from "../workspace.ts";

export interface TreeSnapshot {
  /** Human label: "working-tree", "index", or the revision sha. */
  label: string;
  /** Relevant files, POSIX-relative → content. */
  files: Map<string, string>;
}

const TEST_FILE_RE =
  /(?:^|\/)(?:__tests__|tests?|__mocks__|fixtures?|test-fixtures)\/|\.(?:test|spec|pbt\.test)\.[cm]?tsx?$/;
const SKIP_SEGMENT_RE = /(?:^|\/)(?:node_modules|dist|\.turbo|\.wrangler|coverage|\.astro)\//;

export function isTestFile(rel: string): boolean {
  return TEST_FILE_RE.test(rel);
}

export function isWranglerConfig(rel: string): boolean {
  return /(?:^|\/)wrangler\.(?:json|jsonc|toml)$/.test(rel);
}

/** Whether a path can influence any auditor. */
export function isAuditRelevant(rel: string): boolean {
  if (SKIP_SEGMENT_RE.test(rel)) return false;
  if (rel === "forge.yaml") return true;
  if (isWranglerConfig(rel)) return true;
  if (rel.endsWith(".sql")) return true;
  if (/\.(?:ts|mts|tsx)$/.test(rel) && !rel.endsWith(".d.ts")) return true;
  return false;
}

/** Uppercase SQL keywords a statement literal must start with (case-sensitive prefilter). */
export const SQL_KEYWORD_PREFILTER = "\\b(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE|CREATE)\\b";
export const STATE_MACHINE_MARKER = "@state-machine[";
const SQL_KEYWORD_RE = new RegExp(SQL_KEYWORD_PREFILTER);
const TS_RE = /\.(?:ts|mts|tsx)$/;

export type SnapshotKind = { kind: "worktree" } | { kind: "index" } | { kind: "rev"; sha: string };

/** TypeScript files that need scanning: SQL keywords, a machine marker, or a writer name. */
function tsMatches(text: string, writers: string[]): boolean {
  return (
    SQL_KEYWORD_RE.test(text) ||
    text.includes(STATE_MACHINE_MARKER) ||
    writers.some((w) => text.includes(w))
  );
}

/**
 * Load the audit-relevant files of one tree. Non-TypeScript inputs (forge.yaml,
 * wrangler configs, migration SQL) are always read; TypeScript files only when
 * they can carry a statement, a machine marker, or a call of a declared writer
 * (`writersOf` returns writer names declared by the machines found so far — a
 * second pass picks up files that only call a writer).
 */
export async function loadSnapshot(
  workspaceRoot: string,
  which: SnapshotKind,
  writersOf: (files: Map<string, string>) => string[],
): Promise<TreeSnapshot | null> {
  const files = new Map<string, string>();
  if (which.kind === "worktree") {
    const rels = (await listWorkspaceFiles(workspaceRoot)).filter(isAuditRelevant);
    const ts: [string, string][] = [];
    for (const rel of rels) {
      let text: string;
      try {
        text = readFileSync(path.join(workspaceRoot, rel), "utf8");
      } catch {
        continue;
      }
      if (TS_RE.test(rel)) ts.push([rel, text]);
      else files.set(rel, text);
    }
    for (const [rel, text] of ts) if (tsMatches(text, [])) files.set(rel, text);
    const writers = writersOf(files);
    if (writers.length > 0) {
      for (const [rel, text] of ts)
        if (!files.has(rel) && tsMatches(text, writers)) files.set(rel, text);
    }
    return { label: "working-tree", files };
  }

  const git = createOriginGit(workspaceRoot);
  const treeArg = which.kind === "rev" ? which.sha : "--cached";
  const listing = await git.run(
    which.kind === "rev"
      ? ["ls-tree", "-r", "-z", "--name-only", which.sha]
      : ["ls-files", "-z", "--cached"],
  );
  if (listing === null) return null;
  const all = listing.split("\0").filter((l) => l.length > 0 && isAuditRelevant(l));
  const specOf = (rel: string) => (which.kind === "rev" ? `${which.sha}:${rel}` : `:${rel}`);
  const read = async (rels: string[]) => {
    if (rels.length === 0) return;
    const specs = rels.map(specOf);
    let contents = (await git.showMany?.(specs)) ?? null;
    if (contents === null) {
      contents = [];
      for (const spec of specs) contents.push(await git.run(["show", spec]));
    }
    rels.forEach((rel, i) => {
      const body = contents![i];
      if (typeof body === "string") files.set(rel, body);
    });
  };
  const grep = async (args: string[]): Promise<string[]> => {
    const out = await git.run([
      "grep",
      "-l",
      "-z",
      ...args,
      treeArg,
      "--",
      "*.ts",
      "*.mts",
      "*.tsx",
    ]);
    if (out === null) return []; // git grep exits 1 on no match
    const prefix = which.kind === "rev" ? `${which.sha}:` : "";
    return out
      .split("\0")
      .filter((l) => l.length > 0)
      .map((l) => (prefix && l.startsWith(prefix) ? l.slice(prefix.length) : l))
      .filter(isAuditRelevant);
  };
  await read(all.filter((rel) => !TS_RE.test(rel)));
  const first = await grep(["-E", "-e", SQL_KEYWORD_PREFILTER, "-e", "@state-machine\\["]);
  await read(first);
  const writers = writersOf(files);
  if (writers.length > 0) {
    const more = (await grep(["-F", ...writers.flatMap((w) => ["-e", w])])).filter(
      (rel) => !files.has(rel),
    );
    await read(more);
  }
  return { label: which.kind === "rev" ? which.sha : "index", files };
}

/** Resolve a revision to a full sha; null when it does not resolve. */
export async function resolveRevision(workspaceRoot: string, ref: string): Promise<string | null> {
  const out = await createOriginGit(workspaceRoot).run([
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  const sha = out?.trim() ?? "";
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** Default base: merge-base of HEAD with develop (DNA-119 fixed branch model). */
export async function defaultBase(workspaceRoot: string): Promise<string | null> {
  const out = await createOriginGit(workspaceRoot).run(["merge-base", "HEAD", "develop"]);
  const sha = out?.trim() ?? "";
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}
