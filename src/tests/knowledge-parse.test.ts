import { test, expect, describe } from "vitest";
import { parseKnowledgeFile } from "../knowledge/parse.ts";
import { serializeKnowledgeFile } from "../knowledge/serialize.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function writeTempFile(content: string, fileName: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-knowledge-"));
  const filePath = path.join(tmpDir, fileName);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("RFC-0660: knowledge file parser", () => {
  test("valid L0 entry with minimal metadata parses correctly", () => {
    const content = `<!-- knowledge-layer: L0 -->
# Q&A Log

### K-0001: First question

\`\`\`knowledge-entry
id: K-0001
layer: L0
created: 2026-08-03
status: active
\`\`\`

- **Question:** Is this a test?
- **Answer:** Yes.
`;
    const filePath = writeTempFile(content, "qa-log.md");
    try {
      const parsed = parseKnowledgeFile(filePath);
      expect(parsed.isKnowledgeAdjacent).toBe(false);
      expect(parsed.layer).toBe("L0");
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].meta.id).toBe("K-0001");
      expect(parsed.entries[0].meta.layer).toBe("L0");
      expect(parsed.entries[0].meta.status).toBe("active");
      expect(parsed.entries[0].title).toBe("First question");
      expect(parsed.entries[0].body).toContain("Is this a test?");
      expect(parsed.parseIssues).toHaveLength(0);
      expect(parsed.legacySections).toHaveLength(0);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  test("valid L2 entry with confirmations and lastConfirmedAt parses correctly", () => {
    const content = `<!-- knowledge-layer: L2 -->
# Learned Principles

### K-0001: Test principle

\`\`\`knowledge-entry
id: K-0001
layer: L2
created: 2026-08-03
lastConfirmedAt: 2026-08-03
confirmations: 3
status: active
\`\`\`

This is a confirmed principle.
`;
    const filePath = writeTempFile(content, "learned-principles.md");
    try {
      const parsed = parseKnowledgeFile(filePath);
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].meta.confirmations).toBe(3);
      expect(parsed.entries[0].meta.lastConfirmedAt).toBe("2026-08-03");
      expect(parsed.parseIssues).toHaveLength(0);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  test("L0 with forbidden confirmations produces parse issue", () => {
    const content = `<!-- knowledge-layer: L0 -->
# Q&A Log

### K-0001: Bad entry

\`\`\`knowledge-entry
id: K-0001
layer: L0
created: 2026-08-03
confirmations: 5
status: active
\`\`\`

Body.
`;
    const filePath = writeTempFile(content, "qa-log.md");
    try {
      const parsed = parseKnowledgeFile(filePath);
      expect(parsed.parseIssues.length).toBeGreaterThan(0);
      expect(parsed.parseIssues.some((i) => i.message.includes("confirmations"))).toBe(true);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  test("L2 without required confirmations produces parse issue", () => {
    const content = `<!-- knowledge-layer: L2 -->
# Learned Principles

### K-0001: Incomplete entry

\`\`\`knowledge-entry
id: K-0001
layer: L2
created: 2026-08-03
status: active
\`\`\`

Body.
`;
    const filePath = writeTempFile(content, "learned-principles.md");
    try {
      const parsed = parseKnowledgeFile(filePath);
      expect(parsed.parseIssues.length).toBeGreaterThan(0);
      expect(parsed.parseIssues.some((i) => i.message.includes("confirmations is required"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  test("malformed YAML in metadata block produces parse issue, does not throw", () => {
    const content = `<!-- knowledge-layer: L0 -->
# Q&A Log

### K-0001: Broken entry

\`\`\`knowledge-entry
id: K-0001
layer: L0
created: 2026-08-03
status: [unclosed
\`\`\`

Body.
`;
    const filePath = writeTempFile(content, "qa-log.md");
    try {
      const parsed = parseKnowledgeFile(filePath);
      expect(parsed.parseIssues.length).toBeGreaterThan(0);
      expect(parsed.entries).toHaveLength(0);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  test("knowledge-adjacent file (no K-NNNN headings, no layer preamble) returns empty result", () => {
    const content = `# About Forge

This is a knowledge-adjacent file with no entries and no layer declaration.
It should be exempt from SKILL-19/SKILL-20.
`;
    const filePath = writeTempFile(content, "forge-about.md");
    try {
      const parsed = parseKnowledgeFile(filePath);
      expect(parsed.isKnowledgeAdjacent).toBe(true);
      expect(parsed.entries).toHaveLength(0);
      expect(parsed.legacySections).toHaveLength(0);
      expect(parsed.parseIssues).toHaveLength(0);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  test("file with layer but no entries is structured-empty (not knowledge-adjacent)", () => {
    const content = `<!-- knowledge-layer: L0 -->
# Q&A Log

<!-- Entries are appended by the skill during runs. -->
`;
    const filePath = writeTempFile(content, "qa-log.md");
    try {
      const parsed = parseKnowledgeFile(filePath);
      expect(parsed.isKnowledgeAdjacent).toBe(false);
      expect(parsed.layer).toBe("L0");
      expect(parsed.entries).toHaveLength(0);
      expect(parsed.legacySections).toHaveLength(0);
      expect(parsed.parseIssues).toHaveLength(0);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  test("layer detected via filename convention when no preamble comment", () => {
    const content = `# Q&A Log

### K-0001: Test

\`\`\`knowledge-entry
id: K-0001
layer: L0
created: 2026-08-03
status: active
\`\`\`

Body.
`;
    const filePath = writeTempFile(content, "qa-log.md");
    try {
      const parsed = parseKnowledgeFile(filePath);
      expect(parsed.layer).toBe("L0");
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  test("layer comment overrides filename convention", () => {
    const content = `<!-- knowledge-layer: L2 -->
# Custom File

### K-0001: Test

\`\`\`knowledge-entry
id: K-0001
layer: L2
created: 2026-08-03
lastConfirmedAt: 2026-08-03
confirmations: 1
status: active
\`\`\`

Body.
`;
    const filePath = writeTempFile(content, "qa-log.md");
    try {
      const parsed = parseKnowledgeFile(filePath);
      expect(parsed.layer).toBe("L2");
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  test("non-existent file returns empty result without throwing", () => {
    const parsed = parseKnowledgeFile("/nonexistent/path/to/file.md");
    expect(parsed.isKnowledgeAdjacent).toBe(true);
    expect(parsed.entries).toHaveLength(0);
  });

  test("directory path returns empty result without throwing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-knowledge-dir-"));
    try {
      const parsed = parseKnowledgeFile(tmpDir);
      expect(parsed.isKnowledgeAdjacent).toBe(true);
      expect(parsed.entries).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("RFC-0660: knowledge file serializer round-trip", () => {
  test("parse → serialize → parse produces identical metadata", () => {
    const content = `<!-- knowledge-layer: L0 -->
# Q&A Log

### K-0001: First question

\`\`\`knowledge-entry
id: K-0001
layer: L0
created: 2026-08-03
status: active
\`\`\`

- **Question:** Is this a test?
- **Answer:** Yes.

### K-0002: Second question

\`\`\`knowledge-entry
id: K-0002
layer: L0
created: 2026-08-03
status: active
\`\`\`

- **Question:** Another question?
- **Answer:** Another answer.
`;
    const filePath = writeTempFile(content, "qa-log.md");
    try {
      const parsed1 = parseKnowledgeFile(filePath);
      const serialized = serializeKnowledgeFile(parsed1);
      const filePath2 = writeTempFile(serialized, "qa-log.md");
      const parsed2 = parseKnowledgeFile(filePath2);

      expect(parsed2.entries).toHaveLength(parsed1.entries.length);
      for (let i = 0; i < parsed1.entries.length; i++) {
        expect(parsed2.entries[i].meta).toEqual(parsed1.entries[i].meta);
        expect(parsed2.entries[i].title).toBe(parsed1.entries[i].title);
      }
      fs.rmSync(path.dirname(filePath2), { recursive: true, force: true });
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });
});
