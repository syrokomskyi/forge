/*
<MODULE_CONTRACT>
<purpose>Property-based test for the spec.live.merge idempotency law (RFC-1230,
AC-10 / DNA-101): merge(merge(spec, rfc), rfc) ≡ merge(spec, rfc) — a second
merge of the same RFC is already-merged and byte-identical — and
force∘force ≡ force — a forced re-merge stabilizes after one application.</purpose>
<non-goals>
  <item>Do not test rebuild or validate — covered by their own test files.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1230: initial PBT for the merge idempotency law.</item>
  <item>RFC-1230: step 1 — idempotent spec.live.merge with --force

Add the already-merged gate (history[] membership → no-op, byte-identical file) and --force surgical re-merge (drop all (RFC-XXXX) sections + history entries, replay the RFC, append one entry). Shared parsing/serialization helpers extracted to live-spec-shared.ts; operation enum gains "already-merged". PBT covers merge∘merge ≡ merge.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com></item>
</CHANGE_SUMMARY>
*/

import { describe, test, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import fc from "fast-check";
import { runSpecLiveMerge } from "./live-spec-merge.ts";
import { escapeRegex } from "./live-spec-shared.ts";
import type { ForgeRuntimeContext } from "../../src/types.ts";

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: {
      section: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
    },
    dryRun: false,
    outputFormat: "json",
  };
}

// Heading text: single-line, non-empty after trim, never carrying an (RFC-XXXX)
// marker — namespaceHeadings leaves already-marked headings alone, which would
// make sections belong to a different RFC id.
const headingTextArb = fc
  .string({
    unit: fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_".split(""),
    ),
    minLength: 1,
    maxLength: 40,
  })
  .filter((s) => s.trim().length > 0 && !/\(RFC-\d{4}\)/.test(s));

const bodyLineArb = fc
  .string({
    unit: fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.,;:!?()[]".split(""),
    ),
    maxLength: 80,
  })
  .filter((s) => !s.trimStart().startsWith("#"));

const sectionArb = fc.record({
  heading: headingTextArb,
  body: fc.array(bodyLineArb, { maxLength: 6 }).map((lines) => lines.join("\n")),
});

function rfcSource(id: string, design: string): string {
  return `---
id: ${id}
title: "PBT RFC ${id}"
status: implemented
kind: architecture
scope: workspace
owners:
  - architecture
reviewers:
  - human:test
createdAt: 2026-08-06
updatedAt: 2026-08-06
implementedAt: 2026-08-06
versionBump: patch
liveSpec: true
packagesImpacted:
  - packages/forge
commands:
  proposed: []
  added: []
  changed: []
  removed: []
appsImpacted: []
successSignals: []
nonGoals: []
---

# ${id}

## Design

${design}

## Rollout

Done.
`;
}

describe("spec.live.merge idempotency law (AC-10)", () => {
  test("merge(merge(spec, rfc), rfc) ≡ merge(spec, rfc)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(sectionArb, { minLength: 1, maxLength: 6 }),
        fc.boolean(), // seed a spec via a different RFC first → exercise the existing-spec path
        async (sections, seedWithOther) => {
          const design = sections
            .map((s) => `### ${s.heading}\n\n${s.body}`)
            .join("\n\n");

          const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-pbt-"));
          try {
            const rfcDir = path.join(tmpDir, "docs/rfcs");
            await fs.mkdir(rfcDir, { recursive: true });
            await fs.writeFile(
              path.join(rfcDir, "rfc-9001-pbt.md"),
              rfcSource("RFC-9001", design),
            );
            if (seedWithOther) {
              await fs.writeFile(
                path.join(rfcDir, "rfc-9002-seed.md"),
                rfcSource("RFC-9002", "### Seed\n\nseed body."),
              );
              await runSpecLiveMerge(
                { argv: [], flags: { id: "RFC-9002" } },
                makeContext(tmpDir),
              );
            }

            const mergeInput = { argv: [], flags: { id: "RFC-9001" } };
            const first = await runSpecLiveMerge(mergeInput, makeContext(tmpDir));
            const specFile = path.join(tmpDir, "docs/specs/live/forge.md");
            const afterFirst = await fs.readFile(specFile, "utf-8");

            const second = await runSpecLiveMerge(mergeInput, makeContext(tmpDir));
            const afterSecond = await fs.readFile(specFile, "utf-8");

            expect(first.exitCode).toBe(0);
            expect(second.exitCode).toBe(0);
            expect(second.data?.operation).toBe("already-merged");
            expect(second.data?.deltas).toEqual([]);
            expect(afterSecond).toBe(afterFirst);
          } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  test("force(force(spec)) ≡ force(spec) — forced re-merge stabilizes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(sectionArb, { minLength: 1, maxLength: 6 }),
        async (sections) => {
          const design = sections
            .map((s) => `### ${s.heading}\n\n${s.body}`)
            .join("\n\n");

          const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-pbt-"));
          try {
            const rfcDir = path.join(tmpDir, "docs/rfcs");
            await fs.mkdir(rfcDir, { recursive: true });
            await fs.writeFile(
              path.join(rfcDir, "rfc-9001-pbt.md"),
              rfcSource("RFC-9001", design),
            );

            await runSpecLiveMerge(
              { argv: [], flags: { id: "RFC-9001" } },
              makeContext(tmpDir),
            );
            const specFile = path.join(tmpDir, "docs/specs/live/forge.md");

            const forceInput = {
              argv: [],
              flags: { id: "RFC-9001", force: true },
            };
            const force1 = await runSpecLiveMerge(forceInput, makeContext(tmpDir));
            const afterForce1 = await fs.readFile(specFile, "utf-8");

            const force2 = await runSpecLiveMerge(forceInput, makeContext(tmpDir));
            const afterForce2 = await fs.readFile(specFile, "utf-8");

            expect(force1.exitCode).toBe(0);
            expect(force2.exitCode).toBe(0);
            expect(force1.data?.operation).toBe("modified");
            expect(force2.data?.operation).toBe("modified");
            // Exactly one namespaced section set per heading and one history entry.
            expect(afterForce2).toBe(afterForce1);
            // Each namespaced heading occurs exactly as often as the RFC's
            // design repeats that heading text (headings are trimmed on parse).
            // Count heading lines — substring matching would let "a (RFC-9001)"
            // match inside "aa (RFC-9001)".
            for (const s of sections) {
              const namespaced = `${s.heading.trim()} (RFC-9001)`;
              const occurrences = (afterForce2.match(
                new RegExp(`^### ${escapeRegex(namespaced)}$`, "gm"),
              ) ?? []).length;
              const expected = sections.filter(
                (x) => x.heading.trim() === s.heading.trim(),
              ).length;
              expect(occurrences).toBe(expected);
            }
          } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
