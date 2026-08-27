/*
<MODULE_CONTRACT>
<purpose>TypeScript stack invariants TS-001..006 surfaced to agents (RFC-0889).</purpose>
<keywords>invariants, typescript, plugin, tsconfig, strict</keywords>
<non-goals>
  <item>Do not enforce invariants here — enforcement lives in validators.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial TypeScript stack invariants TS-001..006.</item>
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
