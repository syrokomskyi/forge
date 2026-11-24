/*
<MODULE_CONTRACT>
<purpose>RFC-1633: per-commonGitDir serialization of judged evidence
consults. `.git/forge/evidence-consult.lock` rides the locks.ts machinery
(withFlowLock — pid+bootId liveness, RFC-1504 dead/stale classification);
bounded wait surfaces EVIDENCE-LOCKED naming the holder. The lock wraps ONE
gitEvidenceAttempt — a flux ride-out retry re-acquires so a retrying holder
never starves waiters. Internal enumeration reads (preflight:false) skip
it — they already run inside the holder's serialized window.</purpose>
<non-goals>
  <item>No cross-host coordination — same machine-local trust model as integrate.lock.</item>
  <item>No commonGitDir consult — resolution is pure fs (.git gitfile + commondir); the registry's commonGitDir(io) helper rides gitEvidence and would recurse through the lock itself.</item>
  <item>No preflight/watch/settle work — the consult body owns judgment; this module owns scheduling only.</item>
</non-goals>
<KEY_DECISIONS>
  <item>Per-attempt scope, not per-call: the flux ride-out releases the lock between retries (RFC-1633 enhance — convoy fairness).</item>
  <item>Reentrancy via AsyncLocalStorage: a consult invoked INSIDE a held consult's fn inherits the consult context and skips re-locking; a concurrent consult has its own context and waits — same-process serialization is preserved (AC-1).</item>
  <item>Unresolvable commonGitDir skips the lock — a repo whose .git cannot even be read fails closed in preflight on its own merits.</item>
  <item>Journal events append on break/refusal only (bounded cardinality) — acquire/release would spam journal.jsonl, whose event union is closed.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1633: initial — evidence-consult serialization + env-declared wait/budget defaults</item>
  <item>RFC-1633: serialize evidence consults + bestEffort reader mode (RFC-1633)</item>
</CHANGE_SUMMARY>
*/

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { withFlowLock } from "./locks.ts";
import type { LockTimeoutError } from "./locks.ts";

/** Lock artifact under the repo's common gitdir — shared across worktrees,
 * which is exactly what serialization needs (parallel sessions consult the
 * same .git). */
export const EVIDENCE_CONSULT_LOCK_RELATIVE_PATH = "forge/evidence-consult.lock";

export const EVIDENCE_LOCKED_PREFIX = "EVIDENCE-LOCKED";
export const EVIDENCE_BUDGET_PREFIX = "EVIDENCE-BUDGET";
export const EVIDENCE_MODE_PREFIX = "EVIDENCE-MODE";

/** Declared defaults — generous on purpose; tunable via envInputs declared
 * on flow.integrate / flow.push / flow.digest (flow.module.ts). */
export const DEFAULT_EVIDENCE_LOCK_WAIT_MS = 120_000;
export const DEFAULT_EVIDENCE_LOCK_STALE_MS = 600_000;
export const DEFAULT_EVIDENCE_CONSULT_BUDGET_MS = 300_000;

function envMs(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function evidenceLockWaitMs(opt?: number): number {
  return opt ?? envMs("FORGE_EVIDENCE_LOCK_WAIT_MS", DEFAULT_EVIDENCE_LOCK_WAIT_MS);
}

export function evidenceConsultBudgetMs(opt?: number): number {
  return opt ?? envMs("FORGE_EVIDENCE_CONSULT_BUDGET_MS", DEFAULT_EVIDENCE_CONSULT_BUDGET_MS);
}

/**
 * Resolve the common gitdir without a consult — `registry.ts`'s
 * `commonGitDir(io)` helper rides `gitEvidence` itself and would recurse
 * through this lock. Pure fs: `.git` gitfile → gitdir, `commondir` → common.
 * `null` when the surface cannot be read — the consult then fails closed
 * in preflight on its own merits.
 */
export function resolveEvidenceCommonGitDir(repoRoot: string): string | null {
  try {
    const dotGit = join(repoRoot, ".git");
    let gitdir: string;
    if (statSync(dotGit).isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (match === null) return null;
      const target = match[1]!.trim();
      gitdir = isAbsolute(target) ? target : resolve(repoRoot, target);
    } else {
      gitdir = dotGit;
    }
    const commonFile = join(gitdir, "commondir");
    if (existsSync(commonFile)) {
      const rel = readFileSync(commonFile, "utf8").trim();
      if (rel.length > 0) return isAbsolute(rel) ? rel : resolve(gitdir, rel);
    }
    return gitdir;
  } catch {
    return null;
  }
}

/** AsyncLocalStorage reentrancy marker: a consult invoked INSIDE a held
 * consult's fn inherits this context and skips re-locking (self-deadlock
 * otherwise); a concurrent consult has its own context and queues normally
 * — intra-process consults serialize exactly like cross-process ones. */
const consultContext = new AsyncLocalStorage<boolean>();

/**
 * Bounded-cheap journal bookkeeping: only lock breaks and wait refusals
 * append (acquire/release would flood the closed journal vocabulary —
 * "consult-lock" covers both arms via `rule`). Best-effort — a repo whose
 * `.git/forge/` does not exist yet simply carries no line.
 */
async function appendConsultLockJournal(commonGitDir: string, detail: string): Promise<void> {
  try {
    const file = join(commonGitDir, "forge/journal.jsonl");
    if (!existsSync(file)) return;
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      event: "consult-lock",
      branch: "",
      sha: "",
      detail,
    })}\n`;
    const handle = await open(file, "a");
    try {
      await handle.writeFile(line);
    } finally {
      await handle.close();
    }
  } catch {
    // Journal bookkeeping never gates the consult.
  }
}

/**
 * Serialize one judged consult attempt against every other consult on the
 * same commonGitDir. `LockTimeoutError` propagates — the caller maps it to
 * the EVIDENCE-LOCKED refusal; `describeEvidenceLockError` renders it.
 */
export async function withEvidenceConsultLock<T>(
  repoRoot: string,
  opts: {
    waitMs?: number;
    command?: string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const common = resolveEvidenceCommonGitDir(repoRoot);
  if (common === null) return fn();
  const lockPath = join(common, EVIDENCE_CONSULT_LOCK_RELATIVE_PATH);
  if (consultContext.getStore() === true) return fn();
  await mkdir(join(common, "forge"), { recursive: true });
  return await withFlowLock(
    lockPath,
    {
      waitMs: evidenceLockWaitMs(opts.waitMs),
      staleMs: DEFAULT_EVIDENCE_LOCK_STALE_MS,
      extraContent: opts.command !== undefined ? { command: opts.command } : undefined,
      onStale: (lock) => {
        void appendConsultLockJournal(
          common,
          `evidence-consult lock broken (${lock.reason}, pid ${lock.pid ?? "unknown"}, age ${lock.ageMs}ms)`,
        );
      },
      now: opts.now,
      sleep: opts.sleep,
    },
    () => consultContext.run(true, fn),
    { readFile: async (p) => readFile(p, "utf8") },
  );
}

/** Render a LockTimeoutError from withEvidenceConsultLock into the
 * EVIDENCE-LOCKED refusal stderr — names the holder when one was observed. */
export async function describeEvidenceLockError(
  repoRoot: string,
  error: LockTimeoutError,
): Promise<string> {
  const holder =
    error.holder !== undefined
      ? `holder pid ${error.holder.pid}${error.holder.host !== undefined ? ` on ${error.holder.host}` : ""} since ${error.holder.at}`
      : "holder unknown";
  const common = resolveEvidenceCommonGitDir(repoRoot);
  if (common !== null) {
    void appendConsultLockJournal(
      common,
      `EVIDENCE-LOCKED refusal — ${holder} (lock ${error.lockPath})`,
    );
  }
  return `${EVIDENCE_LOCKED_PREFIX}: judged evidence consult waited past the lock budget — ${holder} (lock ${error.lockPath})`;
}
