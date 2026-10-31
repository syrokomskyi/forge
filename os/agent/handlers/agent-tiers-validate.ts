/*
<MODULE_CONTRACT>
<purpose>
RFC-1464: agent.delegate.tiers.validate — DEL-01 empty/missing gate[]
(unverifiable delegation), DEL-02 gate ref unresolvable in the command
manifest or not a validate/check-style command, DEL-03 missing input schema,
DEL-04 missing boundary note; plus literal secret/endpoint material in the
binding (blocking) and unresolvable invoke bindings.
Autonomous — reads forge.yaml + the generated command manifest only.
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1464: DEL-01..04 tiers/delegable declaration lint</item>
  <item>RFC-1464: delegate mechanical task classes to cheap tier — agent.delegate, tiers.validate, invoke adapters</item>
  <item>RFC-1464: apply r1 repairs — envelope via DELEGATE_ENVELOPE env, real boundary diff, gate flags, DEL renumber</item>
  <item>RFC-1464: apply r2 repairs — raw-entry DEL-01 lint, pilot gate flags, endpoint scan, malformed-gate guard</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import { gateName, loadDelegable } from "./agent-delegate.ts";
import { loadBinding, validateBindingShape } from "../invoke-adapter.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface TierDiagnostic {
  ruleId: "DEL-01" | "DEL-02" | "DEL-03" | "DEL-04" | "DEL-05";
  severity: "warning" | "error";
  target: string;
  message: string;
}

export interface TiersValidateData {
  command: "agent.delegate.tiers.validate";
  status: "ok" | "violations";
  classes: number;
  diagnostics: TierDiagnostic[];
}

const SECRET_RE = /^(sk-|ghp_|AKIA|-----BEGIN)|[A-Za-z0-9+/]{32,}={0,2}$/;

export async function runAgentTiersValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<TiersValidateData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const diagnostics: TierDiagnostic[] = [];

  const forgeYaml = await io.readFile(path.join(root, "forge.yaml")).catch(() => null);
  const parsed = forgeYaml === null ? null : yamlParse(forgeYaml);
  // DEL-01 must see malformed entries — lint the raw list, not the filtered one.
  const rawClasses = ((parsed as { delegable?: unknown[] } | null)?.delegable ?? []) as Record<string, unknown>[];
  const classes = loadDelegable(parsed);
  const covered = new Set(classes.map((c) => c.class));
  for (const d of rawClasses) {
    const name = typeof d.class === "string" ? d.class : "(malformed)";
    const gate = d.gate;
    if (covered.has(name)) continue;
    if (typeof d.class !== "string" || !Array.isArray(gate) || gate.length === 0) {
      diagnostics.push({
        ruleId: "DEL-01",
        severity: "error",
        target: name,
        message: `${name}: gate[] empty or missing — an ungated delegation returns verdict:done without verification`,
      });
      continue;
    }
    const bad = gate.find(
      (g) => typeof g !== "string" && !(typeof g === "object" && g !== null && typeof (g as { command?: unknown }).command === "string"),
    );
    if (bad !== undefined) {
      diagnostics.push({
        ruleId: "DEL-02",
        severity: "error",
        target: name,
        message: `${name}: malformed gate entry ${JSON.stringify(bad)} — declare a command name or { command, flags }`,
      });
    }
  }

  // Registered command names — the manifest is the autonomous source.
  const manifestSrc = await io
    .readFile(path.join(root, "docs", "command-manifest.generated.yaml"))
    .catch(() => null);
  const manifest = manifestSrc === null ? null : (yamlParse(manifestSrc) as { commands?: { name?: string }[] } | null);
  const registered = new Set((manifest?.commands ?? []).map((c) => c.name).filter((n): n is string => typeof n === "string"));

  if (registered.size === 0 && manifestSrc === null) {
    diagnostics.push({
      ruleId: "DEL-02",
      severity: "warning",
      target: "forge.yaml",
      message: "docs/command-manifest.generated.yaml absent — gate resolution unverified; regenerate the manifest",
    });
  }
  for (const d of classes) {
    if (!Array.isArray(d.gate) || d.gate.length === 0) {
      diagnostics.push({
        ruleId: "DEL-01",
        severity: "error",
        target: d.class,
        message: `${d.class}: gate[] is empty — an ungated delegation returns verdict:done without verification (DNA-106 unverified-success surface)`,
      });
      continue;
    }
    for (const ref of d.gate) {
      const gateCmd = gateName(ref);
      if (registered.size > 0 && !registered.has(gateCmd)) {
        diagnostics.push({
          ruleId: "DEL-02",
          severity: "error",
          target: d.class,
          message: `${d.class}: gate command "${gateCmd}" does not resolve to a registered command — a delegable class's gate must be verifiable`,
        });
      } else if (!/validate|check|lint/.test(gateCmd)) {
        diagnostics.push({
          ruleId: "DEL-02",
          severity: "warning",
          target: d.class,
          message: `${d.class}: gate "${gateCmd}" is not a validate/check/lint command — gates must be verification commands, not mutation`,
        });
      }
    }
    if (!d.schema || typeof d.schema !== "object" || Object.keys(d.schema).length === 0) {
      diagnostics.push({
        ruleId: "DEL-03",
        severity: "error",
        target: d.class,
        message: `${d.class}: missing input schema — the class's input contract must be machine-checkable`,
      });
    }
    if (!Array.isArray(d.boundary) || d.boundary.length === 0) {
      diagnostics.push({
        ruleId: "DEL-04",
        severity: "error",
        target: d.class,
        message: `${d.class}: missing boundary note — declare the write-scope paths the delegate may touch`,
      });
    }
  }

  // Binding shape + secret material — env refs only, never literals.
  const binding = loadBinding(parsed, "cheap");
  if (classes.length > 0 && !binding) {
    diagnostics.push({
      ruleId: "DEL-05",
      severity: "error",
      target: "agentTiers.cheap",
      message: "agentTiers.cheap binding unresolvable — declare { provider, invoke } in forge.yaml",
    });
  } else if (binding) {
    const shape = validateBindingShape(binding);
    if (shape !== null) {
      diagnostics.push({ ruleId: "DEL-05", severity: "error", target: "agentTiers.cheap", message: `agentTiers.cheap: ${shape}` });
    }
    const scan = (label: string, value: unknown): void => {
      if (typeof value === "string" && SECRET_RE.test(value)) {
        diagnostics.push({
          ruleId: "DEL-05",
          severity: "error",
          target: `agentTiers.cheap.${label}`,
          message: `agentTiers.cheap.${label}: literal secret material in committed config — env refs only`,
        });
      }
    };
    for (const [k, v] of Object.entries(binding as unknown as Record<string, unknown>)) {
      if (typeof v === "string" && /key|token|secret/i.test(k)) scan(k, v);
    }
    const inv = binding.invoke as { argv?: unknown; env?: Record<string, unknown>; endpoint?: unknown; endpointRef?: unknown; keyRef?: unknown };
    if (Array.isArray(inv.argv)) inv.argv.forEach((v, i) => { if (typeof v === "string") scan(`invoke.argv[${i}]`, v); });
    if (inv.env && typeof inv.env === "object") {
      for (const [k, v] of Object.entries(inv.env)) scan(`invoke.env.${k}`, v);
    }
    // endpoint/key references must be env-ref names, never literal URLs/keys
    const endpointValue = (binding as { endpoint?: unknown }).endpoint ?? inv.endpoint;
    if (typeof endpointValue === "string" && /^https?:\/\//.test(endpointValue)) {
      diagnostics.push({
        ruleId: "DEL-05",
        severity: "error",
        target: "agentTiers.cheap.endpoint",
        message: "endpoint carries a literal URL — declare endpointRef: <env-var-name> instead",
      });
    }
    if (typeof inv.keyRef === "string" && SECRET_RE.test(inv.keyRef)) {
      scan("invoke.keyRef", inv.keyRef);
    }
  }

  const errors = diagnostics.filter((d) => d.severity === "error");
  if (context.outputFormat === "pretty") {
    for (const d of diagnostics) context.logger.warn(`${d.ruleId} ${d.message}`);
  }
  return {
    data: {
      command: "agent.delegate.tiers.validate",
      status: errors.length > 0 ? "violations" : "ok",
      classes: classes.length,
      diagnostics,
    },
    summary: `${diagnostics.length} delegation diagnostic(s) over ${classes.length} declared class(es)`,
    exitCode: errors.length > 0 ? 1 : 0,
  };
}
