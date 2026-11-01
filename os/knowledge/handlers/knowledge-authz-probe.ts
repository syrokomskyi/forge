/*
<MODULE_CONTRACT>
<purpose>
RFC-1468: knowledge.authz.probe — KAUTHZ-01 authz-relevant entry lacking
authorityRefs (blocking post-grace), KAUTHZ-02 orphaned authz rule (no live
source row), KAUTHZ-03 skill-authored authz entry without the class marker
(grace-window warning). --classify-only proposes markers, writes nothing.
Autonomous — source-text scan only (FORGE-AUTONOMY-01).
</purpose>
<non-goals>
  <item>Do not mutate knowledge files — diagnostics and marker proposals only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1468: apply r1 repairs — serializer fields, id regex, ref extraction, scan surface, real decision-log shape</item>
  <item>RFC-1468: apply r2 repairs — archived-doc resolution, decision refs, catalog ids, blank-fill refusal, fence binding, fix-patterns coverage</item>
  <item>RFC-1468: apply r3 repairs — dotted catalog ruleIds, queue-ledger decision refs</item>
  <item>RFC-1481: recognize consumer-local L-K-NNNN knowledge headings.</item>
  <item>RFC-1481: collapse compass summaries and add missing contract blocks</item>
  <history>RFC-1468</history>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface AuthzDiagnostic {
  ruleId: "KAUTHZ-01" | "KAUTHZ-02" | "KAUTHZ-03";
  severity: "error" | "warning";
  file: string;
  entry?: string;
  message: string;
}

export interface AuthzProbeData {
  command: "knowledge.authz.probe";
  status: "ok" | "violations";
  scanned: number;
  diagnostics: AuthzDiagnostic[];
}

// Assistive classifier: authorization language naming an agent action.
const AUTHZ_RE =
  /\b(must|must not|may not|never|always|allowed|forbidden|approved|prohibited|permitted)\b/i;

interface KnowledgeEntryBlock {
  file: string;
  id: string;
  /** Full section text — classification surface. */
  text: string;
  /** The \`\`\`knowledge-entry yaml block — meta surface. */
  yaml: string;
}

function* blocks(src: string, file: string): Generator<KnowledgeEntryBlock> {
  // A section counts as a knowledge entry only when it carries the
  // \`\`\`knowledge-entry yaml block — doc examples without the block are
  // inert. Meta checks (class/authorityRefs) run on the yaml; classification
  // runs on the full section.
  // Fence must appear before the next heading — a heading without a fence
  // cannot bind the next entry's yaml to the wrong id.
  const re = /###\s+((?:L-)?K-\d{4})\s*:(?:(?!###)[\s\S])*?```knowledge-entry\n([\s\S]*?)```([\s\S]*?)(?=\n###\s+|$)/g;
  for (const m of src.matchAll(re)) {
    yield { file, id: m[1]!, text: m[0], yaml: m[2]! };
  }
}

async function scan(root: string, io: ReturnType<typeof resolveIo>): Promise<KnowledgeEntryBlock[]> {
  const out: KnowledgeEntryBlock[] = [];
  const targets: string[] = [];
  // Knowledge surfaces only — the entry convention is knowledge-file-shaped
  // (qa-log / learned-principles / MEMORY / *-knowledge*.md). Doc files that
  // merely mention entries (SKILL.md docs) are not classification surfaces.
  const KNOWLEDGE_RE = /(qa-log|learned-principles|fix-patterns|MEMORY|knowledge)/i;
  const skillsRoot = path.join(root, ".agents", "skills");
  for (const e of await io.readdir(skillsRoot).catch(() => [] as { name: string; isFile: boolean; isDirectory: boolean }[])) {
    if (!e.isDirectory) continue;
    const dir = path.join(skillsRoot, e.name);
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const f of await io.readdir(cur).catch(() => [] as { name: string; isFile: boolean; isDirectory: boolean }[])) {
        const abs = path.join(cur, f.name);
        if (f.isDirectory) stack.push(abs);
        else if (f.isFile && /\.md$/i.test(f.name) && KNOWLEDGE_RE.test(f.name)) targets.push(abs);
      }
    }
  }
  for (const extra of [".agents/memory/MEMORY.md"]) {
    if (await io.exists(path.join(root, extra))) targets.push(path.join(root, extra));
  }
  for (const abs of targets) {
    const src = await io.readFile(abs).catch(() => "");
    for (const b of blocks(src, path.relative(root, abs).split(path.sep).join("/"))) out.push(b);
  }
  return out;
}

/** Extract authorityRefs from the yaml block — block list or flow style. */
function extractRefs(yaml: string): string[] {
  const m = yaml.match(/\bauthorityRefs:\s*(\[[^\]]*\])?([\s\S]*?)(?=\n\s*\w+:|$)/);
  if (!m) return [];
  if (m[1]) {
    return m[1].slice(1, -1).split(",").map((v) => v.trim()).filter(Boolean);
  }
  return [...m[2].matchAll(/^\s*-\s*(\S+)/gm)].map((r) => r[1]!);
}

async function resolveRef(
  ref: string,
  root: string,
  io: ReturnType<typeof resolveIo>,
  rfcFiles: Set<string>,
  adrFiles: Set<string>,
  decisionIds: Set<string>,
  catalogIds: Set<string>,
): Promise<boolean> {
  if (/^(RFC|ADR)-\d+$/.test(ref)) {
    const id = ref.toLowerCase();
    const set = ref.startsWith("RFC") ? rfcFiles : adrFiles;
    return set.has(id);
  }
  if (/^decision:/i.test(ref)) return decisionIds.has(ref);
  if (/^F-\d{4}$/.test(ref)) {
    const src = await io.readFile(path.join(root, "docs", "frictions.yaml")).catch(() => "");
    return new RegExp(`^-\\s*id:\\s*${ref}\\s*$`, "m").test(src);
  }
  // Catalog ruleIds (catalog contract refs) — a remediation row must exist.
  if (/^[A-Z][A-Z0-9]*(?:[-.][A-Z0-9]+)+$/.test(ref)) return catalogIds.has(ref);
  return false;
}

export async function runKnowledgeAuthzProbe(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AuthzProbeData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const entries = await scan(root, io);
  // Recursive walk — landed RFCs/ADRs live under archive/ subdirs.
  const collectIds = async (dir: string): Promise<Set<string>> => {
    const out = new Set<string>();
    const stack = [dir];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const e of await io.readdir(cur).catch(() => [] as { name: string; isFile: boolean; isDirectory: boolean }[])) {
        const abs = path.join(cur, e.name);
        if (e.isDirectory) stack.push(abs);
        else if (e.isFile) {
          const m = e.name.match(/^((?:rfc|adr)-\d+)/);
          if (m) out.add(m[1]!);
        }
      }
    }
    return out;
  };
  const rfcFiles = await collectIds(path.join(root, "docs", "rfcs"));
  const adrFiles = await collectIds(path.join(root, "docs", "adrs"));
  const dlSrc = await io.readFile(path.join(root, "docs", "rfcs", "decision-log.generated.yaml")).catch(() => "");
  // decision:<doc-id> refs resolve against the log's rfcId column; literal
  // decision:D-YYYY-MM-DD-NN ids resolve against queue ledgers' decisions.
  const decisionIds = new Set<string>(
    [...dlSrc.matchAll(/rfcId:\s*(\S+)/g)].map((m) => `decision:${m[1]}`),
  );
  // Literal decision:D-* ids live in queue ledgers — scan them for refs.
  for (const q of await io.readdir(path.join(root, "docs", "queues")).catch(() => [] as { name: string; isFile: boolean }[])) {
    if (!q.isFile || !q.name.endsWith(".decisions.yaml")) continue;
    const qs = await io.readFile(path.join(root, "docs", "queues", q.name)).catch(() => "");
    for (const m of qs.matchAll(/\bdecision:D-[\w:-]+/g)) decisionIds.add(m[0]!);
  }
  const catSrc = await io.readFile(path.join(root, "docs", "remediation-catalog.generated.yaml")).catch(() => "");
  const catalogIds = new Set([...catSrc.matchAll(/ruleId:\s*(\S+)/g)].map((m) => m[1]!));
  const diagnostics: AuthzDiagnostic[] = [];

  for (const e of entries) {
    const declared = /\bclass:\s*authz-relevant/.test(e.yaml);
    const refs = extractRefs(e.yaml);
    const hasRefs = refs.length > 0;
    const looksAuthz = AUTHZ_RE.test(e.text);

    if (declared && !hasRefs) {
      diagnostics.push({
        ruleId: "KAUTHZ-01",
        severity: "error",
        file: e.file,
        entry: e.id,
        message: `${e.id} (${e.file}): class: authz-relevant declared without authorityRefs — the entry must name its authoritative source`,
      });
    } else if (!declared && looksAuthz) {
      diagnostics.push({
        ruleId: "KAUTHZ-03",
        severity: "warning",
        file: e.file,
        entry: e.id,
        message: `${e.id} (${e.file}): authorization-shaped knowledge without the class marker — declare class: authz-relevant + authorityRefs, or mark factual (grace window)`,
      });
    }
    if (declared && hasRefs) {
      // KAUTHZ-02: each authorityRef must resolve to a live source row —
      // an RFC/ADR doc id or a decision-log entry that exists on disk.
      for (const ref of refs) {
        const live = await resolveRef(ref, root, io, rfcFiles, adrFiles, decisionIds, catalogIds);
        if (!live) {
          diagnostics.push({
            ruleId: "KAUTHZ-02",
            severity: "warning",
            file: e.file,
            entry: e.id,
            message: `${e.id}: authorityRef "${ref}" resolves to no live source row — orphan`,
          });
        }
      }
    }
  }

  if (input.flags["classify-only"]) {
    for (const d of diagnostics.filter((d) => d.ruleId === "KAUTHZ-03")) {
      context.logger.info(`propose: ${d.entry} → class: authz-relevant (in ${d.file})`);
    }
  } else if (context.outputFormat === "pretty") {
    for (const d of diagnostics) context.logger.warn(`${d.ruleId} ${d.message}`);
  }

  const errors = diagnostics.filter((d) => d.severity === "error");
  return {
    data: {
      command: "knowledge.authz.probe",
      status: errors.length > 0 ? "violations" : "ok",
      scanned: entries.length,
      diagnostics,
    },
    summary: `${diagnostics.length} authz diagnostic(s) over ${entries.length} entries`,
    exitCode: errors.length > 0 ? 1 : 0,
  };
}
