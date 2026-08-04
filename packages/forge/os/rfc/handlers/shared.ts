/*
<MODULE_CONTRACT>
<purpose>Shared helpers for RFC handler commands — date utils, invariant ID loading, FS path checks, command bucket parsing.</purpose>
<non-goals>
  <item>Do not implement command handlers; those live in sibling files.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0303: extracted shared helpers from handlers.ts into handlers/shared.ts.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveForgeRoot } from "../../../src/config/forge-config.ts";
import { RFC_TEMPLATE_FILE, RFC_TEMPLATE_FALLBACK_FILE } from "../types.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";

export function toIsoDate(date: Date): string {
  return date.toISOString().split("T")[0]!;
}

const DNA_DOC = "docs/architecture-dna.md";
const AP_DOC = "packages/os/site-kernel/docs/anti-patterns.md";
export const DNA_DOCS = [DNA_DOC];
export const AP_DOCS = [AP_DOC];

/** Parse `## <PREFIX>-N` headings from the given docs and return the set of N. */
export async function loadInvariantIds(
  workspaceRoot: string,
  relPaths: string[],
  prefix: string,
): Promise<Set<number>> {
  const ids = new Set<number>();
  const re = new RegExp(`^##\\s+${prefix}-(\\d+)\\b`, "gm");
  for (const rel of relPaths) {
    try {
      const src = await fs.readFile(path.join(workspaceRoot, rel), "utf-8");
      for (const m of src.matchAll(re)) ids.add(parseInt(m[1]!, 10));
    } catch {
      // Doc not present at this path — try the next candidate.
    }
  }
  return ids;
}

/**
 * Whether a "File system responsibilities" path is a concrete, checkable file.
 * Skips glob/placeholder/prose entries that rfc.check must not `fs.access` verbatim:
 * `apps/*`, `apps/<app>/…`, `{lang}`, `**`, or descriptive phrases with spaces.
 */
export function isLiteralFsPath(p: string): boolean {
  if (/[*<>{}]/.test(p)) return false; // globs / placeholders
  if (/\s/.test(p)) return false; // prose ("Every generator module")
  if (!p.includes("/") && !p.includes(".")) return false; // bare words
  return true;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function commandBuckets(fm: Record<string, unknown>): {
  proposed: string[];
  added: string[];
  changed: string[];
  removed: string[];
} {
  const commands = fm["commands"];
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    return { proposed: [], added: [], changed: [], removed: [] };
  }
  const record = commands as Record<string, unknown>;
  return {
    proposed: stringArray(record["proposed"]),
    added: stringArray(record["added"]),
    changed: stringArray(record["changed"]),
    removed: stringArray(record["removed"]),
  };
}

export type { ParsedRfc };

// ---------------------------------------------------------------------------
// RFC template resolver — finds rfc-0000-template.md from project docs/rfcs/
// first (canonical location, mirroring ADR pattern), then falls back to the
// forge package copy (npm consumers without a project-level template).
// ---------------------------------------------------------------------------

export function resolveRfcTemplate(workspaceRoot: string): string {
  // 1. Try project-level docs/rfcs/rfc-0000-template.md (canonical, like ADR)
  const projectPath = path.join(workspaceRoot, RFC_TEMPLATE_FILE);
  if (existsSync(projectPath)) return projectPath;

  // 2. Try forge root (monorepo or npm-installed) — fallback copy
  try {
    const forgeRoot = resolveForgeRoot(workspaceRoot);
    const p = path.join(forgeRoot, RFC_TEMPLATE_FALLBACK_FILE);
    if (existsSync(p)) return p;
  } catch {
    // forge root not resolvable — fall through to module-relative search
  }

  // 3. Fallback: walk up from this module's location to find os/rfc/rfc-0000-template.md
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "os", "rfc", "rfc-0000-template.md");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `RFC template not found. Tried ${RFC_TEMPLATE_FILE} relative to ${workspaceRoot}, forge root, and module-relative search from ${here}.`,
  );
}
