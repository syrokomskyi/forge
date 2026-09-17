/*
<MODULE_CONTRACT>
<purpose>Trivial fs filesystem utilities — inlined from @warpgogol/share to avoid dependency.</purpose>
<non-goals>
  <item>Do not add non-filesystem utilities here — use dedicated utility modules.</item>
  <item>Do not introduce @warpgogol/* imports — this package must remain dependency-free.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Helpers are inlined copies, not imports — dependency-free beats sharing a package for trivial functions.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — packages/forge + services clean

Sweep batch 2: real KEY_DECISIONS on 10 files, expanded purposes (CONTRACT-02/PURPOSE-02), headers on mission/index + gen-upstreams, sanitizeItemText in summary.record (literal Compass tags corrupted history), excludedPaths for wrangler types, test-fixtures testPattern. forge+services now 0 diagnostics under --mode error.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
</CHANGE_SUMMARY>
*/

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface CollectFilesOptions {
  extensions?: string[];
  ignore?: (name: string) => boolean;
  withDirs?: boolean;
}

function defaultIgnore(name: string): boolean {
  return name.startsWith("-") || name.startsWith("old-");
}

export async function collectFiles(
  root: string,
  options: CollectFilesOptions = {},
): Promise<string[]> {
  const { extensions, ignore = defaultIgnore, withDirs = false } = options;
  const results: string[] = [];

  // fs.walk.lint: allow — this is the canonical collectFiles implementation,
  // inlined from @warpgogol/werkstatt-shared/node/fs to keep @warpgogol/forge dependency-free (RFC-0303).
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (ignore(entry.name)) continue;

      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (withDirs) results.push(full);
        await walk(full);
        continue;
      }

      if (!entry.isFile()) continue;

      if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;

      results.push(full);
    }
  }

  await walk(root);
  return results;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
