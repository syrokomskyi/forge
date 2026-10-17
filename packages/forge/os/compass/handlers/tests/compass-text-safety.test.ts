/*
<MODULE_CONTRACT>
<purpose>
Unit tests for os/compass/comment-safety.ts — the shared comment-terminator
contract (RFC-1322 note: RFC-1323): style detection, findCompassTerminator,
assertCompassCommentSafe (COMPASS-CS-08), neutralizeCompassText, and the
header-region truncation scan findCompassTerminatorInHeader.
</purpose>
<non-goals>
  <item>Do not test parseCompassBlocks or writer handlers — writer coverage lives in summary-record/compass-v2-contract suites.</item>
  <item>Do not put a literal comment terminator inside a comment — the strings under test stay inside string literals.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Terminator literals are built via concatenation where they would otherwise read as real comment syntax inside doc tooling.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1323: created — AC-2 coverage for the comment-safety helper across block, html, and line styles.</item>
  <item>RFC-1323: write-time comment-terminator safety — shared comment-safety seam, authored CS-08 reject, injected neutralization, header-region scan</item>
  <item>RFC-1323: review pass — still-open enclosing-style detection, per-file pre-pass parity, scaffold never-throws, docs.scaffold raw-leaf assert, trim per-file skip, CS-08 always-error severity</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect } from "vitest";
import {
  CompassCommentSafetyError,
  commentStyleCandidates,
  commentStyleFor,
  enclosingCommentStyle,
  findCompassTerminator,
  findCompassTerminatorInHeader,
  assertCompassCommentSafe,
  neutralizeCompassText,
} from "../../comment-safety.ts";

// Concatenation keeps the terminator literal out of any comment-level view.
const BLOCK_TERM = "*" + "/";
const HTML_CLOSE = "--" + ">";
const HTML_OPEN = "<!" + "--";
const NEUTRAL_SLASH = "∕"; // U+2215
const NEUTRAL_GT = "›"; // U+203A
const NEUTRAL_LT = "‹"; // U+2039

describe("comment-safety — style detection", () => {
  it("classifies extensions: ts/astro-md/gd/tscn", () => {
    expect(commentStyleFor("src/a.ts")).toBe("block");
    expect(commentStyleFor("docs/guide.md")).toBe("html");
    expect(commentStyleFor("game/scene.gd")).toBe("line");
    expect(commentStyleFor("res/world.tscn")).toBe("line");
    expect(commentStyleCandidates("src/page.astro")).toEqual(["block", "html"]);
  });

  it("detects the enclosing comment style from the source, not the extension", () => {
    const blockSource = `/*\n<TAG>\n*/\nconst x = 1;\n`;
    expect(enclosingCommentStyle(blockSource, 5, "page.astro")).toBe("block");
    const htmlSource = `${HTML_OPEN}\n<TAG>\n${HTML_CLOSE}\n<main/>\n`;
    // .astro extension says block first — the enclosing markup comment is html.
    expect(enclosingCommentStyle(htmlSource, 8, "page.astro")).toBe("html");
    // Line-prefix files always resolve to line.
    expect(enclosingCommentStyle("# hdr\nx", 0, "s.gd")).toBe("line");
    // No opener before the index → extension fallback.
    expect(enclosingCommentStyle("const x = 1;", 4, "a.ts")).toBe("block");
  });

  it("ignores a /* literal inside an html comment's prose", () => {
    const source = `${HTML_OPEN}\n${"<MODULE_CONTRACT>"}\n<purpose>documents ${"/*"} close pairs</purpose>\n${"</MODULE_CONTRACT>"}\n${HTML_CLOSE}\n`;
    const idx = source.indexOf("<purpose>");
    expect(enclosingCommentStyle(source, idx, "page.astro")).toBe("html");
    expect(enclosingCommentStyle(source, idx, "docs/guide.md")).toBe("html");
  });

  it("ignores a <!-- literal inside a block comment's prose", () => {
    const source = `/*\n${"<MODULE_CONTRACT>"}\n<purpose>discusses ${HTML_OPEN} pairs</purpose>\n${"</MODULE_CONTRACT>"}\n${BLOCK_TERM}\n`;
    const idx = source.indexOf("<purpose>");
    expect(enclosingCommentStyle(source, idx, "src/a.ts")).toBe("block");
    // .astro extension guesses block — the real enclosing comment is block too.
    expect(enclosingCommentStyle(source, idx, "page.astro")).toBe("block");
  });

  it("an opener that closed before the index does not win", () => {
    const source = `/*\nprior comment\n${BLOCK_TERM}\n${HTML_OPEN}\n${"<MODULE_CONTRACT>"}\n`;
    const idx = source.indexOf("<MODULE_CONTRACT>");
    expect(enclosingCommentStyle(source, idx, "page.astro")).toBe("html");
  });

  it("a /* in .md prose is literal text — never opens a comment", () => {
    const source = `note about ${"/*"} markers\n${HTML_OPEN}\n${"<MODULE_CONTRACT>"}\n`;
    const idx = source.indexOf("<MODULE_CONTRACT>");
    expect(enclosingCommentStyle(source, idx, "docs/guide.md")).toBe("html");
  });
});

describe("comment-safety — findCompassTerminator", () => {
  it("block style detects only the block close", () => {
    expect(findCompassTerminator(`a ${BLOCK_TERM} b`, "block")).toBe(BLOCK_TERM);
    expect(findCompassTerminator(`a ${HTML_CLOSE} b`, "block")).toBeNull();
    expect(findCompassTerminator("clean text", "block")).toBeNull();
  });

  it("html style detects the close and the nested open", () => {
    expect(findCompassTerminator(`a ${HTML_CLOSE} b`, "html")).toBe(HTML_CLOSE);
    expect(findCompassTerminator(`a ${HTML_OPEN} b`, "html")).toBe(HTML_OPEN);
    expect(findCompassTerminator(`a ${BLOCK_TERM} b`, "html")).toBeNull();
  });

  it("line style has no embedded terminator (AC-2)", () => {
    expect(findCompassTerminator(`a ${BLOCK_TERM} b ${HTML_CLOSE}`, "line")).toBeNull();
    expect(findCompassTerminator("anything at all", "line")).toBeNull();
  });
});

describe("comment-safety — assertCompassCommentSafe", () => {
  it("passes clean text and throws COMPASS-CS-08 with file+block context", () => {
    expect(() => assertCompassCommentSafe("glob `src/<dir>/*.ts`", "block")).not.toThrow();
    try {
      assertCompassCommentSafe(`glob src${BLOCK_TERM}*`, "block", {
        file: "src/a.ts",
        block: "CHANGE_SUMMARY",
      });
      expect.unreachable("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CompassCommentSafetyError);
      const e = err as CompassCommentSafetyError;
      expect(e.ruleId).toBe("COMPASS-CS-08");
      expect(e.substring).toBe(BLOCK_TERM);
      expect(e.file).toBe("src/a.ts");
      expect(e.block).toBe("CHANGE_SUMMARY");
      expect(e.message).toContain("src/a.ts");
      expect(e.fixHint.length).toBeGreaterThan(0);
    }
  });
});

describe("comment-safety — neutralizeCompassText", () => {
  it("rewrites each terminator to the non-terminating glyph and reports the change", () => {
    const block = neutralizeCompassText(`glob src${BLOCK_TERM}*`, "block");
    expect(block.text).toBe(`glob src*${NEUTRAL_SLASH}*`);
    expect(block.neutralized).toBe(true);

    const html = neutralizeCompassText(`a ${HTML_CLOSE} b ${HTML_OPEN}`, "html");
    expect(html.text).toBe(`a --${NEUTRAL_GT} b ${NEUTRAL_LT}!--`);
    expect(html.neutralized).toBe(true);
  });

  it("is idempotent — a second pass is a no-op", () => {
    const once = neutralizeCompassText(`x ${BLOCK_TERM} y`, "block");
    const twice = neutralizeCompassText(once.text, "block");
    expect(twice.text).toBe(once.text);
    expect(twice.neutralized).toBe(false);
  });

  it("does not touch text that lacks the style's terminator", () => {
    const res = neutralizeCompassText(`a ${BLOCK_TERM} b`, "html");
    expect(res.text).toBe(`a ${BLOCK_TERM} b`);
    expect(res.neutralized).toBe(false);
  });
});

describe("comment-safety — findCompassTerminatorInHeader (CS-08 scan)", () => {
  const MC_OPEN = "<" + "MODULE_CONTRACT>";
  const MC_CLOSE = "</" + "MODULE_CONTRACT>";
  const CS_OPEN = "<" + "CHANGE_SUMMARY>";
  const CS_CLOSE = "</" + "CHANGE_SUMMARY>";

  it("fires on a terminator landing while inner tags are unclosed", () => {
    const source = `/*\n${MC_OPEN}\n<purpose>references packages${BLOCK_TERM}wg/*\n</purpose>\n${MC_CLOSE}\n*/\n`;
    const hit = findCompassTerminatorInHeader(source, "src/a.ts");
    expect(hit).not.toBeNull();
    expect(hit!.substring).toBe(BLOCK_TERM);
    expect(hit!.line).toBe(3);
  });

  it("does not fire on a well-formed header — the close after all tags is legal", () => {
    const source = `/*\n${MC_OPEN}\n<purpose>clean</purpose>\n${MC_CLOSE}\n${CS_OPEN}\n  <item>RFC-1: x</item>\n${CS_CLOSE}\n*/\nexport const x = 1;\n`;
    expect(findCompassTerminatorInHeader(source, "src/a.ts")).toBeNull();
  });

  it("ignores legal html comment pairs in a markdown header region", () => {
    const source = `${HTML_OPEN}\n${MC_OPEN}\n<purpose>doc</purpose>\n${MC_CLOSE}\n${HTML_CLOSE}\n\n${HTML_OPEN} a section note ${HTML_CLOSE}\n`;
    expect(findCompassTerminatorInHeader(source, "docs/guide.md")).toBeNull();
  });

  it("fires on an html-close truncating a markdown Compass header", () => {
    const source = `${HTML_OPEN}\n${CS_OPEN}\n  <item>bad ${HTML_CLOSE}</item>\n${CS_CLOSE}\n${HTML_CLOSE}\n`;
    const hit = findCompassTerminatorInHeader(source, "docs/guide.md");
    expect(hit).not.toBeNull();
    expect(hit!.substring).toBe(HTML_CLOSE);
  });

  it("line-style files never report — no embedded terminator exists", () => {
    const source = `# ${MC_OPEN}\n# <purpose>x ${BLOCK_TERM} y ${HTML_CLOSE}</purpose>\n# ${MC_CLOSE}\n`;
    expect(findCompassTerminatorInHeader(source, "s.gd")).toBeNull();
  });

  it("ignores corruption markers beyond the header region bound", () => {
    const pad = Array.from({ length: 130 }, () => "// pad").join("\n");
    const source = `/* ok */\n${pad}\n${MC_OPEN} truncated ${BLOCK_TERM}\n`;
    expect(findCompassTerminatorInHeader(source, "src/a.ts")).toBeNull();
  });

  it("does not fire on a nested <!-- inside an otherwise clean html comment", () => {
    const source = `${HTML_OPEN}\n${HTML_OPEN} stray nested opener — harmless\n${MC_OPEN}\n<purpose>x</purpose>\n${MC_CLOSE}\n${HTML_CLOSE}\n`;
    expect(findCompassTerminatorInHeader(source, "docs/guide.md")).toBeNull();
  });

  it("does not fire on a JSDoc line carrying a bare <item> — no structural parent", () => {
    const source = `/** <item> documents the <item> tag ${BLOCK_TERM}/\nexport const x = 1;\n`;
    expect(findCompassTerminatorInHeader(source, "src/a.ts")).toBeNull();
  });

  it("ignores a-->b-shaped code tokens outside comments", () => {
    const source = `/*\n${MC_OPEN}\n<purpose>clean</purpose>\n${MC_CLOSE}\n${BLOCK_TERM}\nconst arrow = a${HTML_CLOSE}b;\n`;
    expect(findCompassTerminatorInHeader(source, "src/a.ts")).toBeNull();
  });

  it("an escaped <\\/close> does not close a real open tag — a later terminator still fires", () => {
    const source = `/*\n${MC_OPEN}\n<purpose>text</purpose>\nescaped <\\/${"MODULE_CONTRACT"}\n${BLOCK_TERM}\n`;
    const hit = findCompassTerminatorInHeader(source, "src/a.ts");
    expect(hit).not.toBeNull();
    expect(hit!.substring).toBe(BLOCK_TERM);
  });

  it("fires on the second comment when the first closed legally — state does not leak", () => {
    const source = `/*\n${MC_OPEN}\n<purpose>clean</purpose>\n${MC_CLOSE}\n${BLOCK_TERM}\n\n/*\n${CS_OPEN}\n<item>oops ${BLOCK_TERM}</item>\n`;
    const hit = findCompassTerminatorInHeader(source, "src/a.ts");
    expect(hit).not.toBeNull();
    expect(hit!.substring).toBe(BLOCK_TERM);
  });

  it(".astro: a phantom /* inside frontmatter code cannot hide a corrupt html header", () => {
    const source = `---\nconst marker = "${"/*"}";\n---\n${HTML_OPEN}\n${CS_OPEN}\n  <item>bad ${HTML_CLOSE}</item>\n${CS_CLOSE}\n${HTML_CLOSE}\n<main/>\n`;
    const hit = findCompassTerminatorInHeader(source, "src/page.astro");
    expect(hit).not.toBeNull();
    expect(hit!.substring).toBe(HTML_CLOSE);
  });

  it("a --- line while Compass tags are open preserves state — the terminator still fires", () => {
    const source = `${HTML_OPEN}\n${MC_OPEN}\n<purpose>text</purpose>\n---\n${HTML_CLOSE}\n`;
    const hit = findCompassTerminatorInHeader(source, "docs/guide.md");
    expect(hit).not.toBeNull();
    expect(hit!.substring).toBe(HTML_CLOSE);
  });

  it("a --- line inside a tag-less comment resets state — a later close is a legal no-op", () => {
    const source = `/* a note\n---\n${BLOCK_TERM}\nexport const x = 1;\n`;
    expect(findCompassTerminatorInHeader(source, "src/a.ts")).toBeNull();
  });
});
