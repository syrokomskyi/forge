/*
<MODULE_CONTRACT>
<purpose>Open-mission scan for forge's flow gates — globs missions/<id>/mission.yaml
under a checkout, counts `state: "open"`, treats an unreadable manifest as open
(a corrupt live work unit must never silently pass). Transitional host-layout
awareness retained in core: inert in repos without a missions/ tree. Target state
per Werkstatt RFC-1645 is a host-port extension registered by the host's plugin
(extraction at program WP-4/5/8) — recorded in the protection migration map.
</purpose>
<non-goals>
  <item>Read-only — never mutates mission state; mission lifecycle operations are studio-private and did not transfer to core.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { basename, dirname, join } from "node:path";

import { parse as yamlParse } from "yaml";

import type { WorkspaceIO } from "../../src/types.ts";

/**
 * Mission ids whose `missions/<id>/mission.yaml` declares `state: "open"`.
 * An unreadable manifest counts as open. Sorted for deterministic output.
 */
export async function openMissionsIn(
  worktree: string,
  io: WorkspaceIO,
): Promise<string[]> {
  const manifests = await io.glob("missions/*/mission.yaml", { cwd: worktree });
  const open: string[] = [];
  for (const rel of manifests) {
    try {
      const parsed = yamlParse(await io.readFile(join(worktree, rel))) as {
        state?: unknown;
      } | null;
      if (parsed?.state === "open") {
        open.push(basename(dirname(rel)));
      }
    } catch {
      open.push(basename(dirname(rel)));
    }
  }
  return open.sort();
}
