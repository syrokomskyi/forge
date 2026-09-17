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
  <item>RFC-1097: initial handler — dirty-tree refusal with --force, --files bypass, dry-run manifest.</item>
  <item>RFC-1097: steps 1-4 — compass.migrate codemod

Add the v1 to v2 Compass header codemod: migrateFile pure transform (collapse, strip, seed, reorder, purpose-flag actions), migrateWorkspace walker, runCompassMigrate handler with dirty-tree refusal and --force/--files/--dry-run flags, module registration, and 15 unit tests.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — engine package clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. engine package now 0 diagnostics.</item>
  <item>RFC-1097: AC-4 banned literal in os/compass handlers

compass-migrate-handler hint used a consumer-specific run command — switched to generic 'pnpm exec forge run' convention. Reworded recorded CHANGE_SUMMARY items in 3 handlers to drop the consumer-specific literal. compass-policy AC-4 test green (65/65).</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import { migrateWorkspace, type MigrateResult } from "./compass-migrate.ts";
import { resolveCompassScanRoot } from "./resolve-scan-root.ts";
import { resolveCompassPolicy } from "../policy.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const DIRTY_LIST_CAP = 20;

function listDirtyPaths(repoRoot: string): string[] | null {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3));
  } catch {
    // Not a git repository — nothing to protect, skip the check.
    return null;
  }
}

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
    const dirty = listDirtyPaths(baseRoot);
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
  });

  const counts = new Map<string, number>();
  for (const file of result.files) {
    for (const action of file.actions) {
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
  }
  const tally = [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(", ");

  return {
    data: result,
    exitCode: 0,
    summary: `[compass.migrate] scanned=${result.scanned} ${tally}${dryRun ? " (dry-run)" : ""}`,
    nextSteps: [
      {
        action:
          "Run `pnpm exec forge run compass.inventory --json` to list todo/purpose-flagged files for the agent sweep.",
        kind: "optional",
      },
    ],
  };
}
