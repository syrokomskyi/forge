/*
<MODULE_CONTRACT>
<purpose>
RFC-1464: agent.delegate — resolve a declared mechanical task class, invoke
the cheap tier through the declared invoke adapter, then run every gate[]
validator via the kernel invoke port. Verdict: done | escalated | failed.
</purpose>
<non-goals>
  <item>Not a sandbox — the boundary check is a post-hoc diff-scope audit, operator-visible.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1464: delegate orchestration — class resolution, adapter invoke, gate run, verdict</item>
  <item>RFC-1464: delegate mechanical task classes to cheap tier — agent.delegate, tiers.validate, invoke adapters</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import { invokeCheapTier, loadBinding, type TaskEnvelope } from "../invoke-adapter.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface DelegableClass {
  class: string;
  gate: string[];
  schema: Record<string, unknown>;
  boundary: string[];
}

export interface DelegateResult {
  command: "agent.delegate";
  verdict: "done" | "escalated" | "failed" | "refused";
  class: string;
  gateReport: { command: string; exitCode: number; ok: boolean; summary?: string }[];
  boundaryViolations: string[];
  reason?: string;
}

export function loadDelegable(raw: unknown): DelegableClass[] {
  const list = (raw as { delegable?: unknown[] } | null)?.delegable;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (d): d is DelegableClass =>
      typeof d === "object" && d !== null &&
      typeof (d as DelegableClass).class === "string" &&
      Array.isArray((d as DelegableClass).gate),
  );
}

export async function runAgentDelegate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<DelegateResult>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const className = input.flags["class"] as string | undefined;
  if (!className) throw new Error("agent.delegate requires --class <name>");

  const forgeYaml = await io.readFile(path.join(root, "forge.yaml")).catch(() => null);
  const parsed = forgeYaml === null ? null : yamlParse(forgeYaml);
  const decl = loadDelegable(parsed).find((d) => d.class === className);
  if (!decl) {
    return {
      data: {
        command: "agent.delegate",
        verdict: "refused",
        class: className,
        gateReport: [],
        boundaryViolations: [],
        reason: `class "${className}" is not declared in forge.yaml delegable[] — mechanical classes must be declared with gate+schema+boundary`,
      },
      summary: `agent.delegate refused — undeclared class ${className}`,
      exitCode: 1,
    };
  }

  const binding = loadBinding(parsed, "cheap");
  if (!binding) {
    return {
      data: {
        command: "agent.delegate",
        verdict: "failed",
        class: className,
        gateReport: [],
        boundaryViolations: [],
        reason: "agentTiers.cheap binding unresolvable — declare provider + invoke in forge.yaml",
      },
      summary: "agent.delegate failed — cheap tier binding unresolvable",
      exitCode: 1,
    };
  }

  const envelope: TaskEnvelope = {
    class: className,
    schema: decl.schema ?? {},
    input: (input.flags["input"] ? JSON.parse(input.flags["input"] as string) : {}) as Record<string, unknown>,
    boundary: decl.boundary ?? [],
  };
  const invoked = await invokeCheapTier(binding, envelope, io as never);
  if (!invoked.ok) {
    return {
      data: {
        command: "agent.delegate",
        verdict: "failed",
        class: className,
        gateReport: [],
        boundaryViolations: [],
        reason: `cheap tier transport failed: ${invoked.error}`,
      },
      summary: `agent.delegate failed — ${invoked.error}`,
      exitCode: 1,
    };
  }

  // Boundary check — post-hoc diff scope: files the delegate touched outside
  // declared boundary paths are operator-visible DEL-class violations.
  const modified = (invoked as { filesModified?: string[] }).filesModified ?? [];
  const boundaryViolations = decl.boundary.length > 0
    ? modified.filter((f) => !decl.boundary.some((b) => f === b || f.startsWith(b.endsWith("/") ? b : `${b}/`)))
    : [];

  // Every gate validator runs — escalation, never silent pass.
  if (!context.invoke) {
    return {
      data: {
        command: "agent.delegate",
        verdict: "failed",
        class: className,
        gateReport: [],
        boundaryViolations,
        reason: "no kernel host (context.invoke absent) — gate[] validators unreachable; run under the kernel",
      },
      summary: "agent.delegate failed — invoke port absent",
      exitCode: 1,
    };
  }
  const gateReport: DelegateResult["gateReport"] = [];
  for (const gateCmd of decl.gate) {
    const res = await context.invoke(gateCmd, {});
    gateReport.push({
      command: gateCmd,
      exitCode: res.exitCode,
      ok: res.ok,
      summary: res.summary,
    });
  }
  const failed = gateReport.filter((g) => !g.ok);
  const verdict: DelegateResult["verdict"] = failed.length > 0 ? "escalated" : "done";
  return {
    data: {
      command: "agent.delegate",
      verdict,
      class: className,
      gateReport,
      boundaryViolations,
      ...(failed.length > 0
        ? { reason: `${failed.length} gate(s) failed (${failed.map((g) => g.command).join(", ")}) — escalate to frontier tier` }
        : {}),
    },
    summary:
      verdict === "done"
        ? `agent.delegate done — ${gateReport.length} gate(s) green`
        : `agent.delegate escalated — ${failed.map((g) => g.command).join(", ")} failed`,
    exitCode: verdict === "done" ? 0 : 1,
  };
}
