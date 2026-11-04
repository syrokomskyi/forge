/*
<MODULE_CONTRACT>
<purpose>Unit tests for planPublications (RFC-1503) — the pure pending-
publication selection behind flow.digest and flow.push. Covers per-line
highest selection, semver (not string) order, superseded-on-sight at or
below the newest published, retired/published filtering, cross-line prefix
isolation, equal versions and non-semver drops.</purpose>
<non-goals>
  <item>No git fixtures — pure function, table-driven.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1503: review r1 F-7 — direct planPublications unit tests</item>
  <item>RFC-1503: review r1 — FLOW-07 on retire journal failure, journal re-read before publish, publication-order unit tests, stale catalog/inventory regen</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, it } from "vitest";

import { planPublications } from "../publication-order.ts";
import { parseVersion, type SemVer } from "../semver.ts";

interface Line {
  id: string;
  tagPrefix: string;
}

const LINES: Line[] = [
  { id: "lib", tagPrefix: "lib@" },
  { id: "lib-sub", tagPrefix: "lib-sub@" },
  { id: "repo", tagPrefix: "v" },
];

function versionOf(tag: string, lineId: string): SemVer | null {
  const line = LINES.find((l) => l.id === lineId);
  if (line === undefined || !tag.startsWith(line.tagPrefix)) return null;
  return parseVersion(tag.slice(line.tagPrefix.length));
}

const e = (tag: string, line = "lib") => ({ tag, line });
const plan = (
  candidates: Array<{ tag: string; line: string }>,
  published: string[] = [],
  retired: string[] = [],
) => planPublications(candidates, new Set(published), new Set(retired), versionOf);

describe("planPublications (RFC-1503)", () => {
  it("attempts the highest version per line — semver, not string order", () => {
    const p = plan([e("lib@9.9.0"), e("lib@9.10.0")]);
    expect(p.attempt).toEqual([{ tag: "lib@9.10.0", line: "lib" }]);
    expect(p.superseded).toEqual([{ tag: "lib@9.9.0", line: "lib", by: null }]);
  });

  it("supersedes on sight at or below the newest published version", () => {
    const p = plan([e("lib@1.0.0"), e("lib@0.9.0")], ["lib@1.1.0"]);
    expect(p.attempt).toEqual([]);
    expect(p.superseded).toEqual([
      { tag: "lib@0.9.0", line: "lib", by: "lib@1.1.0" },
      { tag: "lib@1.0.0", line: "lib", by: "lib@1.1.0" },
    ]);
  });

  it("a candidate above the newest published still attempts", () => {
    const p = plan([e("lib@1.2.0"), e("lib@1.0.0")], ["lib@1.1.0"]);
    expect(p.attempt).toEqual([{ tag: "lib@1.2.0", line: "lib" }]);
    expect(p.superseded).toEqual([{ tag: "lib@1.0.0", line: "lib", by: "lib@1.1.0" }]);
  });

  it("drops published and retired candidates entirely", () => {
    const p = plan([e("lib@1.0.0"), e("lib@1.1.0"), e("lib@1.2.0")], ["lib@1.1.0"], ["lib@1.0.0"]);
    expect(p.attempt).toEqual([{ tag: "lib@1.2.0", line: "lib" }]);
    expect(p.superseded).toEqual([]);
  });

  it("keeps lines independent — lib does not supersede lib-sub", () => {
    const p = plan([e("lib@1.0.0"), e("lib-sub@0.5.0", "lib-sub")]);
    expect(p.attempt).toEqual([
      { tag: "lib@1.0.0", line: "lib" },
      { tag: "lib-sub@0.5.0", line: "lib-sub" },
    ]);
    expect(p.superseded).toEqual([]);
  });

  it("published tags of other lines never form a bar", () => {
    const p = plan([e("lib@1.0.0")], ["lib-sub@9.9.9"]);
    expect(p.attempt).toEqual([{ tag: "lib@1.0.0", line: "lib" }]);
    expect(p.superseded).toEqual([]);
  });

  it("equal candidate versions: exactly one attempts, deterministically", () => {
    const p = plan([e("lib@1.0.0"), e("lib@1.0.0")]);
    expect(p.attempt).toEqual([{ tag: "lib@1.0.0", line: "lib" }]);
    // The duplicate is shadowed, not attempted twice.
    expect(p.superseded).toEqual([{ tag: "lib@1.0.0", line: "lib", by: null }]);
  });

  it("drops candidates whose suffix is not strict semver", () => {
    const p = plan([e("lib@next"), e("lib@1.0.0")]);
    expect(p.attempt).toEqual([{ tag: "lib@1.0.0", line: "lib" }]);
    expect(p.superseded).toEqual([]);
  });
});
