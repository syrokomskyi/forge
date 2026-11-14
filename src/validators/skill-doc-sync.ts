/*
<MODULE_CONTRACT>
<purpose>
RFC-1585: derive skill counts/inventory in docs from FORGE_SKILLS instead of
hand-maintained literals. `--write` re-renders marked regions
(`<!-- forge:skills-count -->` / `<!-- forge:skills-inventory -->`) in place;
`--check` (default) fails on marked-region drift and on skill-count claims
outside markers that contradict the registry.
</purpose>
<non-goals>
  <item>Does not rewrite prose outside marked regions — claim drift is reported, never auto-fixed.</item>
  <item>Does not count project skill packs (RFC-0539) — the rendered registry is FORGE_SKILLS; pack-specific count claims carry an exemption marker.</item>
</non-goals>
<KEY_DECISIONS>
  <item>Paired open/close HTML markers (forge:custom discipline, RFC-1153) — content between markers is generated, everything outside is authored.</item>
  <item>Claim grammar is intentionally narrow (three literal forms) — ambiguous prose is never flagged; authors exempt intentional claims with a same-line `<!-- forge-skill-count:ok: <reason> -->` marker.</item>
  <item>Historical record trees (rfcs/adrs/audits/reviews/plans/queues, changelogs, generated docs) are excluded from the claim lint — dated statements quote the registry of their day.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1585: initial implementation — markers, render, drift check, claim lint, doc surface discovery.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import * as sfs from "../utils/sync-fs.ts";
import { writeFileIfChanged } from "../utils/fs-idempotent.ts";
import { FORGE_SKILLS } from "../registry.ts";
import type { ForgeSkillEntry } from "../registry.ts";

// ─── Markers ────────────────────────────────────────────────────────────────

export const SKILL_DOC_MARKERS = {
  inventory: "forge:skills-inventory",
  count: "forge:skills-count",
} as const;

export type SkillDocMarkerKind = keyof typeof SKILL_DOC_MARKERS;

/** `<!-- forge-skill-count:ok: <reason> -->` exempts one line from the claim lint. */
export const SKILL_CLAIM_EXEMPT_RE = /forge-skill-count:ok(?:\s*:\s*[^\n]*?)?\s*(?:-->\s*)?$/;

/** Paired `<!-- forge:X -->…<!-- /forge:X -->` region. */
const REGION_RE =
  /<!--\s*forge:(skills-inventory|skills-count)\s*-->([\s\S]*?)<!--\s*\/forge:\1\s*-->/g;

// ─── Registry projection ────────────────────────────────────────────────────

export interface SkillCounts {
  total: number;
  fo: number;
  shared: number;
  meta: number;
}

export function skillCounts(skills: ForgeSkillEntry[] = FORGE_SKILLS): SkillCounts {
  const by = (category: ForgeSkillEntry["category"]) =>
    skills.filter((s) => s.category === category).length;
  return { total: skills.length, fo: by("fo"), shared: by("shared"), meta: by("meta") };
}

/** Canonical one-line literal used by the `skills-count` marker and the claim lint. */
export function renderCountLiteral(skills: ForgeSkillEntry[] = FORGE_SKILLS): string {
  const c = skillCounts(skills);
  return `${c.total} skills (${c.fo} fo + ${c.shared} shared + ${c.meta} meta)`;
}

/** Canonical inventory block for the `skills-inventory` marker. */
export function renderInventoryBlock(skills: ForgeSkillEntry[] = FORGE_SKILLS): string {
  const c = skillCounts(skills);
  const names = (category: ForgeSkillEntry["category"]) =>
    skills
      .filter((s) => s.category === category)
      .map((s) => s.name)
      .sort()
      .map((n) => `\`${n}\``)
      .join(", ");
  return [
    `**${c.total} skills** — ${c.fo} fo, ${c.shared} shared, ${c.meta} meta.`,
    ``,
    `- **fo (${c.fo}):** ${names("fo")}`,
    `- **shared (${c.shared}):** ${names("shared")}`,
    `- **meta (${c.meta}):** ${names("meta")}`,
  ].join("\n");
}

function renderRegion(kind: SkillDocMarkerKind, skills: ForgeSkillEntry[]): string {
  return kind === "count" ? renderCountLiteral(skills) : renderInventoryBlock(skills);
}

// ─── Drift model ────────────────────────────────────────────────────────────

export interface SkillDocDrift {
  file: string;
  line: number;
  kind:
    "marked-region" | "claim-total" | "claim-decomposition" | "claim-category" | "inline-inventory";
  expected: string;
  found: string;
}

export interface SkillDocSyncResult {
  command: "forge.skill.doc-sync";
  status: "pass" | "fail";
  filesScanned: number;
  markedRegions: number;
  drift: SkillDocDrift[];
  written: string[];
}

// ─── Claim grammar (unmarked regions only) ──────────────────────────────────

/** `34 fo + 4 shared + 3 meta` — ordered decomposition, all three required. */
const CLAIM_DECOMPOSITION_RE = /(\d+)\s*fo\D{0,10}?\+\s*(\d+)\s*shared\D{0,10}?\+\s*(\d+)\s*meta/g;
/** `41 skills`, `41 skill definitions`, `41 built-in skills`, `41 forge skills`. */
const CLAIM_TOTAL_RE =
  /\b(\d+)\s+(?:built-in\s+|forge(?:-managed)?\s+)?skill\s*(?:definitions|s)?\b/gi;
/** `34 fo skills`, `4 shared skills`, `3 meta skills`. */
const CLAIM_CATEGORY_RE = /\b(\d+)\s+(fo|shared|meta)\s+skills?\b/g;

const FENCE_RE = /^```/;

interface LintOutcome {
  drift: SkillDocDrift[];
  markedRegions: number;
  rewritten?: string;
}

/** Strip marked regions and fenced blocks, then lint remaining lines for stale skill-count claims. */
export function lintSkillDocContent(
  relFile: string,
  content: string,
  skills: ForgeSkillEntry[] = FORGE_SKILLS,
  write = false,
): LintOutcome {
  const counts = skillCounts(skills);
  const drift: SkillDocDrift[] = [];
  let markedRegions = 0;

  // 1. Marked regions — compare or rewrite. Fenced code blocks are doc
  // examples, never live regions — regions are scanned per unfenced chunk.
  const chunks: { text: string; fenced: boolean }[] = [];
  {
    let fenced = false;
    let buf: string[] = [];
    for (const l of content.split("\n")) {
      if (FENCE_RE.test(l.trimStart())) {
        chunks.push({ text: buf.join("\n"), fenced });
        buf = [l];
        fenced = !fenced;
        continue;
      }
      buf.push(l);
    }
    chunks.push({ text: buf.join("\n"), fenced });
  }

  const processRegion = (
    whole: string,
    kind: string,
    inner: string,
    offset: number,
    chunkText: string,
    lineBase: number,
  ): string => {
    markedRegions++;
    const line = lineBase + chunkText.slice(0, offset).split("\n").length - 1;
    const marker = kind === "skills-inventory" ? "inventory" : "count";
    const rendered = renderRegion(marker as SkillDocMarkerKind, skills);
    if (marker === "inventory" && !inner.includes("\n") && !whole.includes("\n")) {
      // Inline inventory marker would corrupt layout — flag, never rewrite.
      drift.push({
        file: relFile,
        line,
        kind: "inline-inventory",
        expected: "inventory markers on their own lines",
        found: whole.slice(0, 80),
      });
      return whole;
    }
    const expectedInner = marker === "count" ? rendered : `\n${rendered}\n`;
    if (inner.trim() !== rendered.trim()) {
      drift.push({
        file: relFile,
        line,
        kind: "marked-region",
        expected: rendered.split("\n")[0]!,
        found: inner.trim().split("\n")[0]!.slice(0, 80) || "(empty)",
      });
    }
    if (!write) return whole;
    const open = whole.slice(0, whole.indexOf(inner));
    const close = `<!-- /forge:${kind} -->`;
    return `${open}${expectedInner}${close}`;
  };

  const rewrittenParts: string[] = [];
  let lineBase = 1;
  for (const chunk of chunks) {
    if (chunk.fenced) {
      rewrittenParts.push(chunk.text);
    } else {
      rewrittenParts.push(
        chunk.text.replace(REGION_RE, (whole, kind, inner, offset) =>
          processRegion(whole, kind, inner, offset, chunk.text, lineBase),
        ),
      );
    }
    lineBase += chunk.text.split("\n").length;
  }
  const rewritten = rewrittenParts.join("\n");

  // 2. Claim lint — only outside marked regions and fenced blocks.
  const body = (write ? rewritten : content)
    .replace(REGION_RE, " ")
    .split("\n")
    .map((l, i) => ({ line: i + 1, text: l }));
  let inFence = false;
  for (const { line, text } of body) {
    if (FENCE_RE.test(text.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence || SKILL_CLAIM_EXEMPT_RE.test(text)) continue;

    for (const m of text.matchAll(CLAIM_DECOMPOSITION_RE)) {
      const [fo, shared, meta] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (fo !== counts.fo || shared !== counts.shared || meta !== counts.meta) {
        drift.push({
          file: relFile,
          line,
          kind: "claim-decomposition",
          expected: `${counts.fo} fo + ${counts.shared} shared + ${counts.meta} meta`,
          found: m[0].trim(),
        });
      }
    }
    for (const m of text.matchAll(CLAIM_CATEGORY_RE)) {
      const cat = m[2] as "fo" | "shared" | "meta";
      if (Number(m[1]) !== counts[cat]) {
        drift.push({
          file: relFile,
          line,
          kind: "claim-category",
          expected: `${counts[cat]} ${cat} skills`,
          found: m[0].trim(),
        });
      }
    }
    for (const m of text.matchAll(CLAIM_TOTAL_RE)) {
      if (Number(m[1]) !== counts.total) {
        drift.push({
          file: relFile,
          line,
          kind: "claim-total",
          expected: `${counts.total} skills`,
          found: m[0].trim(),
        });
      }
    }
  }

  return { drift, markedRegions, rewritten: write ? rewritten : undefined };
}

// ─── Doc surface ────────────────────────────────────────────────────────────

/** Historical record trees quote the registry of their day — never claim-linted. */
export const SKILL_DOC_SURFACE_EXCLUDE_RES = [
  /(^|\/)CHANGELOG\.md$/,
  /\.generated\.md$/,
  /(^|\/)docs\/(rfcs|adrs|audits|reviews|plans|queues|archive)\//,
];

/** Collect the claim-lint surface under a package root: README*.md, AGENTS.md, docs/**. */
export function collectSkillDocFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: sfs.Dirent[];
    try {
      entries = sfs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name.endsWith(".md")) files.push(abs);
    }
  };
  const docsDir = path.join(root, "docs");
  if (sfs.existsSync(docsDir)) walk(docsDir);
  for (const name of sfs.existsSync(root) ? sfs.readdirSync(root) : []) {
    if (/^README.*\.md$/.test(name) || name === "AGENTS.md") files.push(path.join(root, name));
  }
  return files
    .filter((f) => {
      const rel = path.relative(root, f).split(path.sep).join("/");
      return !SKILL_DOC_SURFACE_EXCLUDE_RES.some((re) => re.test(rel));
    })
    .sort();
}

/** Lint a concrete file list — shared by the command and the package-health composition. */
export async function lintSkillDocFiles(
  root: string,
  files: string[],
  skills: ForgeSkillEntry[] = FORGE_SKILLS,
  write = false,
): Promise<{ drift: SkillDocDrift[]; markedRegions: number; written: string[] }> {
  const drift: SkillDocDrift[] = [];
  const written: string[] = [];
  let markedRegions = 0;
  for (const abs of files) {
    let content: string;
    try {
      content = sfs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const rel = path.relative(root, abs).split(path.sep).join("/");
    const outcome = lintSkillDocContent(rel, content, skills, write);
    drift.push(...outcome.drift);
    markedRegions += outcome.markedRegions;
    if (write && outcome.rewritten !== undefined && outcome.rewritten !== content) {
      await writeFileIfChanged(abs, outcome.rewritten);
      written.push(rel);
    }
  }
  return { drift, markedRegions, written };
}

// ─── Command runner ─────────────────────────────────────────────────────────

interface SkillDocSyncFlags {
  write?: boolean;
  files?: string;
  root?: string;
}

export async function runSkillDocSync(
  input: unknown,
  context: unknown,
): Promise<SkillDocSyncResult> {
  const flags =
    (input as { flags?: SkillDocSyncFlags } | undefined)?.flags ??
    (input as SkillDocSyncFlags) ??
    {};
  const ctx = (context ?? {}) as { workspaceRoot?: string };
  const root = flags.root
    ? path.resolve(ctx.workspaceRoot ?? process.cwd(), flags.root)
    : (ctx.workspaceRoot ?? process.cwd());
  const files = flags.files
    ? flags.files.split(",").map((f) => path.resolve(root, f.trim()))
    : collectSkillDocFiles(root);

  const { drift, markedRegions, written } = await lintSkillDocFiles(
    root,
    files,
    FORGE_SKILLS,
    flags.write === true,
  );
  return {
    command: "forge.skill.doc-sync",
    status: drift.length === 0 ? "pass" : "fail",
    filesScanned: files.length,
    markedRegions,
    drift,
    written,
  };
}
