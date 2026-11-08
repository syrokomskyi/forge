/*
<MODULE_CONTRACT>
<purpose>Open-mission scan for forge's flow gates (RFC-1537) — a forge-local
port of werkstatt.worktree.gate's openMissionsIn semantics: glob the
missions/<id>/mission.yaml manifests under a checkout, count `state: "open"`,
and treat an unreadable manifest as open (a corrupt live mission must never
silently pass — DNA-106). Forge cannot import the site plugin
(FORGE-AUTONOMY-01), so parity is pinned by the contract the preflight mission
check consumes.</purpose>
<non-goals>
  <item>Read-only — never mutates mission state; mission lifecycle lives in mission.* commands.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1537: open-mission scan shared by the integrate preflight's cheap-first check and the importer-materialize dirt class</item>
  <item>RFC-1537: classify regenerable worktree dirt and journal integrate refusals cheapest-first</item>
</CHANGE_SUMMARY>
*/

import { basename, dirname, join } from "node:path";

import { parse as yamlParse } from "yaml";

import type { WorkspaceIO } from "../../src/types.ts";

/**
 * Mission ids whose `missions/<id>/mission.yaml` declares `state: "open"`.
 * An unreadable manifest counts as open — same closed-shape semantics as the
 * site plugin's worktree gate. Sorted for deterministic output.
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
