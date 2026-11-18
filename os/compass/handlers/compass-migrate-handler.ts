/*
<MODULE_CONTRACT>
<purpose>compass.migrate kernel handler (RFC-1097). Resolves scan root and
policy, enforces the dirty-tree refusal before any write, then delegates to
the migrateWorkspace codemod and returns the per-file action manifest.</purpose>
<non-goals>
  <item>Do not implement transform logic — that lives in compass-migrate.ts.</item>
  <item>Do not scaffold headers — no-header files are reported, not written.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1097: sweep — engine package clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. engine package now 0 diagnostics.</item>
  <item>RFC-1097: AC-4 banned literal in os/compass handlers

compass-migrate-handler hint used a consumer-specific run command — switched to generic 'pnpm exec forge run' convention. Reworded recorded CHANGE_SUMMARY items in 3 handlers to drop the consumer-specific literal. compass-policy AC-4 test green (65/65).</item>
  <item>RFC-1318: add compass.header.scaffold codemod for mechanical header sweeps</item>
  <item>RFC-1323: write-time comment-terminator safety — shared comment-safety seam, authored CS-08 reject, injected neutralization, header-region scan</item>
  <item>RFC-1616: close RFC-1616 r9 trust-boundary counterexamples

Independent clean-context verification (round 9, candidate 4436339db)
returned REFUTED with ten live counterexamples against the r8-hardened
evidence channel — this commit closes all root causes.

- Pack-carried objects get the loose-sweep integrity anchor: every
  .idx/.pack pair under objects/pack is verify-pack -s'd at preflight
  and the sweep memo key is the unforgeable (ino, ctimeMs, size) stat
  triple (CX-113/114); pack.useBitmapIndex=false pins the bitmap
  reachability cache off.
- Every trusted-path git call routes through the judged/preflighted
  channel: execGit/readCommittedEnvelope/readAcceptanceReports/
  listWorkspaceFiles and the snapshot gitGrep closure now run
  verifierGit/createOriginGit with structured fail-closed dirty
  verdicts (CX-115/118/120/122).
- Export materialization no longer trusts git archive, ambient tar, or
  committed .gitattributes: exportTree enumerates ls-tree -r -z and
  materializes committed bytes through the re-hashed cat-file --batch
  channel, bounding symlink targets to the export root (CX-116/117).
- Index-consulting reads run on a verifier-owned claims rebuild:
  prepareEvidenceIndex copies staged object claims into a fresh index
  with zeroed stat metadata, so status/diff content-hash the worktree
  instead of trusting a session-written stat tuple (CX-121).
- The heredoc lexer is quote-aware: a << inside quotes is string
  content, never an operator (CX-119).
- Pins ride GIT_CONFIG_* env so the spawned argv stays the judged
  query verbatim; diff.external moved from a broken pin to
  refuse-on-presence; OriginGit.run/runExit now judge caller argv with
  the same read table; batch stdin is EPIPE-safe.
- kernel-source-scan models the two channel files as judged bodies so
  the channel migration does not read as new unguarded subprocess hits
  in the werkstatt-site mutation ratchet.

The independent r9 probe file and acceptance report land in the
follow-up port commit.</item>
  <history>RFC-1097</history>
</CHANGE_SUMMARY>
*/

import { migrateWorkspace, type MigrateResult } from "./compass-migrate.ts";
import { DIRTY_LIST_CAP, listDirtyPaths } from "./git-revision.ts";
import { resolveCompassScanRoot } from "./resolve-scan-root.ts";
import { resolveCompassPolicy } from "../policy.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export async function runCompassMigrate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<MigrateResult>> {
  const scanRoot = resolveCompassScanRoot(input, context);
  const baseRoot = scanRoot ?? context.workspaceRoot;
  const policy = resolveCompassPolicy(baseRoot, context.forgeRoot);

  const dryRun = context.dryRun || input.flags["dry-run"] === true;
  const force = input.flags["force"] === true;

  const rawFiles = input.flags["files"];
  const files = (
    Array.isArray(rawFiles)
      ? rawFiles.filter((entry): entry is string => typeof entry === "string")
      : typeof rawFiles === "string"
        ? [rawFiles]
        : []
  )
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const explicitFiles = files.length > 0 ? files : undefined;

  // Dirty-tree refusal guards the write only — a dry-run writes nothing and
  // stays useful as a pre-commit preview on a dirty tree.
  if (!dryRun && !force) {
    const dirtyResult = await listDirtyPaths(baseRoot);
    if (dirtyResult.refused) {
      // A refused dirty verdict is not a clean tree — the guard holds on
      // exactly the forgery class it exists for (CX-121).
      context.logger.error(
        `[compass.migrate] refusing to run — the dirty check could not get a trusted verdict${dirtyResult.reason ? ` (${dirtyResult.reason})` : ""}`,
      );
      return { exitCode: 1, summary: "dirty check refused — refused" };
    }
    const dirty = dirtyResult.paths;
    if (dirty && dirty.length > 0) {
      const shown = dirty.slice(0, DIRTY_LIST_CAP);
      const suffix =
        dirty.length > shown.length ? ` … and ${dirty.length - shown.length} more` : "";
      context.logger.error(
        `[compass.migrate] refusing to run on a dirty git tree (${dirty.length} uncommitted path(s)):\n${shown.map((p) => `  ${p}`).join("\n")}${suffix}\nCommit or stash first, or pass --force to override.`,
      );
      return { exitCode: 1, summary: "dirty git tree — refused" };
    }
  }

  const result = await migrateWorkspace(context.workspaceRoot, input, scanRoot, policy, {
    files: explicitFiles,
    dryRun,
    siteDirectory: context.site?.directory,
  });

  const counts = new Map<string, number>();
  for (const file of result.files) {
    for (const action of file.actions) {
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
  }
  const tally = [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
  const unsafe = result.files.filter((f) => f.actions.includes("unsafe-text"));
  const unsafeNote =
    unsafe.length > 0
      ? ` | COMPASS-CS-08 unsafe authored text (files left untouched): ${unsafe
          .map((f) => `${f.path}${f.error ? ` — ${f.error}` : ""}`)
          .join("; ")}`
      : "";

  return {
    data: result,
    exitCode: unsafe.length > 0 ? 1 : 0,
    summary: `[compass.migrate] scanned=${result.scanned} ${tally}${dryRun ? " (dry-run)" : ""}${unsafeNote}`,
    nextSteps: [
      {
        action:
          "Run `pnpm exec forge run compass.inventory --json` to list todo/purpose-flagged files for the agent sweep.",
        kind: "optional",
      },
    ],
  };
}
