/*
<MODULE_CONTRACT>
<purpose>The committed hooks surface of the fixed branch model (RFC-1486) —
the managed pre-commit block markers, the canonical block text, the asset
reader and the insert/replace/verify operations shared by flow.check
(FLOW-03) and flow.install (steps 6/7).</purpose>
<non-goals>
  <item>No branch-model policy — this file only owns block text and file bytes.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The managed block is always inserted directly after the shebang so it runs before any custom hook body that might exec something else first.</item>
  <item>The asset is read via import.meta.url so the same bytes are checked (FLOW-03), installed (flow.install) and parity-tested — one source of truth, no formatter may rewrite it.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1486: step 3 — managed-block constants and guard file helpers</item>
  <item>RFC-1486: step 3 — flow.check with FLOW-01..05 + managed-block helpers</item>
  <item>RFC-1486: step 5 — forge-flow module registration + dual CLI/kernel wiring</item>
  <item>RFC-1486: review r1 — committed-state adoption gate, uncommitted-hook committedness, step-failure trail, idempotency declaration, lazy asset resolution</item>
</CHANGE_SUMMARY>
*/

import { existsSync, readFileSync } from "../../src/utils/sync-fs.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GUARD_BEGIN_MARKER = "# >>> forge flow guard (managed by flow.install) >>>";
export const GUARD_END_MARKER = "# <<< forge flow guard <<<";
export const GUARD_INVOKE_LINE =
  'sh "$(git rev-parse --show-toplevel)/hooks/flow-guard.sh" pre-commit || exit 1';

/** The managed block as committed into hooks/pre-commit (with trailing newline). */
export const MANAGED_BLOCK = `${GUARD_BEGIN_MARKER}\n${GUARD_INVOKE_LINE}\n${GUARD_END_MARKER}\n`;

export const ADOPTION_COMMIT_SUBJECT = "chore(flow): install the fixed branch model guard";

export const HOOKS_DIR = "hooks";
export const GUARD_FILE = "hooks/flow-guard.sh";
export const PRECOMMIT_FILE = "hooks/pre-commit";

const GUARD_ASSET_RELATIVE = join("os", "flow", "assets", "flow-guard.sh");

/**
 * Absolute path of the shipped guard asset — resolved lazily, never at
 * module-eval time: under the kernel's vite module loader `import.meta.url`
 * is not a `file:` URL, so the file-scheme probe is guarded and the walk-up
 * falls back to `process.cwd()` (checking both `os/flow/assets` and the
 * monorepo `packages/forge/os/flow/assets` layout).
 */
export function resolveGuardAssetPath(): string {
  const seeds: string[] = [];
  try {
    const url = new URL(import.meta.url);
    if (url.protocol === "file:") {
      const moduleDir = dirname(fileURLToPath(url));
      const adjacent = join(moduleDir, "assets", "flow-guard.sh");
      if (existsSync(adjacent)) return adjacent;
      seeds.push(moduleDir);
    }
  } catch {
    // import.meta.url unavailable or non-file — fall through to cwd search.
  }
  seeds.push(process.cwd());
  for (const seed of seeds) {
    let dir = seed;
    for (let i = 0; i < 10; i += 1) {
      for (const base of [dir, join(dir, "packages", "forge")]) {
        const candidate = join(base, GUARD_ASSET_RELATIVE);
        if (existsSync(candidate)) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    `flow guard asset not found — searched ${GUARD_ASSET_RELATIVE} from the module dir and ${process.cwd()}`,
  );
}

let cachedGuardAssetPath: string | undefined;

/** Bytes of the shipped guard — the FLOW-03 byte-compare reference. */
export function readGuardAsset(): string {
  cachedGuardAssetPath ??= resolveGuardAssetPath();
  return readFileSync(cachedGuardAssetPath, "utf8");
}

/** True when the pre-commit content carries a complete managed block. */
export function hasManagedBlock(content: string): boolean {
  return (
    content.includes(GUARD_BEGIN_MARKER) &&
    content.includes(GUARD_END_MARKER) &&
    content.includes(GUARD_INVOKE_LINE)
  );
}

/**
 * Fresh pre-commit content: shebang plus the managed block.
 */
export function renderManagedPreCommit(): string {
  return `#!/bin/sh\n${MANAGED_BLOCK}`;
}

/**
 * Merge the managed block into existing pre-commit content.
 * - No block yet → insert directly after the shebang line (or prepend when
 *   the file has no shebang).
 * - A block exists with a different body → replace the text between the
 *   markers, keep the markers' position.
 * - Identical → returns null (caller reports `skipped`).
 */
export function mergeManagedBlock(content: string): string | null {
  const begin = content.indexOf(GUARD_BEGIN_MARKER);
  const end = content.indexOf(GUARD_END_MARKER);
  if (begin !== -1 && end !== -1 && begin < end) {
    const existing = content.slice(begin, end + GUARD_END_MARKER.length);
    if (existing === MANAGED_BLOCK.trimEnd()) return null;
    return (
      content.slice(0, begin) +
      MANAGED_BLOCK.trimEnd() +
      content.slice(end + GUARD_END_MARKER.length)
    );
  }
  if (content.startsWith("#!")) {
    const newline = content.indexOf("\n");
    const head = newline === -1 ? content : content.slice(0, newline + 1);
    const rest = newline === -1 ? "" : content.slice(newline + 1);
    return `${head}${MANAGED_BLOCK}${rest}`;
  }
  return `${MANAGED_BLOCK}${content}`;
}

/**
 * Byte-compare an installed file with the shipped asset. `read` is the
 * caller's file access (working tree or `git show HEAD:<file>` for bare
 * repositories); null means the file is absent.
 */
export async function guardFileMatches(
  read: () => Promise<string | null>,
): Promise<boolean> {
  const installed = await read();
  return installed !== null && installed === readGuardAsset();
}
