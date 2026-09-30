/*
<MODULE_CONTRACT>
<purpose>
RFC-1154: managed `.prettierignore` block for forge-owned generated paths.
planPrettierignore detects whether a consumer project uses prettier (root
config file, package.json key, or existing .prettierignore) and computes the
delimited block entries — forge-synced skill dirs plus generated-artifact
globs. applyPrettierignore reconciles the block idempotently via
writeFileIfChanged; everything outside the delimited markers stays
operator-owned.
</purpose>
<non-goals>
  <item>Do not detect prettier outside the project root — nested-only configs are out of scope (documented limitation).</item>
  <item>Do not touch consumer entries outside the delimited block — the rest of the file is operator-owned.</item>
  <item>Do not list unmarked skill dirs — .agents/skills entries come from .forge-managed markers only (AC-9).</item>
</non-goals>
<KEY_DECISIONS>
  <item>Skill entries enumerate dirs carrying a .forge-managed marker — block membership equals the forge-owned set.</item>
  <item>Unbalanced markers treat the file as operator-owned; a fresh block is appended, never merged.</item>
</KEY_DECISIONS>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1154: initial implementation — plan/apply + delimited-block reconcile.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import type { WorkspaceIO } from "../types.ts";
import { resolveIo } from "../utils/io.ts";
import { writeFileIfChanged } from "../utils/fs-idempotent.ts";
import { fileExists } from "../utils/fs.ts";
import * as sfs from "../utils/sync-fs.ts";
import { SKILL_MARKER_FILE } from "./skill-markers.ts";

export const PRETTIERIGNORE_BLOCK_BEGIN = "# forge-managed generated paths (RFC-1154)";
export const PRETTIERIGNORE_BLOCK_END = "# end forge-managed";

/** Prettier config files probed at the project root (root-only detection). */
const PRETTIER_CONFIG_NAMES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.toml",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
];

/** Non-skill generated-artifact entries, in stable order. */
const FIXED_ENTRIES = [
  "**/*.generated.yaml",
  "docs/sessions/",
  "docs/metrics/",
  "docs/queues/session-*.yaml",
];

export interface PrettierignorePlan {
  applies: boolean; // consumer uses prettier
  entries: string[]; // resolved ignore entries for this workspace
  fileExists: boolean;
}

export type PrettierignoreResult = "written" | "updated" | "unchanged" | "skipped";

function packageJsonUsesPrettier(pkg: Record<string, unknown>): boolean {
  if (typeof pkg["prettier"] !== "undefined") return true;
  for (const depKey of ["dependencies", "devDependencies"]) {
    const deps = pkg[depKey];
    if (deps && typeof deps === "object" && "prettier" in deps) return true;
  }
  return false;
}

async function detectPrettier(workspaceRoot: string, io: WorkspaceIO): Promise<boolean> {
  for (const name of PRETTIER_CONFIG_NAMES) {
    if (await io.exists(path.join(workspaceRoot, name))) return true;
  }
  const pkgPath = path.join(workspaceRoot, "package.json");
  if (await io.exists(pkgPath)) {
    try {
      if (packageJsonUsesPrettier(JSON.parse(await io.readFile(pkgPath)))) return true;
    } catch {
      // Unreadable package.json — other probes still apply
    }
  }
  return fileExists(path.join(workspaceRoot, ".prettierignore"));
}

// Sync twin for runInit (sync call path — no WorkspaceIO).
function detectPrettierSync(workspaceRoot: string): boolean {
  for (const name of PRETTIER_CONFIG_NAMES) {
    if (sfs.existsSync(path.join(workspaceRoot, name))) return true;
  }
  const pkgPath = path.join(workspaceRoot, "package.json");
  if (sfs.existsSync(pkgPath)) {
    try {
      if (packageJsonUsesPrettier(JSON.parse(sfs.readFileSync(pkgPath, "utf8")))) return true;
    } catch {
      // Unreadable package.json — other probes still apply
    }
  }
  return sfs.existsSync(path.join(workspaceRoot, ".prettierignore"));
}

/**
 * Skill-dir entries derive from `.forge-managed` markers under
 * `agentsSkillsDir` — marker presence is the forge-ownership proof (AC-9:
 * unmarked dirs are consumer-owned and never listed).
 */
async function listManagedSkillEntries(
  workspaceRoot: string,
  skillsDirRel: string,
  io: WorkspaceIO,
): Promise<string[]> {
  const entries: string[] = [];
  const absDir = path.join(workspaceRoot, skillsDirRel);
  let children;
  try {
    children = await io.readdir(absDir);
  } catch {
    return entries;
  }
  for (const child of children) {
    if (!child.isDirectory) continue;
    if (await io.exists(path.join(absDir, child.name, SKILL_MARKER_FILE))) {
      entries.push(`${skillsDirRel.replace(/\/+$/, "")}/${child.name}/`);
    }
  }
  return entries.sort();
}

// Sync twin for runInit.
function listManagedSkillEntriesSync(workspaceRoot: string, skillsDirRel: string): string[] {
  const entries: string[] = [];
  const absDir = path.join(workspaceRoot, skillsDirRel);
  let children;
  try {
    children = sfs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const child of children) {
    if (!child.isDirectory()) continue;
    if (sfs.existsSync(path.join(absDir, child.name, SKILL_MARKER_FILE))) {
      entries.push(`${skillsDirRel.replace(/\/+$/, "")}/${child.name}/`);
    }
  }
  return entries.sort();
}

export async function planPrettierignore(
  workspaceRoot: string,
  skillsDirRel = ".agents/skills",
  io?: WorkspaceIO,
): Promise<PrettierignorePlan> {
  const fio = resolveIo(io);
  const applies = await detectPrettier(workspaceRoot, fio);
  const skillEntries = applies
    ? await listManagedSkillEntries(workspaceRoot, skillsDirRel, fio)
    : [];
  return {
    applies,
    entries: [...skillEntries, ...FIXED_ENTRIES],
    fileExists: await fileExists(path.join(workspaceRoot, ".prettierignore")),
  };
}

// Sync twin for runInit.
export function planPrettierignoreSync(
  workspaceRoot: string,
  skillsDirRel = ".agents/skills",
): PrettierignorePlan {
  const applies = detectPrettierSync(workspaceRoot);
  const skillEntries = applies ? listManagedSkillEntriesSync(workspaceRoot, skillsDirRel) : [];
  return {
    applies,
    entries: [...skillEntries, ...FIXED_ENTRIES],
    fileExists: sfs.existsSync(path.join(workspaceRoot, ".prettierignore")),
  };
}

function renderBlock(entries: string[]): string {
  return [PRETTIERIGNORE_BLOCK_BEGIN, ...entries, PRETTIERIGNORE_BLOCK_END].join("\n");
}

/**
 * Pure reconcile: compute the next `.prettierignore` content from existing
 * content + managed entries. Content outside the delimited block is preserved
 * verbatim; unbalanced markers cause the whole file to be treated as
 * operator-owned (fresh block appended).
 */
export function reconcilePrettierignoreContent(
  existing: string,
  entries: string[],
): { next: string; changed: Exclude<PrettierignoreResult, "skipped"> } {
  const block = renderBlock(entries);
  if (existing === "") {
    return { next: block + "\n", changed: "written" };
  }

  const beginIdx = existing.indexOf(PRETTIERIGNORE_BLOCK_BEGIN);
  const endIdx = existing.indexOf(PRETTIERIGNORE_BLOCK_END);
  const balanced = beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx;
  if (balanced) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + PRETTIERIGNORE_BLOCK_END.length).replace(/^\r?\n/, "");
    let next = before + block + (after ? "\n" + after : "");
    if (!next.endsWith("\n")) next += "\n";
    return { next, changed: next === existing ? "unchanged" : "updated" };
  }

  const next = existing.endsWith("\n")
    ? existing + "\n" + block + "\n"
    : existing + "\n\n" + block + "\n";
  return { next, changed: "updated" };
}

/**
 * Reconcile the managed block in `.prettierignore` (async/io path — used by
 * forge upgrade and kernel-driven callers).
 */
export async function applyPrettierignore(
  workspaceRoot: string,
  plan: PrettierignorePlan,
  io?: WorkspaceIO,
): Promise<PrettierignoreResult> {
  if (!plan.applies) return "skipped";

  const fio = resolveIo(io);
  const filePath = path.join(workspaceRoot, ".prettierignore");

  let existing = "";
  try {
    existing = await fio.readFile(filePath);
  } catch {
    // File absent — create containing only the managed block
  }

  const { next, changed } = reconcilePrettierignoreContent(existing, plan.entries);
  if (changed === "unchanged") return "unchanged";
  const writeResult = await writeFileIfChanged(filePath, next, fio);
  return writeResult === "unchanged" ? "unchanged" : changed;
}

/** Sync twin for runInit — same contract via sync-fs. */
export function applyPrettierignoreSync(
  workspaceRoot: string,
  plan: PrettierignorePlan,
): PrettierignoreResult {
  if (!plan.applies) return "skipped";

  const filePath = path.join(workspaceRoot, ".prettierignore");
  const existing = sfs.existsSync(filePath) ? sfs.readFileSync(filePath, "utf8") : "";
  const { next, changed } = reconcilePrettierignoreContent(existing, plan.entries);
  if (changed === "unchanged") return "unchanged";
  sfs.writeFileSync(filePath, next, "utf8");
  return changed;
}
