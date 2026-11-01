/*
<MODULE_CONTRACT>
<purpose>Property tests for RFC-1481 local knowledge ID allocation; generated IDs must remain unique and outside the shared namespace.</purpose>
<non-goals>
  <item>Not a contract source of truth — RFC-1481 and the allocator own the behavior.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1481: test first — verify local ID allocation over varied existing ordinal sets.</item>
  <item>RFC-1481: add knowledge collision resolution and surfacing

Add the explicit resolver, namespace-aware parsing and validation, safe reference remapping, doctor/upgrade hints, and regression coverage.</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node
import { test, expect } from "vitest";
import fc from "fast-check";
import { allocateLocalKnowledgeId } from "../knowledge/sync.ts";

test("allocated local knowledge IDs are unique and increase beyond all existing local ordinals", () => {
  // A new ID must be outside the existing set and greater than its maximum
  // local ordinal, independent of input ordering and upstream K IDs.
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.integer({ min: 1, max: 9998 }), { maxLength: 200 }),
      (ordinals) => {
        const existing = ordinals.map((n) => `L-K-${String(n).padStart(4, "0")}`);
        const next = allocateLocalKnowledgeId(["K-9999", ...existing]);
        const nextOrdinal = Number(next.slice("L-K-".length));
        const maxExisting = Math.max(0, ...ordinals);
        expect(next).toMatch(/^L-K-\d{4}$/);
        expect(nextOrdinal).toBeGreaterThan(maxExisting);
        expect(existing).not.toContain(next);
      },
    ),
  );
});
