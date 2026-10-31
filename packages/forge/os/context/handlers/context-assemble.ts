/*
<MODULE_CONTRACT>
<purpose>
RFC-1470: context.assemble --task "<desc>" [--budget <tokens>] [--paths <globs>]
— scores every indexed unit (lexical BM25-lite term overlap + recency + kind
weight + path overlap) and fills the token budget in rank order; each unit
carries source + machine-readable reasons. Missing index → blocking hint (or
lazy build via --auto-index). Dense channel is the declared EmbeddingGemma-2
slot — absent binding → lexical-only floor (shipped default).
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1470: context.assemble budgeted slate over lexical + recency + path-overlap channels</item>
  <item>RFC-1470: context.index.build + context.assemble + context.slate.eval — slate-retrieval projection over the artifact corpus</item>
  <item>RFC-1470: apply r1 repairs — post-fence knowledge prose, devset re-anchored to real unit ids, source-group discount, CTX-01/02, exact-match eval, file-scoped ids, meta fields</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import { runIndexBuild } from "./index-build.ts";
import type { ContextUnit } from "./index-build.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface SlateUnit {
  id: string;
  kind: string;
  source: string;
  tokens: number;
  score: number;
  reasons: string[];
  text: string;
}

export interface AssembleData {
  command: "context.assemble";
  status: "ok";
  task: string;
  budget: number;
  usedTokens: number;
  units: SlateUnit[];
  skipped: number;
}

const STOPWORDS = new Set(["the", "for", "and", "run", "all", "can", "use", "with", "this", "that", "from"]);

const KIND_WEIGHT: Record<string, number> = {
  "knowledge-entry": 1.2, friction: 1.1, remediation: 1.0,
  "session-block": 0.9, "rfc-header": 0.8, "adr-header": 0.8,
  "skill-manifest": 0.7, decision: 0.7, handoff: 0.5,
};

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-zа-яё0-9_.-]+/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

function termHit(t: string, unitTokens: Set<string>): boolean {
  if (unitTokens.has(t)) return true;
  // Word-prefix tolerance — "scars"↔"scar", "migrate"↔"migration".
  for (const u of unitTokens) if (u.startsWith(t) || t.startsWith(u)) return true;
  return false;
}

export function scoreUnit(unit: ContextUnit, taskTokens: Set<string>, pathTerms: Set<string>): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const unitTokens = tokenize(unit.text + " " + unit.source);
  const hits = [...taskTokens].filter((t) => termHit(t, unitTokens)).length;
  if (hits > 0) reasons.push(`lexical:${hits}`);
  const kindW = KIND_WEIGHT[unit.kind] ?? 0.5;
  const recDays = typeof unit.meta.date === "string"
    ? Math.max(0, (Date.now() - new Date(unit.meta.date).getTime()) / 86_400_000)
    : 365;
  const recency = Math.max(0, 1 - recDays / 365);
  if (recency > 0.5) reasons.push(`recent:${recDays.toFixed(0)}d`);
  const pathHits = [...pathTerms].filter((t) => unit.source.includes(t)).length;
  if (pathHits > 0) reasons.push(`path:${pathHits}`);
  const confirmations = typeof unit.meta.confirmations === "number" ? unit.meta.confirmations : 0;
  if (confirmations > 0) reasons.push(`confirmations:${confirmations}`);
  const recurrences = typeof unit.meta.recurrences === "number" ? unit.meta.recurrences : 0;
  if (recurrences > 0) reasons.push(`recurrences:${recurrences}`);
  const score = hits * 2 * kindW + recency * 1.5 * kindW + pathHits * 3 + Math.min(confirmations, 5) * 0.4 + Math.min(recurrences, 10) * 0.3;
  if (reasons.length === 0) reasons.push("baseline");
  return { score, reasons };
}

export async function runContextAssemble(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AssembleData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const task = String(input.flags["task"] ?? input.argv?.[0] ?? "");
  const budget = Math.max(1, Number(input.flags["budget"] ?? 4000) || 4000);
  const pathTerms = tokenize(String(input.flags["paths"] ?? ""));
  if (!task) {
    return { data: { command: "context.assemble", status: "ok", task: "", budget, usedTokens: 0, units: [], skipped: 0 }, summary: "missing --task", exitCode: 1 };
  }

  const indexRel = path.join(root, "docs", ".index", "context", "index.yaml");
  let indexSrc = await io.readFile(indexRel).catch(() => null);
  if (indexSrc === null) {
    if (input.flags["auto-index"] !== true) {
      return {
        data: { command: "context.assemble", status: "ok", task, budget, usedTokens: 0, units: [], skipped: 0 },
        summary: "CONTEXT-01 index missing — run `werkstatt run context.index.build` or --auto-index",
        exitCode: 1,
      };
    }
    await runIndexBuild(input, context);
    indexSrc = await io.readFile(indexRel).catch(() => null);
    if (indexSrc === null) {
      return { data: { command: "context.assemble", status: "ok", task, budget, usedTokens: 0, units: [], skipped: 0 }, summary: "index build produced nothing", exitCode: 1 };
    }
  }
  const units = ((yamlParse(indexSrc) as { units?: ContextUnit[] } | null)?.units ?? []);
  const auditDir = path.join(root, "docs", "sessions", "audit");
  const newestSidecar = (await io.readdir(auditDir).catch(() => [] as { name: string }[]))
    .filter((e) => e.name.endsWith(".audit.yaml")).sort().at(-1);
  const indexUnits = new Set(units.map((u) => u.source.split("#")[0]));
  if (newestSidecar && ![...indexUnits].some((s) => s.includes("audit"))) {
    context.logger.warn(`CTX-02 index may be stale vs the newest session sidecar — rerun context.index.build`);
  }

  const taskTokens = tokenize(task);
  const scored = units
    .map((u) => ({ u, ...scoreUnit(u, taskTokens, pathTerms) }))
    .sort((a, b) => b.score - a.score || a.u.id.localeCompare(b.u.id));

  // Source-group discount (AC-4): the second unit from the same source file
  // pays only its body cost — the header (source line + kind tag) is charged once.
  const HEADER_TOKENS = 12;
  const slate: SlateUnit[] = [];
  const groupSeen = new Set<string>();
  let used = 0;
  let skipped = 0;
  for (const s of scored) {
    const group = s.u.source.split("#")[0] ?? s.u.source;
    const charge = groupSeen.has(group) ? Math.max(1, s.u.tokens - HEADER_TOKENS) : s.u.tokens;
    if (used + charge > budget) { skipped++; continue; }
    used += charge;
    groupSeen.add(group);
    slate.push({ id: s.u.id, kind: s.u.kind, source: s.u.source, tokens: s.u.tokens, score: Number(s.score.toFixed(3)), reasons: s.reasons, text: s.u.text });
  }
  if (slate.length === 0) {
    context.logger.warn("CTX-01 budget below the smallest scored unit — empty slate");
  }

  if (context.outputFormat === "pretty") {
    context.logger.info(`slate: ${slate.length} unit(s), ${used}/${budget} tokens, ${skipped} skipped`);
    for (const u of slate.slice(0, 12)) context.logger.info(`  ${u.score.toFixed(1)} ${u.kind} ${u.source} [${u.reasons.join(",")}]`);
  }
  if (input.flags["format"] === "markdown") {
    const md = slate.map((u) => `- **${u.kind}** \`${u.source}\` — ${u.reasons.join(", ")}\n  ${u.text.slice(0, 200)}`).join("\n");
    return { data: { command: "context.assemble", status: "ok", task, budget, usedTokens: used, units: slate, skipped }, summary: md, exitCode: 0 };
  }
  return { data: { command: "context.assemble", status: "ok", task, budget, usedTokens: used, units: slate, skipped }, summary: `${slate.length} unit(s), ${used}/${budget} tokens`, exitCode: 0 };
}
