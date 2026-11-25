/* RFC-1646 AC-5: the graph emits coverage proof mapping every v9 protection
   family in the migration map to node ids or recorded removals. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadContractGraph } from "../src/contract/graph.ts";
import { emitCoverageProof, emitFamiliesCoverageProof, parseMigrationMap, parseMigrationMapFull, type MigrationMapEntry } from "../src/contract/migration-map.ts";
import type { ContractNode } from "../src/contract/types.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function node(id: string): ContractNode {
  return {
    id,
    kind: "validator",
    owner: "core",
    inputs: [],
    substrate: "static",
    severity: "blocking",
    executorRef: "e",
    executorVersion: "1.0.0",
    dependsOn: [],
    cachePolicy: "content-addressed",
    description: id,
  };
}

function graphWith(ids: string[]) {
  const loaded = loadContractGraph(
    [{ pluginId: "core", nodes: ids.map(node) }],
    new Set(["e"]),
  );
  if (!loaded.ok) throw new Error("fixture graph failed to load");
  return loaded.graph;
}

describe("migration-map coverage proof — AC-5", () => {
  it("complete when every entry is mapped to a live node or consciously removed", () => {
    const entries: MigrationMapEntry[] = [
      {
        id: "PMM-0001",
        protection: "rfc validation",
        disposition: "mapped",
        mappedNodeId: "core.rfc.validate",
      },
      {
        id: "PMM-0002",
        protection: "studio mission lifecycle",
        disposition: "removed-at-wp8",
        reason: "studio-private; restored by the werkstatt private plugin",
      },
    ];
    const proof = emitCoverageProof(entries, graphWith(["core.rfc.validate"]));
    expect(proof.complete).toBe(true);
    expect(proof.mappedCount).toBe(1);
    expect(proof.removedCount).toBe(1);
    expect(proof.gaps).toEqual([]);
  });

  it("flags a mapped entry whose node is absent — silent loss is impossible", () => {
    const entries: MigrationMapEntry[] = [
      { id: "PMM-0009", protection: "x", disposition: "mapped", mappedNodeId: "core.absent" },
    ];
    const proof = emitCoverageProof(entries, graphWith(["core.present"]));
    expect(proof.complete).toBe(false);
    expect(proof.gaps[0]?.entryId).toBe("PMM-0009");
  });

  it("flags removal dispositions without a recorded reason", () => {
    const entries: MigrationMapEntry[] = [
      { id: "PMM-0010", protection: "x", disposition: "superseded", reason: "" },
    ];
    const proof = emitCoverageProof(entries, graphWith([]));
    expect(proof.complete).toBe(false);
  });

  it("the real v10 migration map parses and every entry is consciously dispositioned", () => {
    const realMapPath = join(__dirname, "..", "..", "..", "docs", "migration", "protection-migration-map.yaml");
    const entries = parseMigrationMap(realMapPath);
    expect(entries.length).toBeGreaterThanOrEqual(7);
    // The graph currently carries no mapped v9-node claims; every real entry must
    // therefore be a recorded removal/transitional disposition with a reason —
    // and any 'mapped' disposition must name its target. When WP-3 registers the
    // first v9-lineage nodes this test tightens: mapped entries must resolve.
    const proof = emitCoverageProof(entries, graphWith([]));
    const mappedGaps = proof.gaps.filter((g) =>
      entries.find((e) => e.id === g.entryId)?.disposition === "mapped",
    );
    // No entry claims 'mapped' yet — the map's removal dispositions must all carry reasons.
    expect(mappedGaps).toEqual([]);
    expect(proof.removedCount).toBe(entries.length);
    expect(proof.complete).toBe(true);
  });

  it("WP-3 closure instrument: the real map's families are fully dispositioned — nothing pending, live claims resolve", () => {
    const realMapPath = join(__dirname, "..", "..", "..", "docs", "migration", "protection-migration-map.yaml");
    const { families } = parseMigrationMapFull(realMapPath);
    expect(families.length).toBeGreaterThanOrEqual(37);
    // The graph carrying the first live node registrations — FORGE-AUTONOMY's
    // live claim must resolve against it.
    const liveNodes: ContractNode[] = [
      {
        id: "core.contract.zero-werkstatt-deps",
        kind: "validator",
        owner: "core",
        inputs: [],
        substrate: "static",
        severity: "blocking",
        executorRef: "e",
        executorVersion: "1.0.0",
        dependsOn: [],
        cachePolicy: "content-addressed",
        description: "live zero-dep node",
      },
    ];
    const loaded = loadContractGraph([{ pluginId: "core", nodes: liveNodes }], new Set(["e"]));
    if (!loaded.ok) throw new Error("fixture graph failed");
    const proof = emitFamiliesCoverageProof(families, loaded.graph);
    expect(
      proof.gaps.map((g) => `${g.entryId}: ${g.reason}`),
      proof.gaps.map((g) => `${g.entryId}: ${g.reason}`).join("\n"),
    ).toEqual([]);
    expect(proof.complete).toBe(true);
    expect(families.every((f) => f.disposition !== "pending")).toBe(true);
  });
});
