/*
<MODULE_CONTRACT>
<purpose>Local branch registry and event journal for the session lifecycle
(RFC-1487). The registry lives at &lt;common-gitdir&gt;/forge/registry.yaml —
the same file from every worktree — and records every live auto branch with
its owner, base sha, worktree, opened/updated times and the reserved held
field. The journal appends one JSON line per lifecycle event to
forge/journal.jsonl.</purpose>
<non-goals>
  <item>No lifecycle policy — handlers decide when entries open, update or close.</item>
  <item>No commits — the registry lives under the common git dir, never in a tree.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>A schema-invalid registry throws FlowRegistrySchemaError — every flow command surfaces it as FLOW-07 naming the file; a damaged registry is never silently rewritten.</item>
  <item>Registry updates hold a 10 s O_EXCL lock and write via temp file + rename — parallel sessions never observe a torn file (AC-8).</item>
  <item>`held` is typed null now — the wave-2 outbound RFC widens it to { heldAt, riskCategory, reason }.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 1 — worktree path contracts, O_EXCL locks, branch registry and journal</item>
  <item>RFC-1490: step 2 — registry fix/port widening, FORGE_FLOW_COMMIT gitCommit helper, verified version-files writes</item>
  <item>RFC-1491: step 1 — journal base/rewrites + held registry widening, W1-1 discard tip, FLOW-INT-11</item>
  <item>RFC-1491: step 3 — flow.digest risk digest with journal-attributed items, categories, digestId</item>
  <item>RFC-1503: steps 1-5 — highest-per-line pending selection, publish-superseded/publish-retired journal events, flow.publication.retire</item>
  <history>RFC-1487</history>
</CHANGE_SUMMARY>
*/

import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalRepoDir } from "../../src/utils/repo-path.ts";

import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { z } from "zod";

import type { WorkspaceIO } from "../../src/types.ts";

import { git } from "./git.ts";
import { withFlowLock } from "./locks.ts";

export const STALE_AFTER_HOURS = 72;
export const REGISTRY_RELATIVE_PATH = "forge/registry.yaml";
export const REGISTRY_LOCK_RELATIVE_PATH = "forge/registry.lock";
export const INTEGRATE_LOCK_RELATIVE_PATH = "forge/integrate.lock";
export const JOURNAL_RELATIVE_PATH = "forge/journal.jsonl";

export const REGISTRY_LOCK_WAIT_MS = 10_000;
export const REGISTRY_LOCK_STALE_MS = 60_000;

/** Fixed risk categories for digest items and held entries (RFC-1491). */
export const RISK_CATEGORIES = [
  "contract",
  "migration",
  "invariant",
  "capability-removal",
  "major-dependency",
  "other",
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const flowRegistryEntrySchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["task", "session", "fix"]),
    base: z.enum(["develop", "main"]),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    worktree: z.string().min(1).nullable(),
    owner: z
      .object({
        kind: z.enum(["session", "task"]),
        id: z.string().min(1),
      })
      .strict(),
    brief: z.string().nullable(),
    openedAt: z.string().min(1),
    updatedAt: z.string().min(1),
    held: z
      .object({
        heldAt: z.string().min(1),
        riskCategory: z.enum(RISK_CATEGORIES),
        reason: z.string().min(1),
        tip: z.string().regex(/^[0-9a-f]{40}$/),
      })
      .strict()
      .nullable(),
    port: z
      .object({
        mainSha: z.string().regex(/^[0-9a-f]{40}$/),
        tags: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
  .refine((e) => (e.base === "main") === (e.kind === "fix"), {
    message: "base 'main' ⇔ kind 'fix' — task/session branches always base on develop (RFC-1490)",
  })
  .refine((e) => (e.worktree === null) === (e.held !== null), {
    message: "worktree null ⇔ held — a held branch keeps no worktree, an unheld one always has one (RFC-1491)",
  });

export const flowRegistrySchema = z
  .object({
    schema: z.literal("forge/flow-registry@1"),
    branches: z.array(flowRegistryEntrySchema),
  })
  .strict();

export type FlowRegistryEntry = z.infer<typeof flowRegistryEntrySchema>;
export type FlowRegistryV1 = z.infer<typeof flowRegistrySchema>;

export class FlowRegistrySchemaError extends Error {
  readonly file: string;
  readonly detail: string;
  constructor(file: string, detail: string) {
    super(`registry ${file} fails the forge/flow-registry@1 schema: ${detail}`);
    this.name = "FlowRegistrySchemaError";
    this.file = file;
    this.detail = detail;
  }
}

export interface FlowJournalEvent {
  at: string;
  event:
    | "open"
    | "integrate"
    | "discard"
    | "cut"
    | "fix"
    | "backmerge"
    | "hold"
    | "unhold"
    | "push"
    | "publish"
    | "publish-superseded"
    | "publish-retired";
  branch: string;
  sha: string;
  detail: string;
  /** develop before (integrate/backmerge/cut/hold); branch base (discard) — W1-1. */
  base?: string;
  /** hold only — the new (base, sha] range of every replayed item. */
  rewrites?: Array<{
    branch: string;
    kind: "integration" | "backmerge" | "release";
    base: string;
    sha: string;
  }>;
}

export function emptyRegistry(): FlowRegistryV1 {
  return { schema: "forge/flow-registry@1", branches: [] };
}

export function registryPath(commonGitDir: string): string {
  return join(commonGitDir, REGISTRY_RELATIVE_PATH);
}

/**
 * Absolute path of the repository's common git dir — shared across all
 * worktrees. `git rev-parse --git-common-dir` may answer relative to cwd.
 */
export async function commonGitDir(io: WorkspaceIO, cwd: string): Promise<string> {
  const result = await git(cwd, io, ["rev-parse", "--git-common-dir"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `git rev-parse --git-common-dir failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  const dir = result.stdout.trim();
  // Canonicalize — a linked worktree's --git-common-dir answer (absolute,
  // git's frame) and a primary's relative `.git` must compare equal when
  // they name the same directory, including across Windows 8.3 aliases.
  return canonicalRepoDir(isAbsolute(dir) ? dir : resolve(cwd, dir));
}

/** Read the registry; a missing file yields the empty registry. */
export async function readRegistry(
  io: WorkspaceIO,
  commonGitDir: string,
): Promise<FlowRegistryV1> {
  const file = registryPath(commonGitDir);
  if (!(await io.exists(file))) return emptyRegistry();
  let raw: unknown;
  try {
    raw = yamlParse(await io.readFile(file));
  } catch (error) {
    throw new FlowRegistrySchemaError(
      file,
      `unparseable YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = flowRegistrySchema.safeParse(raw);
  if (!parsed.success) {
    throw new FlowRegistrySchemaError(
      file,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    );
  }
  return parsed.data;
}

/**
 * Read-mutate-write under the registry lock (10 s wait, 60 s stale).
 * Branches are stored sorted by name; the write is temp file + rename so a
 * reader never sees a torn document.
 */
export async function updateRegistry(
  io: WorkspaceIO,
  commonGitDir: string,
  mutate: (r: FlowRegistryV1) => FlowRegistryV1,
): Promise<FlowRegistryV1> {
  const lockPath = join(commonGitDir, REGISTRY_LOCK_RELATIVE_PATH);
  await io.mkdir(join(commonGitDir, "forge"));
  return withFlowLock(
    lockPath,
    { waitMs: REGISTRY_LOCK_WAIT_MS, staleMs: REGISTRY_LOCK_STALE_MS },
    async () => {
      const current = await readRegistry(io, commonGitDir);
      const next = mutate(current);
      next.branches = [...next.branches].sort((a, b) => a.name.localeCompare(b.name));
      const file = registryPath(commonGitDir);
      const tmp = `${file}.tmp-${process.pid}`;
      await io.writeFile(tmp, yamlStringify(next));
      await io.rename(tmp, file);
      return next;
    },
    io,
  );
}

/** Append one journal line — best-effort bookkeeping, append-only. */
export async function appendJournal(
  io: WorkspaceIO,
  commonGitDir: string,
  event: Omit<FlowJournalEvent, "at"> & { at?: string },
): Promise<void> {
  const file = join(commonGitDir, JOURNAL_RELATIVE_PATH);
  await io.mkdir(dirname(file));
  const line: FlowJournalEvent = {
    at: event.at ?? new Date().toISOString(),
    event: event.event,
    branch: event.branch,
    sha: event.sha,
    detail: event.detail,
  };
  if (event.base !== undefined) line.base = event.base;
  if (event.rewrites !== undefined) line.rewrites = event.rewrites;
  await io.appendFile(file, `${JSON.stringify(line)}\n`);
}

/** Read every journal line in append order; a missing file yields []. */
export async function readJournal(
  io: WorkspaceIO,
  commonGitDir: string,
): Promise<FlowJournalEvent[]> {
  const file = join(commonGitDir, JOURNAL_RELATIVE_PATH);
  if (!(await io.exists(file))) return [];
  const events: FlowJournalEvent[] = [];
  for (const line of (await io.readFile(file)).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as FlowJournalEvent);
    } catch {
      // A torn append is skipped — the journal is bookkeeping, never a gate.
    }
  }
  return events;
}
