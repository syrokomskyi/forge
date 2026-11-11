/*
<MODULE_CONTRACT>
<purpose>Closed dirty-path classifier for flow.integrate remediation
(RFC-1531): every uncommitted path maps to exactly one DirtyClass — the
single shared vocabulary (Q-4) consumed by the preflight's tolerated journal
surface (RFC-1537) and by the --auto-clean/--autocommit remediation flags.
Path-only classification is pure and closed-set: FORGE_STATE_FILES →
tolerated, DISPOSABLE_PATH_RULES → disposable, anything else → work. The
diff-aware shapes (importer-prune, importer-materialize, skill-twin-sync)
cannot be decided from a path — they are assigned by the preflight's
classifyDirt, which emits the same enum.</purpose>
<non-goals>
  <item>No fuzzy debris detection — the disposable set is closed by RFC-1531; growing it requires an amendment, classify the path work instead.</item>
  <item>No deletion, no commits — classification only; remediation lives in flow-integrate.ts.</item>
  <item>No diff reading — importer and skill-twin classes stay in preflight's classifyDirt; this module never reclassifies them.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1531: closed dirty-path classifier + remediation flags on flow.integrate</item>
  <item>RFC-1531: add flow.integrate remediation flags on the shared dirty classifier</item>
  <item>RFC-1543: attribute shared-checkout dirt to live ops and expose peers (RFC-1543)</item>
  <item>RFC-1544: attribute mission lockfile churn to owning checkout and auto-resolve foreign importer diffs (RFC-1544)</item>
  <item>ADR-0129: F-0186/F-0187 — FLOW-INT-03 names paths + three-way remedy, FLOW-OPEN-01 same hint, forge CLI kernel-command hint</item>
</CHANGE_SUMMARY>
*/

import { isForgeStatePath } from "./git.ts";

/**
 * The closed vocabulary (Q-4): RFC-1537's tolerated-family classes
 * (importer-prune, importer-materialize, skill-twin-sync) fold in beside the
 * remediation classes — one enum over the same facts, never two maps.
 * - `tolerated` — FORGE_STATE_FILES member; journaled, never blocks.
 * - `disposable` — declared debris; `--auto-clean` may delete it.
 * - `importer-prune` — RFC-1528 lockfile shape; assigned by classifyDirt.
 * - `foreign-open-mission` / `importer-prune-stale` — RFC-1544 referent-aware
 *   prune classes; assigned by classifyDirt when the caller injects importer
 *   referents, tolerated by the pipeline.
 * - `importer-materialize` / `skill-twin-sync` — RFC-1537 regenerable shapes;
 *   assigned by classifyDirt, tolerated by the pipeline.
 * - `work` — everything else; always blocks and is never auto-deleted.
 */
export type DirtyClass =
  | "tolerated"
  | "disposable"
  | "importer-prune"
  | "importer-materialize"
  | "foreign-open-mission"
  | "importer-prune-stale"
  | "skill-twin-sync"
  | "in-flight-foreign"
  | "work";

export interface ClassifiedDirtyEntry {
  /** status-line path (porcelain field, index 3+). */
  path: string;
  class: DirtyClass;
}

/** Fixed autocommit sweep subject (FI-1) — AC-9 probes this literal. */
export const SWEEP_COMMIT_SUBJECT = "chore(flow): sweep session leftovers";

/**
 * ADR-0129 (F-0186): the remedy for unattributed dirt in the primary checkout
 * depends on who owns the content — "commit or revert" alone is wrong for
 * foreign authored work. Shared verbatim by FLOW-INT-03 (refusal) and
 * FLOW-OPEN-01 (warning).
 */
export const FOREIGN_PRIMARY_DIRT_HINT =
  "pick the remedy by whose work it is: (1) your own work — commit it in the primary; " +
  "(2) work that belongs to a session — copy the file into that session's worktree, " +
  "then restore the primary copy with `git show HEAD:<path> > <path>`; " +
  "(3) another session's work in progress — wait for it, or ask its owner";

/**
 * Classes `--auto-clean` may pass without deleting anything: the RFC-1537
 * regenerable family (journaled, never deleted, never committed — AC-3's
 * "tolerated" arm extends to it post-Q-4). `importer-prune` deliberately
 * stays OUT: AC-4 names it a refusal class — restoring or committing a
 * lockfile is a content decision the operator makes, not a cleanup step.
 */
export const AUTO_CLEAN_PASS_CLASSES: readonly DirtyClass[] = [
  "tolerated",
  "importer-materialize",
  "skill-twin-sync",
];

/**
 * The disposable set is CLOSED — a path is disposable iff it matches exactly
 * one declared rule (RFC-1531): `*.stale` teardown-rename leftovers
 * (F-0093 shape), coverage dirs, `tmp`/`tmp-*` dirs at any depth, and
 * `*.log` files. FORGE_STATE_FILES members are conceptually disposable too
 * (RFC-1515 deletes them before worktree removal) but classify `tolerated`
 * here — they are reported through toleratedState, never swept.
 */
export const DISPOSABLE_PATH_RULES: readonly RegExp[] = [
  /\.stale$/,
  /(^|\/)\.?coverage(\/|$)/,
  /(^|\/)tmp(-[^/]*)?(\/|$)/,
  /\.log$/,
];

/**
 * Path-only classification — never reads a diff. A `pnpm-lock.yaml` or
 * `.agents/skills/` path classifies `work` here; consumers holding the diff
 * (preflight's classifyDirt) refine those paths into the importer/twin
 * classes of the same enum.
 */
export function classifyDirtyPath(path: string): DirtyClass {
  const clean = path.replace(/\/+$/, "");
  if (isForgeStatePath(clean)) return "tolerated";
  if (DISPOSABLE_PATH_RULES.some((r) => r.test(clean))) return "disposable";
  return "work";
}

/** Classify porcelain status lines (path = field 3+) — pure, no I/O. */
export function classifyDirtyTree(entries: string[]): ClassifiedDirtyEntry[] {
  return entries.map((line) => {
    const path = line.slice(3).trim();
    return { path, class: classifyDirtyPath(path) };
  });
}

/** `data.classes` shape — counts per present class, for FLOW-INT-01 data. */
export function summarizeClasses(
  entries: ClassifiedDirtyEntry[],
): Partial<Record<DirtyClass, number>> {
  const counts: Partial<Record<DirtyClass, number>> = {};
  for (const e of entries) {
    counts[e.class] = (counts[e.class] ?? 0) + 1;
  }
  return counts;
}
