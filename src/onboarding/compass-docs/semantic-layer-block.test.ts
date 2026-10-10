/*
<MODULE_CONTRACT>
<purpose>
  Unit tests for the shared semantic-layer block — marker-wrapped render shape
  and the opt-in/refresh injection contract for hand-written AGENTS.md files
  (consumer field report follow-up to RFC-1253).
</purpose>
</MODULE_CONTRACT>
*/

import { describe, it, expect } from "vitest";
import {
  SEMANTIC_LAYER_BEGIN,
  SEMANTIC_LAYER_END,
  SEMANTIC_LAYER_OPT_IN,
  ensureSemanticLayerBlock,
  injectSemanticLayerBlock,
  semanticLayerLines,
} from "./semantic-layer-block.ts";

const DOCS = ["docs/requirements.xml", "docs/technology.xml"];

describe("semanticLayerLines", () => {
  it("wraps the block in forge:begin/forge:end semantic-layer markers", () => {
    const lines = semanticLayerLines(DOCS);
    expect(lines[0]).toBe(SEMANTIC_LAYER_BEGIN);
    expect(lines[lines.length - 1]).toBe(SEMANTIC_LAYER_END);
    const text = lines.join("\n");
    expect(text).toContain("## Semantic layer — read first");
    expect(text).toContain("- `docs/requirements.xml`");
    expect(text).toContain("- `docs/technology.xml`");
  });
});

describe("injectSemanticLayerBlock", () => {
  const block = semanticLayerLines(DOCS).join("\n");

  it("expands the first bare opt-in sentinel into a full marked region", () => {
    const source = ["# Guide", "", "Intro.", "", SEMANTIC_LAYER_OPT_IN, "", "Tail.", ""].join("\n");
    const res = injectSemanticLayerBlock(source, block);
    expect(res.region).toBe("expanded");
    expect(res.changed).toBe(true);
    expect(res.content).toContain(SEMANTIC_LAYER_BEGIN);
    expect(res.content).toContain("## Semantic layer — read first");
    expect(res.content).toContain("`docs/technology.xml`");
    expect(res.content).not.toContain(SEMANTIC_LAYER_OPT_IN);
    expect(res.content).toContain("Intro.");
    expect(res.content).toContain("Tail.");
  });

  it("refreshes an existing region in place — stale content replaced, prose kept", () => {
    const stale = [
      SEMANTIC_LAYER_BEGIN,
      "",
      "## Semantic layer — read first",
      "",
      "STALE",
      "",
      SEMANTIC_LAYER_END,
    ].join("\n");
    const source = `before\n\n${stale}\n\nafter\n`;
    const res = injectSemanticLayerBlock(source, block);
    expect(res.region).toBe("refreshed");
    expect(res.changed).toBe(true);
    expect(res.content).not.toContain("STALE");
    expect(res.content).toBe(`before\n\n${block}\n\nafter\n`);
  });

  it("is idempotent — an up-to-date region reports no change", () => {
    const source = `before\n${block}\nafter\n`;
    const res = injectSemanticLayerBlock(source, block);
    expect(res.region).toBe("refreshed");
    expect(res.changed).toBe(false);
    expect(res.content).toBe(source);
  });

  it("leaves files without markers untouched", () => {
    const source = "# Guide\n\nNo markers here.\n";
    const res = injectSemanticLayerBlock(source, block);
    expect(res.region).toBe("none");
    expect(res.changed).toBe(false);
    expect(res.content).toBe(source);
  });

  it("refreshes every complete region when several exist", () => {
    const stale = `${SEMANTIC_LAYER_BEGIN}\nstale\n${SEMANTIC_LAYER_END}`;
    const source = `${stale}\nmiddle\n${stale}\n`;
    const res = injectSemanticLayerBlock(source, block);
    expect(res.region).toBe("refreshed");
    expect(res.content).toBe(`${block}\nmiddle\n${block}\n`);
  });

  it("ignores an unbalanced begin marker and still expands the opt-in sentinel", () => {
    const source = `${SEMANTIC_LAYER_BEGIN}\nnever closed\n\n${SEMANTIC_LAYER_OPT_IN}\n`;
    const res = injectSemanticLayerBlock(source, block);
    expect(res.region).toBe("expanded");
    // The dangling begin line is preserved verbatim above the new region.
    expect(res.content).toBe(`${SEMANTIC_LAYER_BEGIN}\nnever closed\n\n${block}\n`);
  });

  it("normalizes CRLF input to LF", () => {
    const source = `intro\r\n${SEMANTIC_LAYER_OPT_IN}\r\ntail\r\n`;
    const res = injectSemanticLayerBlock(source, block);
    expect(res.changed).toBe(true);
    expect(res.content).not.toContain("\r\n");
    expect(res.content).toContain(block);
  });
});

describe("ensureSemanticLayerBlock", () => {
  const block = semanticLayerLines(DOCS).join("\n");
  const FOOTER = "See the root `AGENTS.md` for project-wide rules, skills, and capabilities.";

  it("inserts the block before the footer so the footer stays last", () => {
    const source = `# Guide\n\nbody\n\n${FOOTER}\n`;
    const out = ensureSemanticLayerBlock(source, block, FOOTER);
    expect(out.indexOf("## Semantic layer — read first")).toBeLessThan(out.indexOf(FOOTER));
    expect(out.trimEnd().endsWith(FOOTER)).toBe(true);
    expect(out).toContain("body");
  });

  it("appends the block at the end when no footer is found", () => {
    const source = `# Guide\n\nbody\n`;
    const out = ensureSemanticLayerBlock(source, block, FOOTER);
    expect(out).toBe(`# Guide\n\nbody\n\n${block}\n`);
  });

  it("returns content that already carries the region unchanged", () => {
    const source = `# Guide\n\n${block}\n\n${FOOTER}\n`;
    expect(ensureSemanticLayerBlock(source, block, FOOTER)).toBe(source);
  });

  it("returns content unchanged when the block is empty", () => {
    const source = `# Guide\n\n${FOOTER}\n`;
    expect(ensureSemanticLayerBlock(source, "", FOOTER)).toBe(source);
  });
});
