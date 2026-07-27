/*
<MODULE_CONTRACT>
<purpose>Trivial filesystem utilities — inlined from @warpgogol/share to avoid dependency.</purpose>
<non-goals>
  <item>Do not add non-filesystem utilities here — use dedicated utility modules.</item>
  <item>Do not introduce @warpgogol/* imports — this package must remain dependency-free.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial inline of collectFiles, fileExists from @warpgogol/share/fs.</item>
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
  // inlined from @warpgogol/share/fs to keep @webgogol/forge dependency-free (RFC-0303).
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
