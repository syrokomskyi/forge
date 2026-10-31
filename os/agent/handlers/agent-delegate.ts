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
  <item>RFC-1464: apply r1 repairs — envelope via DELEGATE_ENVELOPE env, real boundary diff, gate flags, DEL renumber</item>
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

export type GateRef = string | { command: string; flags?: Record<string, string | number | boolean> };

export interface DelegableClass {
  class: string;
  gate: GateRef[];
  schema: Record<string, unknown>;
  boundary: string[];
}

export function gateName(ref: GateRef): string {
  return typeof ref === "string" ? ref : ref.command;
}

export interface DelegateResult {
  command: "agent.delegate";
  verdict: "done" | "escalated" | "failed" | "refused";
  class: string;
  gateReport: { command: string; exitCode: number; ok: boolean; summary?: string; diagnostics?: unknown }[];
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
      Array.isArray((d as DelegableClass).gate) &&
      (d as DelegableClass).gate.length > 0,
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
        verdict: "refused",
        class: className,
        gateReport: [],
        boundaryViolations: [],
        reason: "agentTiers.cheap binding unresolvable — declare provider + invoke in forge.yaml",
      },
      summary: "agent.delegate refused — cheap tier binding unresolvable",
      exitCode: 1,
    };
  }

  const inputRaw = input.flags["input"] as string | undefined;
  let parsedInput: Record<string, unknown> = {};
  if (inputRaw) {
    try {
      parsedInput = JSON.parse(inputRaw) as Record<string, unknown>;
    } catch {
      const fileRaw = await io.readFile(path.join(root, inputRaw)).catch(() => null);
      if (fileRaw === null) throw new Error(`agent.delegate: --input is neither JSON nor a readable file: ${inputRaw}`);
      parsedInput = JSON.parse(fileRaw) as Record<string, unknown>;
    }
  }

  const envelope: TaskEnvelope = {
    class: className,
    schema: decl.schema ?? {},
    input: parsedInput,
    boundary: decl.boundary ?? [],
  };

  // Pre-invoke dirty snapshot — the boundary check is a post-hoc diff-scope
  // audit (RFC-1464), never a sandbox.
  const pre = await io
    .exec?.("git", ["status", "--porcelain"], { cwd: root })
    .then((r) => new Set(r.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean)))
    .catch(() => new Set<string>()) ?? new Set<string>();

  const invoked = await invokeCheapTier(binding, envelope, io, root);
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

  // Boundary check — post-hoc diff scope: files newly touched by the delegate
  // outside declared boundary paths → operator-visible violations.
  const post = await io
    .exec?.("git", ["status", "--porcelain"], { cwd: root })
    .then((r) => new Set(r.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean)))
    .catch(() => new Set<string>()) ?? new Set<string>();
  const modified = [
    ...new Set([...post].filter((f) => !pre.has(f)).concat(invoked.filesModified ?? [])),
  ];
  const boundary = decl.boundary ?? [];
  const boundaryViolations = boundary.length > 0
    ? modified.filter((f) => !boundary.some((b) => f === b || f.startsWith(b.endsWith("/") ? b : `${b}/`)))
    : [];
  if (boundaryViolations.length > 0) {
    context.logger.warn(
      `DEL-BOUNDARY: delegate touched ${boundaryViolations.length} file(s) outside ${className}'s declared boundary: ${boundaryViolations.join(", ")}`,
    );
  }

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
  for (const gateRef of decl.gate) {
    const cmd = gateName(gateRef);
    const gateFlags = typeof gateRef === "object" ? (gateRef.flags ?? {}) : {};
    try {
      const res = await context.invoke(cmd, gateFlags as never);
      gateReport.push({
        command: cmd,
        exitCode: res.exitCode,
        ok: res.ok,
        summary: res.summary,
        diagnostics: res.data,
      });
    } catch (err) {
      gateReport.push({
        command: cmd,
        exitCode: 1,
        ok: false,
        summary: `gate invoke threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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
