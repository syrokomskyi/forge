/*
<MODULE_CONTRACT>
<purpose>forge pinned.init — creates .forge/pinned.yaml with default foundation
entries, installs pre-commit hook, adds audit log to .gitignore, and optionally
generates CI workflow. Idempotent: re-running merges defaults with existing entries.</purpose>
<non-goals>
  <item>Does not validate the manifest — use pinned.validate.</item>
  <item>Does not enforce protection on archive commands — that is pinned-check.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0733: initial pinned.init handler with manifest creation, hook installation, gitignore update, and CI workflow generation.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { writeFileIfChanged } from "../../../src/utils/fs-idempotent.ts";
import { PINNED_MANIFEST_PATH, loadPinnedManifest } from "./pinned-check.ts";
import type { PinnedEntry, PinnedManifest } from "./pinned-types.ts";

const PRE_COMMIT_HOOK_MARKER = "# forge:pinned-check";
const AUDIT_LOG_REL_PATH = ".forge/pinned-audit.log";

/**
 * Default pinned entries for a forge-consuming repository.
 * These are re-added by pinned.init if missing from an existing manifest.
 */
export const DEFAULT_PINNED_ENTRIES: PinnedEntry[] = [
  {
    path: ".forge/pinned.yaml",
    mode: "freeze",
    reason: "Self-protection — manifest must not be tampered with",
  },
  {
    path: "docs/rfcs/rfc-0000-template.md",
    mode: "freeze",
    reason: "RFC template — required for rfc.create",
  },
  {
    path: "docs/adrs/adr-0000-template.md",
    mode: "freeze",
    reason: "ADR template — required for adr.create",
  },
  {
    path: "docs/audits/audit-0000-template.md",
    mode: "freeze",
    reason: "Audit template — required for audit creation",
  },
  {
    path: "docs/plans/plan-0000-template.md",
    mode: "freeze",
    reason: "Plan template — required for plan creation",
  },
  {
    path: "docs/architecture-dna.md",
    mode: "freeze",
    reason: "Architecture DNA invariants — foundational governance document",
  },
  {
    path: "forge.yaml",
    mode: "protect",
    reason: "Forge configuration — required for all forge commands",
  },
  {
    path: "package.json",
    mode: "protect",
    reason: "Root package.json — workspace manifest",
  },
  {
    path: "pnpm-workspace.yaml",
    mode: "protect",
    reason: "Workspace definition",
  },
  {
    path: "AGENTS.md",
    mode: "protect",
    reason: "Agent rules manifest",
  },
  {
    path: "PREFERENCES.md",
    mode: "protect",
    reason: "Operator preferences",
  },
  {
    path: "docs/rfcs/",
    mode: "protect",
    reason: "RFC directory — structural foundation",
  },
  {
    path: "docs/adrs/",
    mode: "protect",
    reason: "ADR directory — structural foundation",
  },
];

const PRE_COMMIT_HOOK_SCRIPT = `#!/bin/sh
${PRE_COMMIT_HOOK_MARKER}
# Installed by forge pinned.init — do not remove this marker block.
# Pinned-files protection: blocks commits that delete/move/modify pinned files.
forge pinned.validate || exit 1
`;

const CI_WORKFLOW_TEMPLATE = `name: pinned-files
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2
      - run: npm install -g @warpgogol/forge
      - run: forge pinned.validate --mode ci --json
`;

/**
 * Merge default entries with existing manifest entries.
 * - Re-adds missing default entries (forge expects them).
 * - Never overwrites or removes custom entries.
 */
function mergeManifest(existing: PinnedManifest | null, defaults: PinnedEntry[]): PinnedManifest {
  if (!existing) {
    return { pinned: [...defaults] };
  }

  const existingPaths = new Set(existing.pinned.map((e) => e.path));
  const merged = [...existing.pinned];

  for (const def of defaults) {
    if (!existingPaths.has(def.path)) {
      merged.push(def);
    }
  }

  return { pinned: merged };
}

/**
 * Install or merge the pre-commit hook.
 * If a hook exists, appends the forge check with a marker for idempotent re-installation.
 */
async function installPreCommitHook(
  repoRoot: string,
): Promise<"created" | "updated" | "unchanged"> {
  const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");

  let existingContent: string;
  try {
    existingContent = await fs.readFile(hookPath, "utf8");
  } catch {
    // No existing hook — create new
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await writeFileIfChanged(hookPath, PRE_COMMIT_HOOK_SCRIPT);
    await fs.chmod(hookPath, 0o755);
    return "created";
  }

  // Check if forge hook is already present
  if (existingContent.includes(PRE_COMMIT_HOOK_MARKER)) {
    return "unchanged";
  }

  // Append forge hook to existing hook
  const mergedContent = existingContent + "\n" + PRE_COMMIT_HOOK_SCRIPT;
  await writeFileIfChanged(hookPath, mergedContent);
  await fs.chmod(hookPath, 0o755);
  return "updated";
}

/**
 * Add .forge/pinned-audit.log to .gitignore (or append to existing).
 */
async function addToGitignore(repoRoot: string): Promise<"created" | "updated" | "unchanged"> {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const entry = AUDIT_LOG_REL_PATH;

  let existingContent: string;
  try {
    existingContent = await fs.readFile(gitignorePath, "utf8");
  } catch {
    // No .gitignore — create new
    await writeFileIfChanged(gitignorePath, entry + "\n");
    return "created";
  }

  // Check if entry already exists
  const lines = existingContent.split("\n");
  if (lines.some((l) => l.trim() === entry)) {
    return "unchanged";
  }

  // Append entry
  const mergedContent = existingContent.trimEnd() + "\n" + entry + "\n";
  await writeFileIfChanged(gitignorePath, mergedContent);
  return "updated";
}

/**
 * Generate CI workflow file.
 */
async function generateCiWorkflow(repoRoot: string): Promise<"created" | "unchanged"> {
  const workflowPath = path.join(repoRoot, ".github", "workflows", "pinned-check.yml");
  await fs.mkdir(path.dirname(workflowPath), { recursive: true });
  await writeFileIfChanged(workflowPath, CI_WORKFLOW_TEMPLATE);
  return "created";
}

export interface PinnedInitResult {
  command: "pinned.init";
  status: "ok";
  manifestPath: string;
  manifestAction: "created" | "merged" | "unchanged";
  entriesCount: number;
  hookAction: "created" | "updated" | "unchanged";
  gitignoreAction: "created" | "updated" | "unchanged";
  ciWorkflowAction: "created" | "unchanged" | "skipped";
}

export async function runPinnedInit(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<PinnedInitResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const ci = input.flags["ci"] === true;

  // Load existing manifest (if any)
  let existingManifest: PinnedManifest | null = null;
  try {
    existingManifest = await loadPinnedManifest(workspaceRoot);
  } catch {
    // Malformed manifest — will be overwritten with defaults
    existingManifest = null;
  }

  // Merge with defaults
  const merged = mergeManifest(existingManifest, DEFAULT_PINNED_ENTRIES);

  // Determine action
  const manifestAction: "created" | "merged" | "unchanged" =
    existingManifest === null
      ? "created"
      : merged.pinned.length > existingManifest.pinned.length
        ? "merged"
        : "unchanged";

  // Write manifest
  const manifestFullPath = path.join(workspaceRoot, PINNED_MANIFEST_PATH);
  await fs.mkdir(path.dirname(manifestFullPath), { recursive: true });
  const manifestContent = stringifyYaml(merged);
  await writeFileIfChanged(manifestFullPath, manifestContent);

  // Install pre-commit hook
  const hookAction = await installPreCommitHook(workspaceRoot);

  // Add to .gitignore
  const gitignoreAction = await addToGitignore(workspaceRoot);

  // Optional CI workflow
  let ciWorkflowAction: "created" | "unchanged" | "skipped" = "skipped";
  if (ci) {
    ciWorkflowAction = await generateCiWorkflow(workspaceRoot);
  }

  const result: PinnedInitResult = {
    command: "pinned.init",
    status: "ok",
    manifestPath: PINNED_MANIFEST_PATH,
    manifestAction,
    entriesCount: merged.pinned.length,
    hookAction,
    gitignoreAction,
    ciWorkflowAction,
  };

  if (outputFormat === "pretty") {
    logger.success(
      `pinned.init: manifest ${manifestAction} (${merged.pinned.length} entries), hook ${hookAction}, gitignore ${gitignoreAction}` +
        (ci ? `, CI workflow ${ciWorkflowAction}` : ""),
    );
  }

  return {
    data: result,
    summary: `Manifest ${manifestAction} with ${merged.pinned.length} entries, hook ${hookAction}, gitignore ${gitignoreAction}`,
    nextSteps: [
      {
        action: "Commit .forge/pinned.yaml and .gitignore changes",
        kind: "required",
      },
      ...(ci
        ? [{ action: "Commit .github/workflows/pinned-check.yml", kind: "required" as const }]
        : []),
    ],
  };
}
