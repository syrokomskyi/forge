import { test, expect, describe } from "vitest";
import { parseKnowledgeFile } from "../knowledge/parse.ts";
import { serializeKnowledgeFile } from "../knowledge/serialize.ts";
import { knowledgeEntryMetaSchema, type KnowledgeEntryMeta } from "../knowledge/schema.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import fc from "fast-check";

function buildMarkdown(entries: KnowledgeEntryMeta[], layer: string, fileName: string): string {
  const parts: string[] = [`<!-- knowledge-layer: ${layer} -->`, `# ${fileName}`, ""];
  for (const meta of entries) {
    parts.push(`### ${meta.id}: Test entry`);
    parts.push("");
    parts.push("```knowledge-entry");
    const fields: [string, unknown][] = [
      ["id", meta.id],
      ["layer", meta.layer],
      ["created", meta.created],
    ];
    if (meta.lastConfirmedAt !== undefined) fields.push(["lastConfirmedAt", meta.lastConfirmedAt]);
    if (meta.confirmations !== undefined) fields.push(["confirmations", meta.confirmations]);
    if (meta.expiresAt !== undefined) fields.push(["expiresAt", meta.expiresAt]);
    if (meta.supersedes !== undefined) fields.push(["supersedes", meta.supersedes]);
    if (meta.promotedTo !== undefined) fields.push(["promotedTo", meta.promotedTo]);
    fields.push(["status", meta.status]);
    for (const [key, value] of fields) {
      if (value === null) {
        parts.push(`${key}: null`);
      } else if (Array.isArray(value)) {
        parts.push(`${key}: [${value.join(", ")}]`);
      } else {
        parts.push(`${key}: ${value}`);
      }
    }
    parts.push("```");
    parts.push("");
    parts.push("Body text for this entry.");
    parts.push("");
  }
  return parts.join("\n");
}

function writeTempFile(content: string, fileName: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-knowledge-pbt-"));
  const filePath = path.join(tmpDir, fileName);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("RFC-0660: property-based round-trip", () => {
  test("parse → serialize → parse produces identical metadata for L0 entries", () => {
    const l0EntryArbitrary = fc.integer({ min: 1, max: 9999 }).map((n) => ({
      id: `K-${String(n).padStart(4, "0")}`,
      layer: "L0" as const,
      created: "2026-08-03",
      status: "active" as const,
    })) as fc.Arbitrary<KnowledgeEntryMeta>;

    fc.assert(
      fc.property(fc.array(l0EntryArbitrary, { minLength: 1, maxLength: 5 }), (entries) => {
        const markdown = buildMarkdown(entries, "L0", "qa-log.md");
        const filePath1 = writeTempFile(markdown, "qa-log.md");
        try {
          const parsed1 = parseKnowledgeFile(filePath1);
          const serialized = serializeKnowledgeFile(parsed1);
          const filePath2 = writeTempFile(serialized, "qa-log.md");
          try {
            const parsed2 = parseKnowledgeFile(filePath2);
            expect(parsed2.entries.length).toBe(parsed1.entries.length);
            for (let i = 0; i < parsed1.entries.length; i++) {
              expect(parsed2.entries[i].meta).toEqual(parsed1.entries[i].meta);
            }
          } finally {
            fs.rmSync(path.dirname(filePath2), { recursive: true, force: true });
          }
        } finally {
          fs.rmSync(path.dirname(filePath1), { recursive: true, force: true });
        }
      }),
      { numRuns: 50 },
    );
  });

  test("parse → serialize → parse produces identical metadata for L2 entries", () => {
    const l2EntryArbitrary = fc.integer({ min: 1, max: 9999 }).map((n) => ({
      id: `K-${String(n).padStart(4, "0")}`,
      layer: "L2" as const,
      created: "2026-08-03",
      lastConfirmedAt: "2026-08-03",
      confirmations: n % 100,
      status: "active" as const,
    })) as fc.Arbitrary<KnowledgeEntryMeta>;

    fc.assert(
      fc.property(fc.array(l2EntryArbitrary, { minLength: 1, maxLength: 5 }), (entries) => {
        const markdown = buildMarkdown(entries, "L2", "learned-principles.md");
        const filePath1 = writeTempFile(markdown, "learned-principles.md");
        try {
          const parsed1 = parseKnowledgeFile(filePath1);
          const serialized = serializeKnowledgeFile(parsed1);
          const filePath2 = writeTempFile(serialized, "learned-principles.md");
          try {
            const parsed2 = parseKnowledgeFile(filePath2);
            expect(parsed2.entries.length).toBe(parsed1.entries.length);
            for (let i = 0; i < parsed1.entries.length; i++) {
              expect(parsed2.entries[i].meta).toEqual(parsed1.entries[i].meta);
            }
          } finally {
            fs.rmSync(path.dirname(filePath2), { recursive: true, force: true });
          }
        } finally {
          fs.rmSync(path.dirname(filePath1), { recursive: true, force: true });
        }
      }),
      { numRuns: 50 },
    );
  });

  test("schema validates well-formed L0 entry", () => {
    const validL0 = {
      id: "K-0001",
      layer: "L0",
      created: "2026-08-03",
      status: "active",
    };
    expect(knowledgeEntryMetaSchema.safeParse(validL0).success).toBe(true);
  });

  test("schema validates well-formed L2 entry with confirmations", () => {
    const validL2 = {
      id: "K-0001",
      layer: "L2",
      created: "2026-08-03",
      lastConfirmedAt: "2026-08-03",
      confirmations: 3,
      status: "active",
    };
    expect(knowledgeEntryMetaSchema.safeParse(validL2).success).toBe(true);
  });

  test("schema rejects L0 with confirmations", () => {
    const invalidL0 = {
      id: "K-0001",
      layer: "L0",
      created: "2026-08-03",
      confirmations: 5,
      status: "active",
    };
    const result = knowledgeEntryMetaSchema.safeParse(invalidL0);
    expect(result.success).toBe(false);
  });

  test("schema rejects L2 without confirmations", () => {
    const invalidL2 = {
      id: "K-0001",
      layer: "L2",
      created: "2026-08-03",
      status: "active",
    };
    const result = knowledgeEntryMetaSchema.safeParse(invalidL2);
    expect(result.success).toBe(false);
  });
});
