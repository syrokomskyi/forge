/*
<MODULE_CONTRACT>
<purpose>Round-trip serializer for knowledge files — reconstructs markdown from ParsedKnowledgeFile (RFC-0660).</purpose>
<non-goals>
  <item>Do not parse — that is handled by parse.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0660: initial round-trip serializer for structured knowledge entries.</item>
  <item>RFC-0663: added promotedFrom to FIELD_ORDER for shared-layer provenance.</item>
</CHANGE_SUMMARY>
*/

import type { ParsedKnowledgeFile, KnowledgeEntryMeta } from "./schema.ts";

const FIELD_ORDER: (keyof KnowledgeEntryMeta)[] = [
  "id",
  "layer",
  "created",
  "lastConfirmedAt",
  "confirmations",
  "expiresAt",
  "supersedes",
  "promotedTo",
  "promotedFrom",
  "status",
];

function formatYamlValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.join(", ")}]`;
  }
  if (typeof value === "string") return value;
  return String(value);
}

function serializeMeta(meta: KnowledgeEntryMeta): string {
  const lines: string[] = ["```knowledge-entry"];
  for (const field of FIELD_ORDER) {
    const value = meta[field];
    if (value === undefined) continue;
    lines.push(`${field}: ${formatYamlValue(value)}`);
  }
  lines.push("```");
  return lines.join("\n");
}

export function serializeKnowledgeFile(parsed: ParsedKnowledgeFile): string {
  const parts: string[] = [];

  if (parsed.preamble) {
    parts.push(parsed.preamble);
  }

  for (const entry of parsed.entries) {
    parts.push(`### ${entry.meta.id}: ${entry.title}`);
    parts.push("");
    parts.push(serializeMeta(entry.meta));
    if (entry.body) {
      parts.push("");
      parts.push(entry.body);
    }
  }

  for (const legacy of parsed.legacySections) {
    parts.push(legacy.text);
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}
