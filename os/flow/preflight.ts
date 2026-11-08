/*
<MODULE_CONTRACT>
<purpose>flow.integrate preflight (RFC-1528) — a bounded, deterministic check list that
runs between the dirty-tree checks and the integration-gate spawn, refusing in
seconds what the gate would catch minutes later. Ordered: (1) worktree dirty +
lockfile-diff classification, (2) primary tracked dirt + classification,
(3) ecosystem.manifest.validate, (4) rfc.validate --id per changed RFC file,
(5) friction.validate. Each check runs only when resolvable (invoke port +
registry entry) — absence degrades with a note, never blocks. The list is
closed by the RFC: adding a check requires an amendment.</purpose>
<non-goals>
  <item>No auto-fix, no auto-commit — the lockfile classifier only labels the importer-prune-only shape with a remedy hint; a dirty pnpm-lock.yaml still refuses.</item>
  <item>No builds, no test suites — sub-minute deterministic validators only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1528: initial — classifyLockfileDiff + runIntegratePreflight (FLOW-INT-01/03 classification, FLOW-INT-12/13/14 validator refusals).</item>
  <item>RFC-1528: flow.integrate bounded preflight before rebase and gate

Classified lockfile diffs on FLOW-INT-01/03, early primary check, and resolvable validators (ecosystem.manifest.validate, scoped rfc.validate, friction.validate) refusing as FLOW-INT-12/13/14.</item>
  <item>RFC-1528: close review findings — manifest-union command inventory for regen/preflight</item>
  <item>RFC-1537: regenerable dirt classifier (importer-materialize, skill-twin-sync), cheap-first open-mission check (WT-GATE-01), toleratedState surfacing</item>
</CHANGE_SUMMARY>
*/

import { dirname, join } from "node:path";

import type {
  CommandRegistry,
  ForgeInvokeCommand,
  ForgeRegisteredCommandInfo,
  WorkspaceIO,
} from "../../src/types.ts";
import { loadLiveCommandInventory } from "../../src/utils/command-inventory.ts";
import { openMissionsIn } from "../mission/open-missions.ts";
import { currentBranch, git, statusTracked } from "./git.ts";

export type LockfileClassification = "importer-prune-only" | "other";

/**
 * Strict match for the pnpm-prune shape: ONLY removed lines, every one either
 * a `missions/<id>/workpiece:` importer key or a deeper-indented member of
 * such a key's block. Any added line, any other removed line, or a diff with
 * no removals classifies "other" — ambiguous diffs stay ordinary refusals.
 */
export function classifyLockfileDiff(diffText: string): LockfileClassification {
  let sawImporterKey = false;
  let openBlockIndent: number | null = null;
  for (const raw of diffText.split("\n")) {
    if (
      raw === "" ||
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("---") ||
      raw.startsWith("+++") ||
      raw.startsWith("@@")
    ) {
      if (raw.startsWith("@@")) openBlockIndent = null;
      continue;
    }
    if (raw.startsWith("+")) return "other";
    const line = raw.slice(1);
    if (raw[0] === " ") {
      const indent = line.length - line.trimStart().length;
      if (openBlockIndent !== null && line.trim().length > 0 && indent <= openBlockIndent) {
        openBlockIndent = null;
      }
      continue;
    }
    if (raw[0] !== "-") continue;
    if (line.trim().length === 0) {
      // A blank removed line only tolerates inside an open importer block.
      if (openBlockIndent === null) return "other";
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (/^\s*missions\/[^\s/]+\/workpiece:\s*$/.test(line)) {
      sawImporterKey = true;
      openBlockIndent = indent;
      continue;
    }
    if (openBlockIndent !== null && indent > openBlockIndent) continue;
    return "other";
  }
  return sawImporterKey ? "importer-prune-only" : "other";
}

/**
 * Mirror of the prune shape for materialization (RFC-1537): ONLY added lines,
 * every one either a `missions/<id>/workpiece:` importer key or a deeper-
 * indented member of such a block. Returns the sorted mission ids on match,
 * null otherwise — any removal or foreign addition is ambiguous.
 */
export function classifyLockfileMaterialize(diffText: string): string[] | null {
  const ids = new Set<string>();
  let sawImporterKey = false;
  let openBlockIndent: number | null = null;
  for (const raw of diffText.split("\n")) {
    if (
      raw === "" ||
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("---") ||
      raw.startsWith("+++") ||
      raw.startsWith("@@")
    ) {
      if (raw.startsWith("@@")) openBlockIndent = null;
      continue;
    }
    if (raw.startsWith("-")) return null;
    const line = raw.slice(1);
    if (raw[0] === " ") {
      const indent = line.length - line.trimStart().length;
      if (openBlockIndent !== null && line.trim().length > 0 && indent <= openBlockIndent) {
        openBlockIndent = null;
      }
      continue;
    }
    if (raw[0] !== "+") continue;
    if (line.trim().length === 0) {
      // A blank added line only tolerates inside an open importer block.
      if (openBlockIndent === null) return null;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const key = /^\s*missions\/([^\s/]+)\/workpiece:\s*$/.exec(line);
    if (key) {
      sawImporterKey = true;
      ids.add(key[1]);
      openBlockIndent = indent;
      continue;
    }
    if (openBlockIndent !== null && indent > openBlockIndent) continue;
    return null;
  }
  return sawImporterKey ? [...ids].sort() : null;
}

/** Classify the pnpm-lock.yaml diff of `repo` when the lockfile is dirty. */
async function classifyDirtyLockfile(
  repo: string,
  io: WorkspaceIO,
  dirtyEntries: string[],
  runGit: typeof git,
): Promise<LockfileClassification | null> {
  const lockfileDirty = dirtyEntries.some((entry) => entry.slice(3).trim() === "pnpm-lock.yaml");
  if (!lockfileDirty) return null;
  const diff = await runGit(repo, io, ["diff", "HEAD", "--", "pnpm-lock.yaml"]);
  return classifyLockfileDiff(diff.stdout);
}

// ── RFC-1537: regenerable dirt classifier ────────────────────────────────

export type DirtClass =
  | "importer-prune"
  | "importer-materialize"
  | "skill-twin-sync"
  | "unattributed";

export interface ToleratedEntry {
  path: string;
  class: DirtClass;
}

export interface DirtVerdict {
  tolerated: ToleratedEntry[];
  /** Porcelain lines that match no declared regenerable shape — still refuse. */
  unattributed: string[];
}

const TWIN_ROOT = ".agents/skills/";

/** Canonical candidates for a `.agents/skills/<dir>/<rel>` twin path. */
function twinCanonicalCandidates(dir: string, rel: string): string[] {
  const candidates = [
    `packages/forge/skills/${dir}/${rel}`,
    `packages/forge/skills/fo/${dir}/${rel}`,
    `packages/forge/skills/meta/${dir}/${rel}`,
    `packages/werkstatt-site/src/domain/skills/${dir}/${rel}`,
  ];
  if (dir === "shared-knowledge") {
    candidates.push(`packages/forge/skills/shared/knowledge/${rel}`);
  }
  return candidates;
}

async function fileBytesEqual(a: string, b: string, io: WorkspaceIO): Promise<boolean> {
  const [ba, bb] = await Promise.all([io.readFileBytes(a), io.readFileBytes(b)]);
  return ba.length === bb.length && ba.every((v, i) => v === bb[i]);
}

/** `.prettierignore` diff is twin-sync only when every change adds .agents/skills/ lines. */
function prettierignoreTwinOnly(diffText: string): boolean {
  let saw = false;
  for (const raw of diffText.split("\n")) {
    if (
      raw === "" ||
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("---") ||
      raw.startsWith("+++") ||
      raw.startsWith("@@") ||
      raw.startsWith(" ")
    ) {
      continue;
    }
    if (raw.startsWith("-")) return false;
    if (raw.startsWith("+")) {
      if (!/^\+\s*\.agents\/skills\/[^\s]+\/?\s*$/.test(raw)) return false;
      saw = true;
    }
  }
  return saw;
}

/**
 * Partition porcelain lines into declared regenerable classes (tolerated —
 * journaled, never committed) and `unattributed` lines that still refuse.
 * The shapes are closed by RFC-1537: ambiguity always degrades to
 * unattributed, never to tolerance.
 */
export async function classifyDirt(
  repo: string,
  io: WorkspaceIO,
  entries: string[],
  deps: { runGit: typeof git } = { runGit: git },
): Promise<DirtVerdict> {
  const tolerated: ToleratedEntry[] = [];
  const unattributed: string[] = [];
  const byPath = new Map<string, string[]>();
  for (const line of entries) {
    const p = line.slice(3).trim();
    byPath.set(p, [...(byPath.get(p) ?? []), line]);
  }

  let openMissions: Set<string> | null = null;
  const openMissionIds = async (): Promise<Set<string>> => {
    if (openMissions === null) {
      openMissions = new Set(await openMissionsIn(repo, io));
    }
    return openMissions;
  };

  outer: for (const [path, lines] of byPath) {
    if (path === "pnpm-lock.yaml") {
      const diff = await deps.runGit(repo, io, ["diff", "HEAD", "--", "pnpm-lock.yaml"]);
      if (classifyLockfileDiff(diff.stdout) === "importer-prune-only") {
        tolerated.push({ path, class: "importer-prune" });
        continue;
      }
      const ids = classifyLockfileMaterialize(diff.stdout);
      if (ids !== null) {
        const open = await openMissionIds();
        if (ids.every((id) => open.has(id))) {
          tolerated.push({ path, class: "importer-materialize" });
          continue;
        }
      }
      unattributed.push(...lines);
      continue;
    }
    if (path === ".prettierignore") {
      const diff = await deps.runGit(repo, io, ["diff", "HEAD", "--", ".prettierignore"]);
      if (prettierignoreTwinOnly(diff.stdout)) {
        tolerated.push({ path, class: "skill-twin-sync" });
        continue;
      }
      unattributed.push(...lines);
      continue;
    }
    if (path.startsWith(TWIN_ROOT) && path.length > TWIN_ROOT.length) {
      const rel = path.slice(TWIN_ROOT.length).replace(/\/$/, "");
      const dir = rel.split("/")[0];
      const fileRel = rel.slice(dir.length + 1);
      if (fileRel === "") {
        // `?? .agents/skills/<dir>/` — an untracked twin DIRECTORY. Fail
        // closed: every file inside must byte-match a canonical source or be
        // the .forge-managed marker beside one; a single stray stays dirty.
        const canonicalDir = async (): Promise<boolean> => {
          for (const c of twinCanonicalCandidates(dir, "SKILL.md")) {
            if (await io.exists(join(repo, dirname(c)))) return true;
          }
          return false;
        };
        const files = (await io.glob(`${TWIN_ROOT}${rel}/**`, { cwd: repo })).filter(
          (f) => !f.endsWith("/"),
        );
        let allTwins = files.length > 0 && (await canonicalDir());
        for (const f of allTwins ? files : []) {
          const frel = f.slice(`${TWIN_ROOT}${rel}/`.length);
          if (frel === ".forge-managed") continue;
          let matched = false;
          for (const c of twinCanonicalCandidates(dir, frel)) {
            const abs = join(repo, c);
            if ((await io.exists(abs)) && (await fileBytesEqual(join(repo, f), abs, io))) {
              matched = true;
              break;
            }
          }
          if (!matched) {
            allTwins = false;
            break;
          }
        }
        if (allTwins) tolerated.push({ path, class: "skill-twin-sync" });
        else unattributed.push(...lines);
        continue;
      }
      if (fileRel === ".forge-managed") {
        // Twin bookkeeping file — tolerated when the dir has any canonical
        // skill source; a free-floating marker is real dirt.
        let markerOk = false;
        for (const c of twinCanonicalCandidates(dir, "SKILL.md")) {
          if (await io.exists(join(repo, dirname(c)))) {
            markerOk = true;
            break;
          }
        }
        if (markerOk) tolerated.push({ path, class: "skill-twin-sync" });
        else unattributed.push(...lines);
        continue;
      }
      let matched = false;
      for (const c of twinCanonicalCandidates(dir, fileRel)) {
        const abs = join(repo, c);
        if ((await io.exists(abs)) && (await fileBytesEqual(join(repo, path), abs, io))) {
          matched = true;
          break;
        }
      }
      if (matched) tolerated.push({ path, class: "skill-twin-sync" });
      else unattributed.push(...lines);
      continue;
    }
    unattributed.push(...lines);
  }
  return { tolerated, unattributed };
}

const LOCKFILE_PRUNE_HINT =
  " — its diff matches the vanished mission-importer prune shape; restore it " +
  "(`git checkout -- pnpm-lock.yaml` is blocked for agents: copy HEAD bytes " +
  "with `git show HEAD:pnpm-lock.yaml > pnpm-lock.yaml`) or commit the prune deliberately";

export interface PreflightRefuse {
  ruleId: string;
  message: string;
  fixHint: string;
  data?: Record<string, unknown>;
}

export interface PreflightSkip {
  check: string;
  reason: "no-invoke" | "unresolvable";
}

export interface IntegratePreflightResult {
  ok: boolean;
  /** Check names that ran, in order. */
  checked: string[];
  /** Checks skipped — invoke port absent, or command not in the inventory. */
  skipped: PreflightSkip[];
  /** RFC-1537: regenerable dirt tolerated on this run — journaled, never
   * committed or silently absorbed. */
  tolerated: ToleratedEntry[];
  refuse?: PreflightRefuse;
}

/**
 * The bounded preflight — first failure wins. `deps` seams exist for tests;
 * production passes the real git helpers.
 */
export async function runIntegratePreflight(
  opts: {
    primary: string;
    branchWorktree: string;
    branch: string;
    io: WorkspaceIO;
    /** Already-computed statusDirty() of the branch worktree. */
    worktreeDirty: { entries: string[]; toleratedState: string[] };
    invoke?: ForgeInvokeCommand;
    commandRegistry?: CommandRegistry;
    /** Test seam — overrides the live inventory union (registry + command manifest). */
    commands?: ForgeRegisteredCommandInfo[];
  },
  deps: {
    runGit: typeof git;
    runStatusTracked: typeof statusTracked;
    runCurrentBranch: typeof currentBranch;
  } = { runGit: git, runStatusTracked: statusTracked, runCurrentBranch: currentBranch },
): Promise<IntegratePreflightResult> {
  const checked: string[] = [];
  const skipped: PreflightSkip[] = [];
  const tolerated: ToleratedEntry[] = [];
  const { io } = opts;
  // D-001 union: werkstatt run supplies invoke but no commandRegistry — the
  // generated manifest (in the primary checkout) covers resolvability.
  const commands = opts.commands ?? loadLiveCommandInventory(opts.primary, opts.commandRegistry);
  const commandNames = new Set(commands.map((c) => c.name));
  const resolvable = (name: string) => opts.invoke !== undefined && commandNames.has(name);

  // (0) open mission in the integrating worktree — WT-GATE-01 semantics at
  // preflight price (RFC-1537): ahead of every validator arm and even the
  // dirty checks, since a live mission outranks a dirty tree. A scan failure
  // skips with a note — the downstream gate still enforces.
  try {
    const openMissions = await openMissionsIn(opts.branchWorktree, io);
    checked.push("open-mission");
    if (openMissions.length > 0) {
      return {
        ok: false,
        checked,
        skipped,
        tolerated,
        refuse: {
          ruleId: "WT-GATE-01",
          message: `worktree has ${openMissions.length} open mission(s): ${openMissions.join(", ")}`,
          fixHint: "close or abort the mission(s) in the worktree before integrating or tearing down",
          data: { openMissions },
        },
      };
    }
  } catch {
    skipped.push({ check: "open-mission", reason: "unresolvable" });
  }

  // (1) worktree dirty — FLOW-INT-01 only on unattributed entries; declared
  // regenerable classes journal as tolerated (RFC-1537).
  checked.push("worktree-dirty");
  if (opts.worktreeDirty.entries.length > 0) {
    const verdict = await classifyDirt(opts.branchWorktree, io, opts.worktreeDirty.entries, {
      runGit: deps.runGit,
    });
    tolerated.push(...verdict.tolerated);
    if (verdict.unattributed.length > 0) {
      const lockfile = await classifyDirtyLockfile(
        opts.branchWorktree,
        io,
        verdict.unattributed,
        deps.runGit,
      );
      return {
        ok: false,
        checked,
        skipped,
        tolerated,
        refuse: {
          ruleId: "FLOW-INT-01",
          message:
            `worktree ${opts.branchWorktree} has ${verdict.unattributed.length} uncommitted change(s): ${verdict.unattributed.slice(0, 10).join(", ")}` +
            (verdict.tolerated.length > 0
              ? ` — tolerated regenerable state: ${verdict.tolerated.map((t) => `${t.path} (${t.class})`).join(", ")}`
              : "") +
            (opts.worktreeDirty.toleratedState.length > 0
              ? ` — tolerated forge-local state: ${opts.worktreeDirty.toleratedState.join(", ")}`
              : "") +
            (lockfile === "importer-prune-only" ? ` — pnpm-lock.yaml${LOCKFILE_PRUNE_HINT}` : ""),
          fixHint:
            "commit or revert the uncommitted changes inside the session worktree, then re-run",
          data: {
            entries: verdict.unattributed.map((line) => line.slice(3)),
            toleratedState: opts.worktreeDirty.toleratedState,
            toleratedDirt: verdict.tolerated,
            ...(lockfile !== null ? { lockfileClassification: lockfile } : {}),
          },
        },
      };
    }
  }

  // (2) primary must sit clean on develop — early FLOW-INT-03, same
  // classification; the post-gate check stays (primary can dirty mid-gate).
  checked.push("primary-dirty");
  const primaryBranch = await deps.runCurrentBranch(opts.primary, io);
  const primaryDirty = await deps.runStatusTracked(opts.primary, io);
  if (primaryDirty.entries.length > 0) {
    const verdict = await classifyDirt(opts.primary, io, primaryDirty.entries, {
      runGit: deps.runGit,
    });
    tolerated.push(...verdict.tolerated);
    if (primaryBranch !== "develop" || verdict.unattributed.length > 0) {
      const lockfile = await classifyDirtyLockfile(
        opts.primary,
        io,
        verdict.unattributed,
        deps.runGit,
      );
      return {
        ok: false,
        checked,
        skipped,
        tolerated,
        refuse: {
          ruleId: "FLOW-INT-03",
          message:
            (primaryBranch !== "develop"
              ? `primary worktree is on ${primaryBranch ?? "detached HEAD"}, not develop`
              : `primary worktree has ${verdict.unattributed.length} uncommitted change(s)`) +
            (verdict.tolerated.length > 0
              ? ` — tolerated regenerable state: ${verdict.tolerated.map((t) => `${t.path} (${t.class})`).join(", ")}`
              : "") +
            (lockfile === "importer-prune-only" ? ` — pnpm-lock.yaml${LOCKFILE_PRUNE_HINT}` : ""),
          fixHint:
            "switch the primary to develop and commit or revert its tracked changes, then re-run — the branch stays rebased",
          data: {
            entries: verdict.unattributed.map((line) => line.slice(3)),
            toleratedDirt: verdict.tolerated,
            ...(lockfile !== null ? { lockfileClassification: lockfile } : {}),
          },
        },
      };
    }
  } else if (primaryBranch !== "develop") {
    return {
      ok: false,
      checked,
      skipped,
      tolerated,
      refuse: {
        ruleId: "FLOW-INT-03",
        message: `primary worktree is on ${primaryBranch ?? "detached HEAD"}, not develop`,
        fixHint:
          "switch the primary to develop and commit or revert its tracked changes, then re-run — the branch stays rebased",
      },
    };
  }

  // (3) ecosystem.manifest.validate — stale generated manifest refuses early.
  if (resolvable("ecosystem.manifest.validate")) {
    checked.push("ecosystem.manifest.validate");
    const result = await opts.invoke!("ecosystem.manifest.validate", {});
    if (result.ok === false || (result.exitCode !== undefined && result.exitCode !== 0)) {
      return {
        ok: false,
        checked,
        skipped,
        tolerated,
        refuse: {
          ruleId: "FLOW-INT-12",
          message: `preflight: ecosystem.manifest.validate refused — ${result.summary ?? `exit ${result.exitCode}`}`,
          fixHint:
            "regenerate the manifest via `pnpm exec werkstatt run ecosystem.manifest.generate`, commit, then re-run flow.integrate",
          data: { command: "ecosystem.manifest.validate", summary: result.summary },
        },
      };
    }
  } else {
    skipped.push({
      check: "ecosystem.manifest.validate",
      reason: opts.invoke === undefined ? "no-invoke" : "unresolvable",
    });
  }

  // (4) rfc.validate --id per changed RFC file on develop...branch.
  // --diff-filter=d excludes deletions — an archive move's old path must not
  // produce a validate-id on a vanished file.
  const diff = await deps.runGit(opts.primary, io, [
    "diff",
    "--name-only",
    "--diff-filter=d",
    `develop...${opts.branch}`,
  ]);
  const changedRfcIds = [
    ...new Set(
      diff.stdout
        .split("\n")
        .map(
          (l) =>
            /^docs\/rfcs\/(?:archive\/(?:implemented|rejected|superseded)\/)?rfc-(\d+)-[^/]*\.md$/.exec(
              l.trim(),
            )?.[1],
        )
        .filter((m): m is string => m !== undefined)
        .map((n) => `RFC-${n.padStart(4, "0")}`),
    ),
  ];
  if (changedRfcIds.length > 0) {
    if (resolvable("rfc.validate")) {
      for (const id of changedRfcIds) {
        checked.push(`rfc.validate:${id}`);
        const result = await opts.invoke!("rfc.validate", { id });
        if (result.ok === false || (result.exitCode !== undefined && result.exitCode !== 0)) {
          return {
            ok: false,
            checked,
            skipped,
            tolerated,
            refuse: {
              ruleId: "FLOW-INT-13",
              message: `preflight: rfc.validate ${id} refused — ${result.summary ?? `exit ${result.exitCode}`}`,
              fixHint: "fix the RFC diagnostics, commit, then re-run flow.integrate",
              data: { command: "rfc.validate", id, summary: result.summary },
            },
          };
        }
      }
    } else {
      skipped.push({
        check: "rfc.validate",
        reason: opts.invoke === undefined ? "no-invoke" : "unresolvable",
      });
    }
  }

  // (5) friction.validate — a broken registry refuses early.
  if (resolvable("friction.validate")) {
    checked.push("friction.validate");
    const result = await opts.invoke!("friction.validate", {});
    if (result.ok === false || (result.exitCode !== undefined && result.exitCode !== 0)) {
      return {
        ok: false,
        checked,
        skipped,
        tolerated,
        refuse: {
          ruleId: "FLOW-INT-14",
          message: `preflight: friction.validate refused — ${result.summary ?? `exit ${result.exitCode}`}`,
          fixHint:
            "repair docs/frictions.yaml (e.g. a duplicate id), commit, then re-run flow.integrate",
          data: { command: "friction.validate", summary: result.summary },
        },
      };
    }
  } else {
    skipped.push({
      check: "friction.validate",
      reason: opts.invoke === undefined ? "no-invoke" : "unresolvable",
    });
  }

  return { ok: true, checked, skipped, tolerated };
}
