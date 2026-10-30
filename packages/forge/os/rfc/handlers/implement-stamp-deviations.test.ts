/*
<MODULE_CONTRACT>
<purpose>
RFC-1454: RFC-IMP-15 gate tests — a committed review report's amend
deviation blocks the stamp while absent from the RFC's `## Deviations`
section (AC-1); recorded deviations pass (AC-2); malformed entries block
(AC-3). Covers report-level and entry-level rfc binding, fix-only
reports, null reviewsDir, and fenced-example immunity.
</purpose>
<non-goals>
  <item>Do not exercise real git — OriginGit is stubbed with ls-tree/show responses.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1454: RFC-IMP-15 deviation gate unit tests.</item>
  <item>RFC-1454: review deviations recorded in the RFC — IMP-15 gate, V-49 provenance, skill contract</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, it } from "vitest";
import { evaluateDeviationGate, parseDeviationsSection } from "./implement-stamp-deviations.ts";
import type { OriginGit } from "../verification-origin.ts";

const RFC_ID = "RFC-9001";
const REVIEWS_DIR = "docs/reviews";

const report = (fm: Record<string, unknown>): string => {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n# review\n`;
};

/** Fake OriginGit — serves ls-tree for the reviews dir and show for each file. */
function fakeGit(files: Record<string, string>): OriginGit {
  return {
    run: async (args: string[]) => {
      if (args[0] === "ls-tree") return Object.keys(files).join("\n") + "\n";
      if (args[0] === "show") {
        const path = String(args[1] ?? "").replace(/^HEAD:/, "");
        return files[path] ?? null;
      }
      return null;
    },
  };
}

const DEVIATIONS_YAML = (entries: string) =>
  `designDeviations:\n${entries}`;

const gate = (files: Record<string, string>, body: string, reviewsDir: string | null = REVIEWS_DIR) =>
  evaluateDeviationGate({
    rfcId: RFC_ID,
    strippedRfcBody: body,
    git: fakeGit(files),
    reviewsDir,
  });

const amendReport = (id = "DEV-1") =>
  `---\nreviewId: REVIEW-1\nrfcId: ${RFC_ID}\n${DEVIATIONS_YAML(`  - id: ${id}\n    summary: x\n    resolution: amend\n`) }---\n\n# review\n`;

describe("RFC-IMP-15 — amend deviations must land in ## Deviations", () => {
  it("AC-1: blocks when an amend deviation is absent from the RFC", async () => {
    const res = await gate(
      { "docs/reviews/code/r1.md": amendReport() },
      "# RFC-9001\n",
    );
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.rule).toBe("RFC-IMP-15");
    expect(res.errors[0]!.message).toContain("DEV-1");
    expect(res.errors[0]!.message).toContain("REVIEW-1");
  });

  it("AC-2: passes when the deviation is recorded in ## Deviations", async () => {
    const res = await gate(
      { "docs/reviews/code/r1.md": amendReport() },
      "# RFC-9001\n\n## Deviations\n\n- DEV-1 (review REVIEW-1): both layouts demote headings.\n",
    );
    expect(res.errors).toHaveLength(0);
  });

  it("AC-3: blocks on a malformed entry (missing resolution)", async () => {
    const malformed = `---\nreviewId: REVIEW-1\nrfcId: ${RFC_ID}\ndesignDeviations:\n  - id: DEV-1\n    summary: x\n---\n\n# review\n`;
    const res = await gate(
      { "docs/reviews/code/r1.md": malformed },
      "# RFC-9001\n\n## Deviations\n\n- DEV-1 (review REVIEW-1): recorded.\n",
    );
    expect(res.errors.some((e) => e.message.includes("malformed"))).toBe(true);
  });

  it("AC-3: blocks on an unknown resolution", async () => {
    const malformed = `---\nreviewId: REVIEW-1\nrfcId: ${RFC_ID}\ndesignDeviations:\n  - id: DEV-1\n    resolution: maybe\n---\n\n# review\n`;
    const res = await gate({ "docs/reviews/code/r1.md": malformed }, "# RFC-9001\n");
    expect(res.errors.some((e) => e.message.includes("malformed"))).toBe(true);
  });

  it("fix deviations do not block", async () => {
    const fix = `---\nreviewId: REVIEW-1\nrfcId: ${RFC_ID}\ndesignDeviations:\n  - id: DEV-1\n    resolution: fix\n---\n\n# review\n`;
    const res = await gate({ "docs/reviews/code/r1.md": fix }, "# RFC-9001\n");
    expect(res.errors).toHaveLength(0);
  });

  it("reports without designDeviations and a null reviewsDir pass", async () => {
    const res = await gate(
      { "docs/reviews/code/r1.md": report({ reviewId: "REVIEW-1", rfcId: RFC_ID }) },
      "# RFC-9001\n",
    );
    expect(res.errors).toHaveLength(0);
    const noDir = await gate({ "docs/reviews/code/r1.md": amendReport() }, "# RFC-9001\n", null);
    expect(noDir.errors).toHaveLength(0);
  });

  it("deviations bound to another RFC via entry.rfc do not apply", async () => {
    const other = `---\nreviewId: REVIEW-1\nrfcId: ${RFC_ID}\ndesignDeviations:\n  - id: DEV-1\n    rfc: RFC-9999\n    resolution: amend\n---\n\n# review\n`;
    const res = await gate({ "docs/reviews/code/r1.md": other }, "# RFC-9001\n");
    expect(res.errors).toHaveLength(0);
  });

  it("multi-RFC reports bind via entry.rfc when report rfcId differs", async () => {
    const multi = `---\nreviewId: REVIEW-1\nrfcId: RFC-0001\ndesignDeviations:\n  - id: DEV-1\n    rfc: ${RFC_ID}\n    resolution: amend\n---\n\n# review\n`;
    const res = await gate({ "docs/reviews/code/r1.md": multi }, "# RFC-9001\n");
    expect(res.errors).toHaveLength(1);
  });
});

describe("parseDeviationsSection", () => {
  it("ignores the grammar example inside a fenced block (caller strips)", () => {
    // The caller passes a fence-stripped body; fenced example content never arrives.
    const { entries, malformed } = parseDeviationsSection(
      "## Deviations\n\n- DEV-1 (review REVIEW-1): recorded.\n\nsome prose\n",
    );
    expect(entries).toEqual([{ id: "DEV-1", reviewId: "REVIEW-1" }]);
    expect(malformed).toHaveLength(0);
  });

  it("flags list lines that do not match the entry grammar", () => {
    const { malformed } = parseDeviationsSection(
      "## Deviations\n\n- just a note without provenance\n",
    );
    expect(malformed).toHaveLength(1);
  });
});
