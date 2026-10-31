/*
<MODULE_CONTRACT>
<purpose>
RFC-1468: knowledge.rebuild — rewrites only inside
`<!-- knowledge-rebuild:begin source=<key> -->` ... `end` marker regions from
authoritative source rows (remediation catalog, frictions measures, decision
log). --diff reports drift; --check exits non-zero on orphan/missing; the
plain run rewrites the regions in place.
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1468: marker-region rebuild over authoritative sources</item>
  <item>RFC-1468: bind authz-relevant knowledge to authoritative sources — knowledge.rebuild + knowledge.authz.probe, KAUTHZ-01..03</item>
  <item>RFC-1468: apply r1 repairs — serializer fields, id regex, ref extraction, scan surface, real decision-log shape</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface RebuildDiagnostic {
  ruleId: "REBUILD-ORPHAN" | "REBUILD-MISSING";
  severity: "warning";
  file: string;
  message: string;
}

export interface RebuildData {
  command: "knowledge.rebuild";
  status: "ok" | "drift" | "rebuilt";
  targets: string[];
  diagnostics: RebuildDiagnostic[];
}

const MARKER_RE =
  /<!--\s*knowledge-rebuild:begin\s+source=([a-z0-9.-]+)\s*-->([\s\S]*?)<!--\s*knowledge-rebuild:end\s*-->/g;

async function sourceRows(root: string, io: ReturnType<typeof resolveIo>, key: string): Promise<string[]> {
  if (key === "remediation-catalog") {
    const src = await io.readFile(path.join(root, "docs", "remediation-catalog.generated.yaml")).catch(() => "");
    const parsed = yamlParse(src) as { entries?: { ruleId?: string; action?: string }[] } | null;
    return (parsed?.entries ?? [])
      .filter((e) => e.ruleId && e.action)
      .map((e) => `- **${e.ruleId}** — ${e.action}`);
  }
  if (key === "frictions") {
    const src = await io.readFile(path.join(root, "docs", "frictions.yaml")).catch(() => "");
    const parsed = yamlParse(src) as { id?: string; measure?: string }[] | null;
    return (parsed ?? [])
      .filter((e) => e.id && e.measure)
      .map((e) => `- **${e.id}** — ${e.measure}`);
  }
  if (key === "decision-log") {
    const src = await io.readFile(path.join(root, "docs", "rfcs", "decision-log.generated.yaml")).catch(() => "");
    const parsed = yamlParse(src) as { entries?: { rfcId?: string; title?: string; status?: string }[] } | null;
    return (parsed?.entries ?? [])
      .filter((e) => e.rfcId && e.title && e.status === "accepted")
      .map((e) => `- **${e.rfcId}** — ${e.title}`);
  }
  return [];
}

export async function runKnowledgeRebuild(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RebuildData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const check = input.flags["check"] === true;
  const diff = input.flags["diff"] === true || check;
  const all = input.flags["all"] === true;

  const targets: string[] = [];
  if (typeof input.flags["target"] === "string") targets.push(input.flags["target"] as string);
  if (all) {
    const cfg = await io.readFile(path.join(root, "forge.yaml")).catch(() => "");
    const parsed = yamlParse(cfg) as { knowledge?: { rebuildRegions?: string[] } } | null;
    for (const t of parsed?.knowledge?.rebuildRegions ?? [".agents/memory/MEMORY.md"]) {
      if (await io.exists(path.join(root, t))) targets.push(t);
    }
  }
  if (targets.length === 0) throw new Error("knowledge.rebuild requires --target <file> or --all");

  const diagnostics: RebuildDiagnostic[] = [];
  const writes: { path: string; content: string }[] = [];
  for (const rel of targets) {
    const abs = path.join(root, rel);
    const src = await io.readFile(abs).catch(() => null);
    if (src === null) continue;
    let next = src;
    for (const m of src.matchAll(MARKER_RE)) {
      const key = m[1]!;
      const rows = await sourceRows(root, io, key);
      const wanted = rows.join("\n");
      const existing = m[2]!.trim();
      if (existing !== wanted) {
        const ID_RE = /\*\*([A-Z][A-Z0-9]*(?:[-.][A-Z0-9]+)+)\*\*/g;
        const existingIds = [...existing.matchAll(ID_RE)].map((r) => r[1]);
        const wantedIds = [...wanted.matchAll(ID_RE)].map((r) => r[1]);
        for (const id of existingIds.filter((i) => !wantedIds.includes(i))) {
          diagnostics.push({
            ruleId: "REBUILD-ORPHAN",
            severity: "warning",
            file: rel,
            message: `${rel}: derived line for "${id}" has no live source row — orphan`,
          });
        }
        for (const id of wantedIds.filter((i) => !existingIds.includes(i))) {
          diagnostics.push({
            ruleId: "REBUILD-MISSING",
            severity: "warning",
            file: rel,
            message: `${rel}: source row "${id}" missing from the rebuild region`,
          });
        }
        next = next.replace(
          m[0],
          () => `<!-- knowledge-rebuild:begin source=${key} -->\n${wanted}\n<!-- knowledge-rebuild:end -->`,
        );
      }
    }
    if (next !== src && !diff) writes.push({ path: abs, content: next });
  }

  for (const w of writes) await io.writeFile(w.path, w.content);
  const status = check || diff
    ? diagnostics.length > 0 ? "drift" : "ok"
    : writes.length > 0 ? "rebuilt" : "ok";

  if (context.outputFormat === "pretty") {
    for (const d of diagnostics) context.logger.warn(`${d.ruleId} ${d.message}`);
    context.logger.success(`knowledge.rebuild: ${status}`);
  }
  return {
    data: { command: "knowledge.rebuild", status, targets, diagnostics },
    summary: `${diagnostics.length} drift diagnostic(s) over ${targets.length} target(s) — ${status}`,
    exitCode: check && diagnostics.length > 0 ? 1 : 0,
  };
}
