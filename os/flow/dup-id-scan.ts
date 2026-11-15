/*
<MODULE_CONTRACT>
<purpose>RFC-1600 AC-3 (F-0260): scan a branch's diff against develop for
duplicate governance ids — file families under docs/rfcs, docs/adrs,
docs/frictions (rfc-NNNN/adr-NNNN/F-NNNN) and rule literals (V-*,
RFC-IMP-*, FLOW-*-*) added by the branch while already present on develop —
producing the FLOW-INT-19 violation list before the heavyweight gate arms
spawn.</purpose>
<non-goals>
  <item>Never auto-renumbers — this scanner produces refusal data only;
  renumbering is a manual, per-family next-id operation.</item>
  <item>Does not judge uncommitted worktree dirt — that is FLOW-INT-01.</item>
  <item>Does not reserve ids — allocation lives in os/rfc/next-id.ts; this
  is the integrate-time backstop for allocations that raced it.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { git } from "./git.ts";
import type { WorkspaceIO } from "@warpgogol/werkstatt-shared/kernel/workspace-io";

export interface DupIdViolation {
  /** The duplicated governance id, e.g. RFC-1600, ADR-0132, F-0300, FLOW-INT-25. */
  id: string;
  /** Where the branch introduced it (path, or `path (added literal)`). */
  onBranch: string;
  /** Where develop already carries it (path). */
  onDevelop: string;
}

export interface DupIdScanResult {
  fileIds: DupIdViolation[];
  ruleIds: DupIdViolation[];
  /** True when every side read succeeded; a partial scan reports what it found. */
  complete: boolean;
}

const GOVERNANCE_DIRS = ["docs/rfcs", "docs/adrs", "docs/frictions"];

/** Canonical id for a governance path — `rfc-1600-x.md` → `RFC-1600`. */
function fileId(relPath: string): string | null {
  const base = relPath.split("/").pop() ?? "";
  const m = /^(rfc|adr)-(\d{4})-/.exec(base) ?? /^F-(\d{4})[.-]/.exec(base);
  if (!m) return null;
  if (m[1] === "rfc" || m[1] === "adr") return `${m[1].toUpperCase()}-${m[2]}`;
  return `F-${m[3]}`;
}

/** Rule literals a branch diff may add — matches the RFC-1600 taxonomy. */
const RULE_LITERAL = /\b(V-\d+|RFC-IMP-\d+|FLOW-(?:INT|CUT|OPEN|GUARD)-\d+)\b/g;

/**
 * Compare `base...head` inside `repo`: the branch's unique commits (three-dot
 * merge-base diff — rebase-replayed content counts once, and a same-id file
 * already on develop at ANY path collides only when the branch did not also
 * delete that develop path, i.e. an honest rename/move).
 */
export async function scanDuplicateGovernanceIds(
  repo: string,
  io: WorkspaceIO,
  base: string,
  head: string,
): Promise<DupIdScanResult> {
  const violations: DupIdScanResult = { fileIds: [], ruleIds: [], complete: true };
  const range = `${base}...${head}`;

  // -- file families -------------------------------------------------------
  const nameStatus = await git(repo, io, [
    "diff",
    "--name-status",
    range,
    "--",
    ...GOVERNANCE_DIRS,
  ]);
  const developTree = await git(repo, io, [
    "ls-tree",
    "--name-only",
    "-r",
    base,
    "--",
    ...GOVERNANCE_DIRS,
  ]);
  if (nameStatus.exitCode !== 0 || developTree.exitCode !== 0) {
    violations.complete = false;
  } else {
    // id → path on develop.
    const developIds = new Map<string, string>();
    for (const line of developTree.stdout.split("\n")) {
      const rel = line.trim();
      if (!rel) continue;
      const id = fileId(rel);
      if (id) developIds.set(id, rel);
    }
    const branchDeleted = new Set<string>();
    const branchAdds: { id: string; path: string }[] = [];
    for (const line of nameStatus.stdout.split("\n")) {
      const [status, ...paths] = line.split("\t");
      if (!status || paths.length === 0) continue;
      if (status === "D") {
        branchDeleted.add(paths[0]!);
        continue;
      }
      // A/M/R: the new side is the last path on the line.
      const newPath = status.startsWith("R") ? paths[paths.length - 1]! : paths[0]!;
      if (status.startsWith("R")) branchDeleted.add(paths[0]!);
      const id = fileId(newPath);
      if (id && status !== "M") branchAdds.push({ id, path: newPath });
    }
    for (const { id, path: newPath } of branchAdds) {
      const developPath = developIds.get(id);
      // A rename that deleted the develop-side path is a move, not a dup.
      if (developPath !== undefined && !branchDeleted.has(developPath)) {
        violations.fileIds.push({ id, onBranch: newPath, onDevelop: developPath });
      }
    }
  }

  // -- rule literals ---------------------------------------------------------
  const content = await git(repo, io, ["diff", "--unified=0", range, "--", "packages", "docs"]);
  if (content.exitCode !== 0) {
    violations.complete = false;
  } else {
    // literal → the branch file(s) where a `+` line introduces it.
    const added = new Map<string, Set<string>>();
    let currentFile = "";
    for (const line of content.stdout.split("\n")) {
      const fileMarker = /^\+\+\+ b\/(.+)$/.exec(line);
      if (fileMarker) {
        currentFile = fileMarker[1]!;
        continue;
      }
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      for (const m of line.matchAll(RULE_LITERAL)) {
        const set = added.get(m[1]!) ?? new Set<string>();
        if (set.size === 0) added.set(m[1]!, set);
        set.add(currentFile);
      }
    }
    for (const [literal, branchFiles] of added) {
      const carriers = await git(repo, io, ["grep", "-l", "-F", literal, base]);
      if (carriers.exitCode !== 0) continue; // absent on develop → not a dup
      for (const hit of carriers.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)) {
        // `git grep <rev>` prefixes each path with `<rev>:` — strip it for
        // the same-file comparison and keep the raw form in the payload.
        const carrier = hit.startsWith(`${base}:`) ? hit.slice(base.length + 1) : hit;
        // Same id + same file = a re-landed same-site rule — not a collision.
        if (!branchFiles.has(carrier)) {
          violations.ruleIds.push({
            id: literal,
            onBranch: [...branchFiles].join(", "),
            onDevelop: hit,
          });
        }
      }
    }
  }
  return violations;
}
