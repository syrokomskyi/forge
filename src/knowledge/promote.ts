/*
<MODULE_CONTRACT>
<purpose>Cross-skill duplicate detection and promotion planning for shared knowledge layer (RFC-0663).</purpose>
<non-goals>
  <item>Do not read or write files — that is handled by parse.ts/serialize.ts and the distill skill.</item>
  <item>Do not execute promotions — that is the operator's decision inside fo-knowledge-distill.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0663: initial cross-skill duplicate detection and promotion planning.</item>
</CHANGE_SUMMARY>
*/

import type { ParsedKnowledgeFile, KnowledgeEntry, KnowledgeEntryMeta } from "./schema.ts";

const STOP_WORDS = new Set(["the", "a", "an"]);

const MIN_CONTAINMENT_LENGTH = 20;
const MIN_CONTAINMENT_RATIO = 0.6;

export interface DuplicatePair {
  a: { skill: string; entryId: string; title: string };
  b: { skill: string; entryId: string; title: string };
  normalizedTitle: string;
  kind: "exact" | "containment";
}

export interface PromotionPlan {
  sharedEntry: KnowledgeEntry;
  localPointers: Array<{ skill: string; file: string; entryId: string }>;
}

export function normalizeTitle(title: string): string {
  let result = title.toLowerCase();
  result = result.replace(/[^\p{L}\p{N}\s]/gu, " ");
  result = result.replace(/\s+/g, " ").trim();
  const words = result.split(" ").filter((w) => w.length > 0 && !STOP_WORDS.has(w));
  return words.join(" ");
}

function isExcludedEntry(meta: KnowledgeEntryMeta): boolean {
  if (meta.status === "stale" || meta.status === "archived") return true;
  if (meta.promotedTo !== undefined && meta.promotedTo !== null) return true;
  return false;
}

function isLinkedPair(metaA: KnowledgeEntryMeta, metaB: KnowledgeEntryMeta): boolean {
  if (metaA.supersedes && metaB.id && metaA.supersedes.includes(metaB.id)) return true;
  if (metaB.supersedes && metaA.id && metaB.supersedes.includes(metaA.id)) return true;
  if (metaA.promotedTo && metaB.id && metaA.promotedTo === `shared/${metaB.id}`) return true;
  if (metaB.promotedTo && metaA.id && metaB.promotedTo === `shared/${metaA.id}`) return true;
  return false;
}

interface ActiveEntry {
  skill: string;
  entry: KnowledgeEntry;
  normalizedTitle: string;
}

function collectActiveEntries(
  files: Array<{ skill: string; parsed: ParsedKnowledgeFile }>,
): ActiveEntry[] {
  const active: ActiveEntry[] = [];
  for (const file of files) {
    if (file.parsed.isKnowledgeAdjacent) continue;
    if (file.parsed.parseIssues.length > 0) continue;
    for (const entry of file.parsed.entries) {
      if (isExcludedEntry(entry.meta)) continue;
      const normalized = normalizeTitle(entry.title);
      if (normalized.length === 0) continue;
      active.push({ skill: file.skill, entry, normalizedTitle: normalized });
    }
  }
  return active;
}

export function detectDuplicatePrinciples(
  files: Array<{ skill: string; parsed: ParsedKnowledgeFile }>,
): DuplicatePair[] {
  const active = collectActiveEntries(files);
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];

      if (isLinkedPair(a.entry.meta, b.entry.meta)) continue;

      if (a.normalizedTitle === b.normalizedTitle) {
        pairs.push({
          a: { skill: a.skill, entryId: a.entry.meta.id, title: a.entry.title },
          b: { skill: b.skill, entryId: b.entry.meta.id, title: b.entry.title },
          normalizedTitle: a.normalizedTitle,
          kind: "exact",
        });
        continue;
      }

      const shorter = a.normalizedTitle.length <= b.normalizedTitle.length ? a : b;
      const longer = a.normalizedTitle.length <= b.normalizedTitle.length ? b : a;

      if (shorter.normalizedTitle.length < MIN_CONTAINMENT_LENGTH) continue;
      if (shorter.normalizedTitle.length < longer.normalizedTitle.length * MIN_CONTAINMENT_RATIO)
        continue;

      if (longer.normalizedTitle.includes(shorter.normalizedTitle)) {
        pairs.push({
          a: { skill: a.skill, entryId: a.entry.meta.id, title: a.entry.title },
          b: { skill: b.skill, entryId: b.entry.meta.id, title: b.entry.title },
          normalizedTitle: shorter.normalizedTitle,
          kind: "containment",
        });
      }
    }
  }

  return pairs;
}

export function planPromotion(
  sources: Array<{ skill: string; file: string; entry: KnowledgeEntry }>,
  merged: { title: string; body: string },
  nextSharedId: string,
  today: string,
): PromotionPlan {
  const totalConfirmations = sources.reduce((sum, s) => sum + (s.entry.meta.confirmations ?? 0), 0);

  const promotedFrom = sources.map((s) => `${s.skill}/${s.entry.meta.id}`);

  const sharedMeta: KnowledgeEntryMeta = {
    id: nextSharedId,
    layer: "L2",
    created: today,
    lastConfirmedAt: today,
    confirmations: totalConfirmations,
    status: "active",
    promotedFrom,
  };

  const sharedEntry: KnowledgeEntry = {
    meta: sharedMeta,
    title: merged.title,
    body: merged.body,
    lineStart: 0,
  };

  const localPointers = sources.map((s) => ({
    skill: s.skill,
    file: s.file,
    entryId: s.entry.meta.id,
  }));

  return { sharedEntry, localPointers };
}
