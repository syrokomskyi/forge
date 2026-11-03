/*
<MODULE_CONTRACT>
<purpose>Pure pending-publication selection for flow.digest and flow.push
(RFC-1503): per package line, group the candidate tags, drop retired tags,
supersede candidates at or below the newest published version on sight
(by = that tag), and of the remainder attempt only the highest version
(lower ones are superseded-by-null until the highest publishes). Ordering
is semver-strict — 9.10.0 outranks 9.9.0.</purpose>
<non-goals>
  <item>No git or journal access — callers pass parsed tags and the
  published/retired tag sets.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1503: step 2 — planPublications pure selection</item>
  <item>RFC-1503: steps 1-5 — highest-per-line pending selection, publish-superseded/publish-retired journal events, flow.publication.retire</item>
</CHANGE_SUMMARY>
*/

import { compareVersions, type SemVer } from "./semver.ts";

export interface PublicationPlanEntry {
  tag: string;
  line: string;
}

export interface SupersededEntry extends PublicationPlanEntry {
  /** Superseding tag — null when the tag is shadowed by a higher candidate
   * that has not published yet. */
  by: string | null;
}

export interface PublicationPlan {
  attempt: PublicationPlanEntry[];
  superseded: SupersededEntry[];
}

/**
 * Partition `candidates` into the tags the next push attempts and the ones it
 * supersedes. `published` carries every tag with a `publish` journal event;
 * `retired` every tag with a `publish-retired` event. `versionOf` parses a
 * tag's version for a line (null when the tag does not match the line's
 * prefix or its suffix is not strict semver) — such tags stay out of both
 * lists, so callers surface them through the baseline/pending paths they
 * already own.
 */
export function planPublications(
  candidates: PublicationPlanEntry[],
  published: ReadonlySet<string>,
  retired: ReadonlySet<string>,
  versionOf: (tag: string, line: string) => SemVer | null,
): PublicationPlan {
  const attempt: PublicationPlanEntry[] = [];
  const superseded: SupersededEntry[] = [];

  const byLine = new Map<string, PublicationPlanEntry[]>();
  for (const c of candidates) {
    if (published.has(c.tag) || retired.has(c.tag)) continue;
    const list = byLine.get(c.line) ?? [];
    list.push(c);
    byLine.set(c.line, list);
  }

  for (const [line, list] of byLine) {
    // Newest published version of this line — the "superseded on sight" bar.
    let bar: SemVer | null = null;
    let barTag: string | null = null;
    for (const tag of published) {
      const v = versionOf(tag, line);
      if (v !== null && (bar === null || compareVersions(v, bar) > 0)) {
        bar = v;
        barTag = tag;
      }
    }

    const parsed: Array<{ entry: PublicationPlanEntry; version: SemVer }> = [];
    for (const entry of list) {
      const v = versionOf(entry.tag, line);
      if (v === null) continue;
      if (bar !== null && compareVersions(v, bar) <= 0) {
        superseded.push({ ...entry, by: barTag });
        continue;
      }
      parsed.push({ entry, version: v });
    }
    if (parsed.length === 0) continue;
    parsed.sort((a, b) => compareVersions(b.version, a.version));
    attempt.push(parsed[0]!.entry);
    for (const lower of parsed.slice(1)) {
      superseded.push({ ...lower.entry, by: null });
    }
  }

  const entrySort = (a: PublicationPlanEntry, b: PublicationPlanEntry) =>
    a.line === b.line ? a.tag.localeCompare(b.tag) : a.line.localeCompare(b.line);
  attempt.sort(entrySort);
  superseded.sort(entrySort);
  return { attempt, superseded };
}
