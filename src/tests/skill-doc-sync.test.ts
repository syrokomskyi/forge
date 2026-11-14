/*
<MODULE_CONTRACT>
<purpose>
Unit tests for RFC-1585 skill.doc-sync — marked-region render/drift, claim lint grammar,
doc-surface discovery, and the --write path.
</purpose>
<non-goals>
  <item>Not a registry contract test — fixtures use synthetic ForgeSkillEntry lists, never FORGE_SKILLS.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1585: initial suite — requirement AC-1 (marked-region render), AC-2 (drift detection), AC-3 (claim lint), AC-4 (check gate exit).</item>
  <item>RFC-1585: review wave — write-path corruptions, --check flag, scaffold hydration

Independent fo-review (isolation: subagent) found: empty marker pairs lost
their open tag on --write, multi-line regions collapsed line numbers, a
leading fence injected a phantom line, --check was undocumented-undeclared,
and --write exited 1 on a successful heal. Fixes: open-marker capture,
newline-preserving placeholder, empty-chunk skip, check flag, healedRegions
split (write always exits 0), dryRun/io threading, byte-exact inventory
compare on the prettier-stable canonical form, CHECK-13 delegated through
commandRegistry/invoke so the registry-integrity scan stays within its
slice cap (KNOWN_TRUNCATED_SCANS is shrink-only), record-tree exclusions
extended, two real stale claims corrected, profile templates ship empty
markers hydrated at scaffold write time. RFC amended to implemented
grammar/result/exclusions; command moved to commands.added.</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, test } from "vitest";
import * as sfs from "../utils/sync-fs.ts";
import path from "node:path";
import os from "node:os";

import type { ForgeSkillEntry } from "../registry.ts";
import {
  collectSkillDocFiles,
  hydrateSkillDocMarkers,
  lintSkillDocContent,
  lintSkillDocFiles,
  renderCountLiteral,
  renderInventoryBlock,
  runSkillDocSync,
  SKILL_DOC_MARKERS,
} from "../validators/skill-doc-sync.ts";

const skill = (name: string, category: ForgeSkillEntry["category"]): ForgeSkillEntry => ({
  name,
  category,
  invocation: "user",
  concerns: "read-only",
  dependsOn: [],
  path: `${category}/${name}/SKILL.md`,
});

// 5 skills: 3 fo + 1 shared + 1 meta — small enough to assert exact strings.
const SKILLS: ForgeSkillEntry[] = [
  skill("fo-aaa", "fo"),
  skill("fo-bbb", "fo"),
  skill("fo-ccc", "fo"),
  skill("shared-aaa", "shared"),
  skill("meta-aaa", "meta"),
];

describe("rendering (requirement AC-1)", () => {
  test("count literal decomposes the registry", () => {
    expect(renderCountLiteral(SKILLS)).toBe("5 skills (3 fo + 1 shared + 1 meta)");
  });

  test("inventory block lists every registry name grouped by category", () => {
    const block = renderInventoryBlock(SKILLS);
    expect(block).toContain("**5 skills** — 3 fo, 1 shared, 1 meta.");
    expect(block).toContain("- **fo (3):** `fo-aaa`, `fo-bbb`, `fo-ccc`");
    expect(block).toContain("- **shared (1):** `shared-aaa`");
    expect(block).toContain("- **meta (1):** `meta-aaa`");
  });
});

describe("marked regions (requirement AC-1, AC-2)", () => {
  test("fresh region passes; stale region drifts", () => {
    const good = `<!-- ${SKILL_DOC_MARKERS.count} -->${renderCountLiteral(SKILLS)}<!-- /${SKILL_DOC_MARKERS.count} -->`;
    expect(lintSkillDocContent("README.md", good, SKILLS).drift).toEqual([]);

    const stale = `<!-- ${SKILL_DOC_MARKERS.count} -->99 skills (9 fo + 9 shared + 9 meta)<!-- /${SKILL_DOC_MARKERS.count} -->`;
    const outcome = lintSkillDocContent("README.md", stale, SKILLS);
    expect(outcome.markedRegions).toBe(1);
    expect(outcome.drift).toHaveLength(1);
    expect(outcome.drift[0]!.kind).toBe("marked-region");
  });

  test("--write re-renders only inside markers and stays idempotent", () => {
    const doc = `# Title\n\n<!-- ${SKILL_DOC_MARKERS.count} -->STALE<!-- /${SKILL_DOC_MARKERS.count} -->\n\nTail 7 skills stay authored.\n`;
    // The authored tail claim drifts too — suppress it so only the region is judged.
    const clean = doc.replace("Tail 7 skills stay authored.", "Tail.");
    const once = lintSkillDocContent("README.md", clean, SKILLS, true).rewritten!;
    expect(once).toContain(
      `<!-- ${SKILL_DOC_MARKERS.count} -->${renderCountLiteral(SKILLS)}<!-- /${SKILL_DOC_MARKERS.count} -->`,
    );
    expect(once).toContain("# Title");
    const twice = lintSkillDocContent("README.md", once, SKILLS, true).rewritten!;
    expect(twice).toBe(once);
  });

  test("inventory region renders inside markers, authored text outside survives", () => {
    const doc = `Intro.\n\n<!-- ${SKILL_DOC_MARKERS.inventory} -->\nold\n<!-- /${SKILL_DOC_MARKERS.inventory} -->\n\nOutro.\n`;
    const out = lintSkillDocContent("docs/guides/skills.md", doc, SKILLS, true).rewritten!;
    expect(out).toContain(renderInventoryBlock(SKILLS));
    expect(out).toContain("Intro.");
    expect(out).toContain("Outro.");
  });
});

describe("claim lint (requirement AC-3)", () => {
  test("stale total, decomposition, and category claims all flag", () => {
    const doc = [
      "Forge ships 41 skills today.", // stale total
      "Split: 33 fo + 5 shared + 3 meta.", // stale decomposition
      "There are 9 fo skills.", // stale category
    ].join("\n");
    const drift = lintSkillDocContent("README.md", doc, SKILLS).drift;
    expect(drift.map((d) => d.kind).sort()).toEqual([
      "claim-category",
      "claim-decomposition",
      "claim-total",
    ]);
  });

  test("correct claims, exempted lines, and fenced blocks pass", () => {
    const doc = [
      "Forge ships 5 skills today.",
      "Split: 3 fo + 1 shared + 1 meta.",
      "A pack owns 7 skills. <!-- forge-skill-count:ok: project pack count -->",
      "```",
      "example says 99 skills",
      "```",
    ].join("\n");
    expect(lintSkillDocContent("README.md", doc, SKILLS).drift).toEqual([]);
  });
});

describe("surface + command runner (requirement AC-4)", () => {
  test("collectSkillDocFiles covers README variants and docs, skips record trees", () => {
    const root = sfs.mkdtempSync(path.join(os.tmpdir(), "skill-doc-sync-"));
    sfs.mkdirSync(path.join(root, "docs", "guides"), { recursive: true });
    sfs.mkdirSync(path.join(root, "docs", "rfcs"), { recursive: true });
    sfs.writeFileSync(path.join(root, "README.md"), "x");
    sfs.writeFileSync(path.join(root, "README.uk.md"), "x");
    sfs.writeFileSync(path.join(root, "AGENTS.md"), "x");
    sfs.writeFileSync(path.join(root, "docs", "guides", "a.md"), "x");
    sfs.writeFileSync(path.join(root, "docs", "rfcs", "rfc-1.md"), "x");
    sfs.writeFileSync(path.join(root, "CHANGELOG.md"), "x");
    const rel = collectSkillDocFiles(root)
      .map((f) => path.relative(root, f))
      .sort();
    expect(rel).toEqual(["AGENTS.md", "README.md", "README.uk.md", "docs/guides/a.md"]);
  });

  test("runSkillDocSync fails on drift and --write heals marked regions", async () => {
    const root = sfs.mkdtempSync(path.join(os.tmpdir(), "skill-doc-sync-"));
    const readme = path.join(root, "README.md");
    sfs.writeFileSync(
      readme,
      `<!-- ${SKILL_DOC_MARKERS.count} -->STALE<!-- /${SKILL_DOC_MARKERS.count} -->\n`,
    );
    const check = await runSkillDocSync({ flags: {} }, { workspaceRoot: root });
    expect(check.status).toBe("fail");
    expect(check.drift[0]!.kind).toBe("marked-region");

    // --write re-renders; a re-check passes with the REAL registry rendered.
    const heal = await runSkillDocSync({ flags: { write: true } }, { workspaceRoot: root });
    expect(heal.written).toEqual(["README.md"]);
    expect(sfs.readFileSync(readme, "utf8")).toContain(renderCountLiteral());
    expect((await runSkillDocSync({ flags: {} }, { workspaceRoot: root })).status).toBe("pass");
  });

  test("lintSkillDocFiles is the shared per-package composition entry", async () => {
    const root = sfs.mkdtempSync(path.join(os.tmpdir(), "skill-doc-sync-"));
    const f = path.join(root, "README.md");
    sfs.writeFileSync(f, "We ship 41 skills.");
    const outcome = await lintSkillDocFiles(root, [f], SKILLS);
    expect(outcome.drift).toHaveLength(1);
    expect(outcome.drift[0]!.file).toBe("README.md");
  });
});

describe("write-path edge cases (defect REVIEW-1585-F1/F3/F5)", () => {
  test("adjacent empty marker pair heals without deleting the open marker (F-1)", () => {
    const doc = `<!-- ${SKILL_DOC_MARKERS.count} --><!-- /${SKILL_DOC_MARKERS.count} -->\n`;
    const out = lintSkillDocContent("README.md", doc, SKILLS, true).rewritten!;
    expect(out).toContain(`<!-- ${SKILL_DOC_MARKERS.count} -->`);
    expect(out).toContain(`<!-- /${SKILL_DOC_MARKERS.count} -->`);
    expect(out).toContain(renderCountLiteral(SKILLS));
  });

  test("a file starting with a fence gains no phantom line on --write (F-3)", () => {
    const doc = "```\ncode block\n```\n\nText.\n";
    const out = lintSkillDocContent("README.md", doc, SKILLS, true).rewritten!;
    expect(out).toBe(doc);
  });

  test("claim line numbers after a multi-line region stay true (F-2)", () => {
    const doc = `Intro.\n\n<!-- ${SKILL_DOC_MARKERS.inventory} -->\nold\nold\nold\n<!-- /${SKILL_DOC_MARKERS.inventory} -->\n\nWe ship 99 skills.\n`;
    const drift = lintSkillDocContent("README.md", doc, SKILLS).drift;
    const claim = drift.find((d) => d.kind === "claim-total")!;
    expect(claim.line).toBe(9);
  });

  test("--write exits pass even when regions were healed (F-5)", async () => {
    const root = sfs.mkdtempSync(path.join(os.tmpdir(), "skill-doc-sync-"));
    sfs.writeFileSync(
      path.join(root, "README.md"),
      `<!-- ${SKILL_DOC_MARKERS.count} -->STALE<!-- /${SKILL_DOC_MARKERS.count} -->\n`,
    );
    const heal = await runSkillDocSync({ flags: { write: true } }, { workspaceRoot: root });
    expect(heal.status).toBe("pass");
    expect(heal.healedRegions).toHaveLength(1);
  });

  test("--check is the explicit form of the default", async () => {
    const root = sfs.mkdtempSync(path.join(os.tmpdir(), "skill-doc-sync-"));
    sfs.writeFileSync(path.join(root, "README.md"), "We ship 99 skills.\n");
    expect(
      (await runSkillDocSync({ flags: { check: true } }, { workspaceRoot: root })).status,
    ).toBe("fail");
  });
});

describe("scaffold hydration (requirement AC-5)", () => {
  test("empty marker pairs in templates render at create time", () => {
    const tpl = `- Skills: <!-- ${SKILL_DOC_MARKERS.count} --><!-- /${SKILL_DOC_MARKERS.count} -->\n`;
    expect(hydrateSkillDocMarkers(tpl, SKILLS)).toContain(renderCountLiteral(SKILLS));
  });
});
