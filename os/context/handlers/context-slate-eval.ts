/*
<MODULE_CONTRACT>
<purpose>
RFC-1470: context.slate.eval — the completeness harness: a gold dev set
docs/context-devset/ of task → requiredUnits[] pairs scores recall@budget —
the fraction of required units the slate contains. This is the RFC's own
acceptance instrument and the regression gate for every ranker change.
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1470: context.slate.eval recall@budget over the gold dev set</item>
  <item>RFC-1470: context.index.build + context.assemble + context.slate.eval — slate-retrieval projection over the artifact corpus</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import { scoreUnit } from "./context-assemble.ts";
import type { ContextUnit } from "./index-build.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface EvalData {
  command: "context.slate.eval";
  status: "ok";
  tasks: number;
  recall: number;
  perTask: { task: string; recall: number; found: number; required: number }[];
}

export async function runSlateEval(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<EvalData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const budget = Math.max(1, Number(input.flags["budget"] ?? 4000) || 4000);
  const indexSrc = await io.readFile(path.join(root, "docs", ".index", "context", "index.yaml")).catch(() => null);
  if (indexSrc === null) {
    return { data: { command: "context.slate.eval", status: "ok", tasks: 0, recall: 0, perTask: [] }, summary: "CONTEXT-01 index missing — run context.index.build", exitCode: 1 };
  }
  const units = ((yamlParse(indexSrc) as { units?: ContextUnit[] } | null)?.units ?? []);
  const devsetDir = path.join(root, "docs", "context-devset");
  const entries = await io.readdir(devsetDir).catch(() => [] as { name: string; isDirectory: boolean }[]);
  const tasks = entries.filter((e) => !e.isDirectory && e.name.endsWith(".yaml"));
  if (tasks.length === 0) {
    return { data: { command: "context.slate.eval", status: "ok", tasks: 0, recall: 0, perTask: [] }, summary: "devset empty — docs/context-devset/*.yaml", exitCode: 1 };
  }

  const perTask: EvalData["perTask"] = [];
  for (const tf of tasks) {
    const src = await io.readFile(path.join(devsetDir, tf.name)).catch(() => null);
    if (src === null) continue;
    const d = yamlParse(src) as { task?: string; requiredUnits?: string[] } | null;
    if (!d?.task || !Array.isArray(d.requiredUnits)) continue;
    const taskTokens = new Set(d.task.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
    const scored = units.map((u) => ({ u, ...scoreUnit(u, taskTokens, new Set()) })).sort((a, b) => b.score - a.score || a.u.id.localeCompare(b.u.id));
    const slateIds = new Set<string>();
    let used = 0;
    for (const s of scored) {
      if (used + s.u.tokens > budget) continue;
      used += s.u.tokens;
      slateIds.add(s.u.id);
      slateIds.add(s.u.source);
    }
    const found = d.requiredUnits.filter((r) => slateIds.has(r) || [...slateIds].some((s) => s.includes(r))).length;
    perTask.push({ task: tf.name, recall: d.requiredUnits.length > 0 ? found / d.requiredUnits.length : 1, found, required: d.requiredUnits.length });
  }
  const recall = perTask.length > 0 ? perTask.reduce((s, t) => s + t.recall, 0) / perTask.length : 0;
  return {
    data: { command: "context.slate.eval", status: "ok", tasks: perTask.length, recall: Number(recall.toFixed(3)), perTask },
    summary: `${perTask.length} task(s): recall@${budget} = ${(recall * 100).toFixed(1)}%`,
    exitCode: 0,
  };
}
