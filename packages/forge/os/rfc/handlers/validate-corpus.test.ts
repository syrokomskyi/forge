/*
<MODULE_CONTRACT>
<purpose>
Unit tests for the frontmatter-only corpus read path — readRfcFrontmatter bounded-head semantics, >64 KiB full-parse fallback, error parity, and AC-9 frontmatter parity across the real corpus (RFC-1489).
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1489: frontmatter-only corpus read coverage.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readRfcFrontmatter,
  readAndParseRfc,
  listRfcFiles,
} from "../frontmatter-io.ts";


describe("readRfcFrontmatter — AC-5/AC-6 corpus reads", () => {
  const fmDoc = (id: string, extra = ""): string =>
    `---\nid: ${id}\nstatus: draft\n${extra}---\n\n# Body ${id}\n\nSome body text.\n`;

  test("returns frontmatter with an empty body (AC-5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-io-"));
    try {
      writeFileSync(join(dir, "rfc-0001-a.md"), fmDoc("RFC-0001"));
      const res = await readRfcFrontmatter(dir, "rfc-0001-a.md");
      expect(res && "parsed" in res ? res.parsed.frontmatter["id"] : undefined).toBe("RFC-0001");
      expect(res && "parsed" in res ? res.parsed.body : "x").toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to full parse when the closing fence exceeds the bound (AC-6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-io-big-"));
    try {
      // A >64 KiB frontmatter block: the bounded head cannot see the fence.
      const big = `note: "${"y".repeat(70 * 1024)}"\n`;
      writeFileSync(join(dir, "rfc-0002-big.md"), fmDoc("RFC-0002", big));
      const res = await readRfcFrontmatter(dir, "rfc-0002-big.md");
      expect(res && "parsed" in res ? res.parsed.frontmatter["id"] : undefined).toBe("RFC-0002");
      // Full-parse fallback populates the body.
      expect(res && "parsed" in res ? res.parsed.body : "").toContain("# Body RFC-0002");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("small file without a closing fence yields empty frontmatter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-io-nofm-"));
    try {
      writeFileSync(join(dir, "rfc-0003-bare.md"), "# No frontmatter\n\nbody\n");
      const res = await readRfcFrontmatter(dir, "rfc-0003-bare.md");
      expect(res && "parsed" in res ? res.parsed.frontmatter : { x: 1 }).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed YAML produces the same error variant as full parse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-io-bad-"));
    try {
      writeFileSync(join(dir, "rfc-0004-bad.md"), "---\nid: [unclosed\n---\nbody\n");
      const slim = await readRfcFrontmatter(dir, "rfc-0004-bad.md");
      const full = await readAndParseRfc(dir, "rfc-0004-bad.md");
      expect(slim && "error" in slim).toBe(true);
      expect(full && "error" in full).toBe(true);
      expect(slim && "error" in slim ? slim.error : "").toBe(
        full && "error" in full ? full.error : "",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AC-9 — frontmatter-only corpus produces the same rule input as full parse", () => {
  test(
    "every corpus file: frontmatter identical between the two paths",
    async () => {
      // v10 (RFC-1649): the authoring monorepo carries no hundred-file RFC
      // corpus of its own — the v9 test scanned werkstatt's. The parity
      // property is generic, so the corpus is synthesized here: diverse YAML
      // shapes exercising exactly the scan/parse divergence surface (nested
      // maps, flow + block sequences, multiline scalars, unicode, quotes,
      // empty + malformed frontmatter).
      const dir = mkdtempSync(join(tmpdir(), "fm-corpus-"));
      try {
        const shapes: Array<[string, string]> = [
          ["simple", "id: RFC-1001\nstatus: draft\n"],
          ["nested-map", "id: RFC-1002\nmeta:\n  author: a\n  tags:\n    x: 1\n"],
          ["flow-seq", "id: RFC-1003\nrefs: [RFC-0001, RFC-0002]\n"],
          ["block-seq", "id: RFC-1004\nrefs:\n  - RFC-0001\n  - RFC-0002\n"],
          ["multiline-literal", "id: RFC-1005\nnote: |\n  line one\n  line two\n"],
          ["multiline-folded", "id: RFC-1006\nnote: >\n  fold one\n  fold two\n"],
          ["unicode", "id: RFC-1007\ntitle: Ünïcödé —  тест\n"],
          ["quoted", 'id: RFC-1008\ntitle: "quoted: with colon"\n'],
          ["single-quoted", "id: RFC-1009\ntitle: 'single ''quote'''\n"],
          ["numbers", "id: RFC-1010\nversion: 2\nratio: 0.5\n"],
          ["booleans", "id: RFC-1011\nactive: true\narchived: false\n"],
          ["null-value", "id: RFC-1012\nsuperseded-by: null\n"],
          ["empty-fm", ""],
          ["deep-nesting", "id: RFC-1014\na:\n  b:\n    c:\n      d: [1, 2, { e: f }]\n"],
          ["colon-in-value", "id: RFC-1015\nurl: https://example.com/x\n"],
          ["dashes-in-key", "id: RFC-1016\nx-custom-key: v\n"],
          ["long-value", `id: RFC-1017\nnote: "${"y".repeat(2000)}"\n`],
          ["mixed-types", "id: RFC-1018\nn: 1\ns: text\nb: true\nl:\n  - 1\n  - two\n"],
          ["indented-seq", "id: RFC-1019\nitems:\n    - one\n    - two\n"],
          ["comment-in-fm", "id: RFC-1020\n# a comment\nstatus: draft\n"],
          ["date-ish", "id: RFC-1021\ncreated: 2026-11-25\n"],
          ["empty-string", 'id: RFC-1022\nnote: ""\n'],
          ["anchor-free-dup", "id: RFC-1023\nx: a\ny: a\nz: a\n"],
          ["malformed-unclosed", "id: [unclosed\n"],
        ];
        for (const [name, fm] of shapes) {
          writeFileSync(join(dir, `rfc-${name}.md`), `---\n${fm}---\n\n# Body\n\ntext\n`);
        }
        const files = await listRfcFiles(dir);
        expect(files.length).toBeGreaterThan(15);
        for (const f of files) {
          const slim = await readRfcFrontmatter(dir, f);
          const full = await readAndParseRfc(dir, f);
          if (!slim || !full) continue;
          if ("error" in slim || "error" in full) {
            expect("error" in slim, `error parity for ${f}`).toBe("error" in full);
            continue;
          }
          // Referential rules consume only this map — identical input means an
          // identical violation set.
          expect(slim.parsed.frontmatter, `frontmatter parity for ${f}`).toEqual(
            full.parsed.frontmatter,
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
