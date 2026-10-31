/*
<MODULE_CONTRACT>
<purpose>
RFC-1468: knowledge.authz.probe — KAUTHZ-01 authz-relevant entry lacking
authorityRefs (blocking post-grace), KAUTHZ-02 orphaned authz rule (no live
source row), KAUTHZ-03 skill-authored authz entry without the class marker
(grace-window warning). --classify-only proposes markers, writes nothing.
Autonomous — source-text scan only (FORGE-AUTONOMY-01).
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1468: KAUTHZ-01..03 probe + classify-only assist</item>
  <item>RFC-1468: bind authz-relevant knowledge to authoritative sources — knowledge.rebuild + knowledge.authz.probe, KAUTHZ-01..03</item>
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
  text: string;
}

function* blocks(src: string, file: string): Generator<KnowledgeEntryBlock> {
  // The full entry section — yaml block + the authored body — is the
  // classification surface; authz language lives in the prose.
  const re = /###\s+(K-\d{4}):([\s\S]*?)(?=\n###\s+|$)/g;
  for (const m of src.matchAll(re)) {
    yield { file, id: m[1]!, text: m[2]! };
  }
}

async function scan(root: string, io: ReturnType<typeof resolveIo>): Promise<KnowledgeEntryBlock[]> {
  const out: KnowledgeEntryBlock[] = [];
  const targets: string[] = [];
  const skillsRoot = path.join(root, ".agents", "skills");
  for (const e of await io.readdir(skillsRoot).catch(() => [] as { name: string; isFile: boolean; isDirectory: boolean }[])) {
    if (!e.isDirectory) continue;
    const dir = path.join(skillsRoot, e.name);
    for (const f of await io.readdir(dir).catch(() => [] as { name: string; isFile: boolean; isDirectory: boolean }[])) {
      if (f.isFile && /\.md$/i.test(f.name)) targets.push(path.join(dir, f.name));
    }
  }
  for (const extra of [".agents/memory/MEMORY.md", "docs/knowledge/shared-knowledge.md"]) {
    if (await io.exists(path.join(root, extra))) targets.push(path.join(root, extra));
  }
  for (const abs of targets) {
    const src = await io.readFile(abs).catch(() => "");
    for (const b of blocks(src, path.relative(root, abs).split(path.sep).join("/"))) out.push(b);
  }
  return out;
}

export async function runKnowledgeAuthzProbe(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AuthzProbeData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const entries = await scan(root, io);
  const diagnostics: AuthzDiagnostic[] = [];

  for (const e of entries) {
    const declared = /\bclass:\s*authz-relevant/.test(e.text);
    const hasRefs = /\bauthorityRefs:\s*[\[\w\n -]/.test(e.text);
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
      // an RFC/ADR/decision id or a catalog entry that exists on disk.
      const refs = [...e.text.matchAll(/authorityRefs:[\s\S]*?(?=\n\s*\w+:|$)/g)]
        .flatMap((m) => [...m[0].matchAll(/-\s*(\S+)/g)].map((r) => r[1]!));
      for (const ref of refs) {
        if (/^(RFC|ADR)-\d+$/.test(ref)) {
          const id = ref.toLowerCase();
          const exists = await io
            .exists(path.join(root, "docs", "rfcs", `${id}-`))
            .catch(() => false);
          const onDisk = exists
            || (await io.readdir(path.join(root, "docs", "rfcs")).catch(() => [] as { name: string }[]))
              .some((f) => f.name.startsWith(id));
          const onAdr = (await io.readdir(path.join(root, "docs", "adrs")).catch(() => [] as { name: string }[]))
            .some((f) => f.name.startsWith(id));
          if (!onDisk && !onAdr) {
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
