/*
<MODULE_CONTRACT>
<purpose>
RFC-1470: context.index.build — builds docs/.index/context/ (gitignored pure
projection, DNA-111): a unit catalog extracted from existing artifacts. Unit
kinds v1: session-block, knowledge-entry, friction, remediation, rfc-header,
adr-header, skill-manifest, handoff, decision. Each unit carries id, kind,
source (path#anchor), tokens, text, meta (dates, entity refs). Drop the dir,
rebuild from sources — no authority lives in the index.
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1470: context.index.build rebuildable unit catalog</item>
  <item>RFC-1470: context.index.build + context.assemble + context.slate.eval — slate-retrieval projection over the artifact corpus</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import { listSessionFiles, readAndParseSession } from "../../session/frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface ContextUnit {
  id: string;
  kind: "session-block" | "knowledge-entry" | "friction" | "remediation" | "rfc-header" | "adr-header" | "skill-manifest" | "handoff" | "decision";
  source: string;
  tokens: number;
  text: string;
  meta: Record<string, unknown>;
}

export interface IndexBuildData {
  command: "context.index.build";
  status: "ok";
  units: number;
  byKind: Record<string, number>;
  index: string;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function walk(dir: string, io: ReturnType<typeof resolveIo>, depth = 3): Promise<string[]> {
  if (depth < 0) return [];
  const out: string[] = [];
  for (const e of await io.readdir(dir).catch(() => [] as { name: string; isDirectory: boolean }[])) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory) out.push(...await walk(abs, io, depth - 1));
    else out.push(abs);
  }
  return out;
}

const KENTRY_RE = /```knowledge-entry\n([\s\S]*?)```/g;

export async function runIndexBuild(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<IndexBuildData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const units: ContextUnit[] = [];
  const push = (u: Omit<ContextUnit, "tokens">) => units.push({ ...u, tokens: estimateTokens(u.text) });

  // session-block — frontmatter fields as separate units per session.
  const sessionsDir = path.join(root, "docs", "sessions");
  for (const rel of (await listSessionFiles(sessionsDir).catch(() => [])).slice(-200)) {
    const result = await readAndParseSession(sessionsDir, rel).catch(() => null);
    if (!result) continue;
    const fm = result.parsed.frontmatter;
    const id = String(fm.id ?? path.basename(rel, ".md"));
    const fields: [string, unknown][] = [
      ["summary", fm.summary],
      ["decisions", Array.isArray(fm.decisions) ? fm.decisions.join("\n") : fm.decisions],
      ["remainingIssues", Array.isArray(fm.remainingIssues) ? fm.remainingIssues.join("\n") : fm.remainingIssues],
      ["systemDelta", Array.isArray(fm.systemDelta) ? fm.systemDelta.join("\n") : fm.systemDelta],
    ];
    for (const [field, val] of fields) {
      if (typeof val !== "string" || val.length < 10) continue;
      push({ id: `session-block:${id}:${field}`, kind: "session-block", source: `docs/sessions/${rel}#${field}`, text: `${field}: ${val}`, meta: { sessionId: id, field, date: fm.date } });
    }
  }

  // knowledge-entry — K-NNNN blocks in .agents knowledge files + MEMORY.md.
  const kfiles = (await walk(path.join(root, ".agents"), io)).filter((p) => /\.(md)$/.test(p) && /(qa-log|learned-principles|fix-patterns|MEMORY)/.test(p));
  for (const kf of kfiles) {
    const src = await io.readFile(kf).catch(() => null);
    if (src === null) continue;
    const rel = path.relative(root, kf).split(path.sep).join("/");
    for (const m of src.matchAll(KENTRY_RE)) {
      const idMatch = src.slice(Math.max(0, (m.index ?? 0) - 200)).match(/###\s+(K-\d+)/);
      const kid = idMatch?.[1] ?? `K-${units.length}`;
      push({ id: `knowledge-entry:${kid}`, kind: "knowledge-entry", source: `${rel}#${kid}`, text: m[1]!.slice(0, 1500), meta: { kId: kid, file: rel } });
    }
  }

  // friction — frictions.yaml rows.
  const frictionsSrc = await io.readFile(path.join(root, "docs", "frictions.yaml")).catch(() => "");
  const frParsed = yamlParse(frictionsSrc) as unknown;
  const frictions = Array.isArray(frParsed) ? frParsed : ((frParsed as { frictions?: unknown[] } | null)?.frictions ?? []);
  for (const fr of frictions as { id?: string; friction?: string; category?: string; recurrences?: number }[]) {
    if (!fr.id) continue;
    push({ id: `friction:${fr.id}`, kind: "friction", source: `docs/frictions.yaml#${fr.id}`, text: `${fr.id} [${fr.category ?? "?"}]: ${fr.friction ?? ""}`, meta: { fId: fr.id, category: fr.category, recurrences: fr.recurrences ?? 0 } });
  }

  // remediation — catalog entries.
  for (const catPath of ["docs/remediation-catalog.generated.yaml", "docs/remediation-catalog.custom.yaml"]) {
    const catSrc = await io.readFile(path.join(root, catPath)).catch(() => null);
    if (catSrc === null) continue;
    const cat = yamlParse(catSrc) as { entries?: { ruleId?: string; action?: string; contract?: string }[] } | null;
    for (const e of cat?.entries ?? []) {
      if (!e.ruleId) continue;
      push({ id: `remediation:${e.ruleId}`, kind: "remediation", source: `${catPath}#${e.ruleId}`, text: `${e.ruleId}: ${e.contract ?? ""} — ${e.action ?? ""}`, meta: { ruleId: e.ruleId } });
    }
  }

  // rfc-header / adr-header — frontmatter title + status + successSignals.
  for (const [dir, kind] of [["docs/rfcs", "rfc-header"], ["docs/adrs", "adr-header"]] as const) {
    for (const f of await walk(path.join(root, dir), io).then((p) => p.filter((x) => x.endsWith(".md")))) {
      const src = await io.readFile(f).catch(() => null);
      if (src === null) continue;
      const rel = path.relative(root, f).split(path.sep).join("/");
      const fmMatch = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const fm = fmMatch ? (yamlParse(fmMatch[1]!) as Record<string, unknown>) : {};
      const rid = String(fm.id ?? path.basename(f, ".md").toUpperCase());
      const signals = Array.isArray(fm.successSignals) ? (fm.successSignals as string[]).join(" ") : "";
      push({ id: `${kind}:${rid}`, kind, source: `${rel}#${rid}`, text: `${rid}: ${String(fm.title ?? "")} [${String(fm.status ?? "?")}] ${signals}`.slice(0, 800), meta: { refId: rid, status: fm.status } });
    }
  }

  // skill-manifest — name + description + triggerPhrases.
  for (const sp of await walk(path.join(root, "packages", "forge", "skills"), io).then((p) => p.filter((x) => x.endsWith("SKILL.md")))) {
    const src = await io.readFile(sp).catch(() => null);
    if (src === null) continue;
    const fmMatch = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const fm = fmMatch ? (yamlParse(fmMatch[1]!) as Record<string, unknown>) : {};
    const name = String(fm.name ?? path.basename(path.dirname(sp)));
    const rel = path.relative(root, sp).split(path.sep).join("/");
    push({ id: `skill-manifest:${name}`, kind: "skill-manifest", source: `${rel}#${name}`, text: `${name}: ${String(fm.description ?? "")} ${Array.isArray(fm.triggerPhrases) ? fm.triggerPhrases.join(" ") : ""}`.slice(0, 600), meta: { skill: name } });
  }

  // handoff — docs/handoffs/*.md title + first paragraph.
  for (const hf of await walk(path.join(root, "docs", "handoffs"), io).then((p) => p.filter((x) => x.endsWith(".md")))) {
    const src = await io.readFile(hf).catch(() => null);
    if (src === null) continue;
    const rel = path.relative(root, hf).split(path.sep).join("/");
    const first = src.split("\n").filter((l) => l.trim().length > 0).slice(0, 4).join(" ").slice(0, 500);
    push({ id: `handoff:${path.basename(hf, ".md")}`, kind: "handoff", source: `${rel}#top`, text: first, meta: { file: rel } });
  }

  // decision — session decision-log entries (queue ledger + session decisions).
  for (const dl of await walk(path.join(root, "docs", "queues"), io).then((p) => p.filter((x) => x.endsWith("decisions.yaml")))) {
    const src = await io.readFile(dl).catch(() => null);
    if (src === null) continue;
    const rel = path.relative(root, dl).split(path.sep).join("/");
    const items = (yamlParse(src) as { items?: { id?: string; question?: string; answer?: string }[] } | null)?.items ?? [];
    for (const it of items) {
      if (!it.id) continue;
      push({ id: `decision:${it.id}`, kind: "decision", source: `${rel}#${it.id}`, text: `${it.id}: ${it.question ?? ""} → ${it.answer ?? ""}`, meta: { decisionId: it.id } });
    }
  }

  const indexDir = path.join(root, "docs", ".index", "context");
  await io.mkdir(indexDir).catch(() => {});
  const indexRel = "docs/.index/context/index.yaml";
  await io.writeFile(path.join(root, indexRel), yamlStringify({ schema: "forge/context-index@1", builtAt: "rebuildable", units }) + "\n");
  const byKind: Record<string, number> = {};
  for (const u of units) byKind[u.kind] = (byKind[u.kind] ?? 0) + 1;
  return {
    data: { command: "context.index.build", status: "ok", units: units.length, byKind, index: indexRel },
    summary: `${units.length} unit(s) across ${Object.keys(byKind).length} kinds → ${indexRel}`,
    exitCode: 0,
  };
}
