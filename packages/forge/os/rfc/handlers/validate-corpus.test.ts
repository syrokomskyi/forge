import { test, expect, describe } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readRfcFrontmatter,
  readAndParseRfc,
  listRfcFiles,
} from "../frontmatter-io.ts";
import { RFC_DIR } from "../types.ts";

const WORKSPACE_ROOT = join(__dirname, "..", "..", "..", "..", "..");

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
    "every real corpus file: frontmatter identical between the two paths",
    async () => {
      const rfcDir = join(WORKSPACE_ROOT, RFC_DIR);
      const files = await listRfcFiles(rfcDir);
      expect(files.length).toBeGreaterThan(100);
      for (const f of files) {
        const slim = await readRfcFrontmatter(rfcDir, f);
        const full = await readAndParseRfc(rfcDir, f);
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
      // Sanity: the corpus is large enough that the slim path actually ran.
      expect(files.length).toBeGreaterThan(1000);
    },
    120_000,
  );
});
