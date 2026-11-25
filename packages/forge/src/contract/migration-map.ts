/*
<MODULE_CONTRACT>
<purpose>
Migration-map coverage proof (Werkstatt RFC-1646 AC-5) — every v9 protection
family in the protection migration map is accounted for exactly once: either
mapped to a live node id in the graph or consciously removed with a recorded
reason. The map is a versioned artifact whose completeness is itself a contract
node — the map validates itself. Silent loss is impossible.
</purpose>
<non-goals>
  <item>No remediation machinery — proof emission only.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1646 (WP-3): initial coverage proof.</item>
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
import yaml from "yaml";

import type { ContractGraph } from "./graph.ts";

export interface MigrationMapEntry {
  id: string;
  protection: string;
  v9Home?: string;
  disposition: string;
  reason?: string;
  restoredBy?: string;
  /** Set when the protection is live as a v10 contract node. */
  mappedNodeId?: string;
}

export interface CoverageGap {
  entryId: string;
  reason: string;
}

export interface CoverageProof {
  complete: boolean;
  entries: number;
  mappedCount: number;
  removedCount: number;
  gaps: CoverageGap[];
}

/** Dispositions that constitute a conscious, recorded removal — never silent. */
const REMOVAL_DISPOSITIONS = new Set(["removed-at-wp8", "superseded", "transitional-host"]);

export function parseMigrationMapFull(path: string): { entries: MigrationMapEntry[]; families: MigrationFamily[] } {
  const doc = yaml.parse(readFileSync(path, "utf8")) as { entries?: MigrationMapEntry[]; families?: MigrationFamily[] };
  return { entries: doc.entries ?? [], families: doc.families ?? [] };
}

export function parseMigrationMap(path: string): MigrationMapEntry[] {
  const doc = yaml.parse(readFileSync(path, "utf8")) as { entries?: MigrationMapEntry[] };
  return doc.entries ?? [];
}

/**
 * Emit the coverage proof: every entry either names a live graph node
 * (`mappedNodeId` resolvable, or disposition `mapped` with the node present)
 * or carries a removal disposition with a non-empty reason. Anything else is
 * a gap — a silent-loss candidate the contract node refuses.
 */
export function emitCoverageProof(entries: MigrationMapEntry[], graph: ContractGraph): CoverageProof {
  const gaps: CoverageGap[] = [];
  let mappedCount = 0;
  let removedCount = 0;

  for (const entry of entries) {
    if (!entry.id || !entry.protection) {
      gaps.push({ entryId: entry.id ?? "(missing id)", reason: "entry lacks id or protection description" });
      continue;
    }
    if (entry.disposition === "mapped") {
      const nodeId = entry.mappedNodeId ?? entry.restoredBy ?? "";
      if (nodeId && graph.nodes[nodeId]) {
        mappedCount += 1;
      } else {
        gaps.push({
          entryId: entry.id,
          reason: `disposition 'mapped' but node '${nodeId || "(none named)"}' is not in the graph`,
        });
      }
      continue;
    }
    if (REMOVAL_DISPOSITIONS.has(entry.disposition)) {
      if (!entry.reason || entry.reason.trim().length === 0) {
        gaps.push({ entryId: entry.id, reason: `removal disposition '${entry.disposition}' without a recorded reason` });
      } else {
        removedCount += 1;
      }
      continue;
    }
    gaps.push({ entryId: entry.id, reason: `unknown disposition '${entry.disposition}'` });
  }

  return {
    complete: gaps.length === 0,
    entries: entries.length,
    mappedCount,
    removedCount,
    gaps,
  };
}

export interface MigrationFamily {
  id: string;
  disposition: string; // mapped | removed | superseded | pending
  nodeStatus?: string; // live | staged
  target?: string;
  reason?: string;
  note?: string;
}

/**
 * Family-granularity coverage proof (WP-3 completion instrument). Rules:
 * nothing stays pending; removed/superseded require a recorded reason;
 * mapped requires a named target; nodeStatus 'live' additionally requires the
 * target node present in the graph — a live claim that does not resolve is a
 * silent-loss inversion and fails the proof.
 */
export function emitFamiliesCoverageProof(
  families: MigrationFamily[],
  graph: ContractGraph,
): CoverageProof {
  const gaps: CoverageGap[] = [];
  let mappedCount = 0;
  let removedCount = 0;

  for (const fam of families) {
    if (!fam.id) {
      gaps.push({ entryId: "(missing id)", reason: "family lacks id" });
      continue;
    }
    if (fam.disposition === "pending" || !fam.disposition) {
      gaps.push({ entryId: fam.id, reason: "disposition pending — nothing stays pending at WP-3 closure" });
      continue;
    }
    if (fam.disposition === "removed" || fam.disposition === "superseded") {
      if (!fam.reason || fam.reason.trim().length === 0) {
        gaps.push({ entryId: fam.id, reason: `${fam.disposition} without a recorded reason` });
      } else {
        removedCount += 1;
      }
      continue;
    }
    if (fam.disposition === "mapped") {
      if (!fam.target || fam.target.trim().length === 0) {
        gaps.push({ entryId: fam.id, reason: "mapped without a named target node family" });
        continue;
      }
      if (fam.nodeStatus === "live" && !graph.nodes[fam.target]) {
        gaps.push({
          entryId: fam.id,
          reason: `claims nodeStatus live but target '${fam.target}' is not in the graph`,
        });
        continue;
      }
      mappedCount += 1;
      continue;
    }
    gaps.push({ entryId: fam.id, reason: `unknown disposition '${fam.disposition}'` });
  }

  return {
    complete: gaps.length === 0,
    entries: families.length,
    mappedCount,
    removedCount,
    gaps,
  };
}
