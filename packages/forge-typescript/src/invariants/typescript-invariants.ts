/*
<MODULE_CONTRACT>
<purpose>TypeScript stack invariants TS-001..006 surfaced to agents as the canonical rule list (RFC-0889).</purpose>

<non-goals>
  <item>Do not enforce invariants here — enforcement lives in validators.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial TypeScript stack invariants TS-001..006.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — tail packages clean

Sweep batch 3: rewrote ~95 purposes across werkstatt-knowledge, werkstatt-shared, godot-game, phaser-game, lifecycle-core, projektarchiv-*, portal-*, billing-*, typescript (CONTRACT-02/PURPOSE-02). Real KEY_DECISIONS on 5 godot utils, non-goals on 5 CONTRACT-03 files, headers on 4 headerless files, CS-07 history literal fix on 2 files. Policy: vitest.config.ts + test-fixtures testPatterns, worker-configuration.d.ts excludedPath. All non-site/engine packages now 0 diagnostics.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
</CHANGE_SUMMARY>
*/

import type { StackInvariant } from "@warpgogol/werkstatt-shared/plugin";

export const TYPESCRIPT_INVARIANTS: StackInvariant[] = [
  {
    id: "TS-001",
    description:
      "tsconfig.base.json exists and has strict: true with consistent moduleResolution and target across workspace packages.",
    check: "ts.tsconfig.validate",
  },
  {
    id: "TS-002",
    description:
      "No packages-to-apps import boundary violations. Packages must not import from apps or missions.",
    check: "ts.import.boundaries.validate",
  },
  {
    id: "TS-003",
    description:
      "No phantom dependencies. All imported packages must be declared in package.json dependencies or devDependencies.",
    check: "ts.phantom.deps.validate",
  },
  {
    id: "TS-004",
    description:
      "package.json exports entries point to existing files. No dangling or broken export paths.",
    check: "ts.package.exports.validate",
  },
  {
    id: "TS-005",
    description:
      "Non-test source follows strict-mode conventions: no unescaped any, explicit return types on exported functions, no unjustified @ts-ignore.",
    check: "ts.strict.mode.validate",
  },
  {
    id: "TS-006",
    description:
      "Barrel exports (index.ts) do not re-export Node-only modules without a subpath export for client-side isolation.",
    check: "ts.barrel.validate",
  },
];
