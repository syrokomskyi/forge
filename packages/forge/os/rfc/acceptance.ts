/*
<MODULE_CONTRACT>
<purpose>
RFC-0268: makes RFC acceptance criteria machine-checkable. RFCs may declare a
typed `acceptance:` list of probes in frontmatter; rfc.acceptance.run executes
them and reports pass/fail per probe, so an implementation claim is
reproducible by anyone with one command instead of trusting the implementer's
prose checklist.
</purpose>
<non-goals>
  <item>Do not run automatically inside rfc.validate — probes may run builds; on-demand only.</item>
  <item>Do not allow arbitrary shell in `run` probes — the command string must start with "werkstatt ".</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0268: initial implementation.</item>
</CHANGE_SUMMARY>
*/

import { spawn } from "node:child_process";
import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as yamlParse } from "yaml";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  CommandRegistry,
} from "../../src/types.ts";
import type { AcceptanceProbe, ProbeResult, RfcAcceptanceRunResult } from "./types.ts";
import { RFC_DIR } from "./types.ts";
import { listRfcFiles, readAndParseRfc } from "./frontmatter-io.ts";

const RUN_PROBE_ALLOWED_PREFIX = "werkstatt ";

async function loadManifestCommandNames(workspaceRoot: string): Promise<Set<string>> {
  const manifestPath = path.join(workspaceRoot, "docs", "command-manifest.generated.yaml");
  try {
    const raw = await readFile(manifestPath, "utf-8");
    const manifest = yamlParse(raw) as { commands?: Array<{ name: string }> };
    return new Set((manifest.commands ?? []).map((c) => c.name));
  } catch {
    return new Set();
  }
}
const RUN_PROBE_TIMEOUT_MS = 120_000;

export interface AcceptanceShapeIssue {
  index: number;
  message: string;
}

/**
 * Pure shape validator for a raw `acceptance:` frontmatter value. Returns an
 * empty array when the value is absent (acceptance is optional) or well-formed.
 */
export function validateAcceptanceShape(value: unknown): AcceptanceShapeIssue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return [{ index: -1, message: "acceptance must be a list of probe objects" }];
  }

  const issues: AcceptanceShapeIssue[] = [];
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      issues.push({ index, message: "probe entry must be an object" });
      return;
    }
    const probe = (entry as Record<string, unknown>)["probe"];
    switch (probe) {
      case "run": {
        const command = (entry as Record<string, unknown>)["command"];
        const expect = (entry as Record<string, unknown>)["expect"];
        if (typeof command !== "string" || !command.startsWith(RUN_PROBE_ALLOWED_PREFIX)) {
          issues.push({
            index,
            message: `probe "run" command must be a string starting with "${RUN_PROBE_ALLOWED_PREFIX}"`,
          });
        }
        if (
          !expect ||
          typeof expect !== "object" ||
          typeof (expect as Record<string, unknown>)["exitCode"] !== "number"
        ) {
          issues.push({ index, message: 'probe "run" requires expect: { exitCode: <number> }' });
        }
        break;
      }
      case "file-exists": {
        if (typeof (entry as Record<string, unknown>)["path"] !== "string") {
          issues.push({ index, message: 'probe "file-exists" requires a string "path"' });
        }
        break;
      }
      case "file-contains": {
        const p = (entry as Record<string, unknown>)["path"];
        const pattern = (entry as Record<string, unknown>)["pattern"];
        if (typeof p !== "string")
          issues.push({ index, message: 'probe "file-contains" requires a string "path"' });
        if (typeof pattern !== "string") {
          issues.push({ index, message: 'probe "file-contains" requires a string "pattern"' });
        }
        break;
      }
      case "command-registered": {
        if (typeof (entry as Record<string, unknown>)["name"] !== "string") {
          issues.push({ index, message: 'probe "command-registered" requires a string "name"' });
        }
        break;
      }
      case "page": {
        const p = (entry as Record<string, unknown>)["path"];
        if (typeof p !== "string" || !p.startsWith("/")) {
          issues.push({
            index,
            message: 'probe "page" requires a string "path" starting with "/"',
          });
        }
        const expectStatus = (entry as Record<string, unknown>)["expectStatus"];
        if (expectStatus !== undefined && typeof expectStatus !== "number") {
          issues.push({ index, message: 'probe "page" expectStatus must be a number if present' });
        }
        const selector = (entry as Record<string, unknown>)["selector"];
        if (selector !== undefined && typeof selector !== "string") {
          issues.push({ index, message: 'probe "page" selector must be a string if present' });
        }
        const textPattern = (entry as Record<string, unknown>)["textPattern"];
        if (textPattern !== undefined && typeof textPattern !== "string") {
          issues.push({ index, message: 'probe "page" textPattern must be a string if present' });
        }
        const allowConsoleErrors = (entry as Record<string, unknown>)["allowConsoleErrors"];
        if (allowConsoleErrors !== undefined && typeof allowConsoleErrors !== "boolean") {
          issues.push({
            index,
            message: 'probe "page" allowConsoleErrors must be a boolean if present',
          });
        }
        break;
      }
      default:
        issues.push({
          index,
          message: `unknown probe kind "${String(probe)}" — expected one of: run, file-exists, file-contains, command-registered, page`,
        });
    }
  });

  return issues;
}

async function spawnSiteKernel(
  workspaceRoot: string,
  commandLine: string,
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  const args = commandLine
    .slice(RUN_PROBE_ALLOWED_PREFIX.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const binPath = path.join(workspaceRoot, "packages", "werkstatt", "bin", "werkstatt.mjs");

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: workspaceRoot,
      stdio: "ignore",
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ exitCode: null, timedOut: true });
    }, RUN_PROBE_TIMEOUT_MS);
    timer.unref?.();

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut: false });
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut: false });
    });
  });
}

/** Executes a single probe. Pure aside from its declared filesystem/process/registry effects. */
export async function runProbe(
  probe: AcceptanceProbe,
  workspaceRoot: string,
  commandRegistry?: CommandRegistry,
): Promise<ProbeResult> {
  switch (probe.probe) {
    case "run": {
      if (!probe.command.startsWith(RUN_PROBE_ALLOWED_PREFIX)) {
        return {
          probe,
          ok: false,
          detail: `rejected: command must start with "${RUN_PROBE_ALLOWED_PREFIX}"`,
        };
      }
      const { exitCode, timedOut } = await spawnSiteKernel(workspaceRoot, probe.command);
      if (timedOut) {
        return { probe, ok: false, detail: `timed out after ${RUN_PROBE_TIMEOUT_MS}ms` };
      }
      const ok = exitCode === probe.expect.exitCode;
      return { probe, ok, detail: `exitCode=${exitCode} (expected ${probe.expect.exitCode})` };
    }
    case "file-exists": {
      try {
        await stat(path.join(workspaceRoot, probe.path));
        return { probe, ok: true, detail: "exists" };
      } catch {
        return { probe, ok: false, detail: "does not exist" };
      }
    }
    case "file-contains": {
      try {
        const content = await readFile(path.join(workspaceRoot, probe.path), "utf8");
        const re = new RegExp(probe.pattern, "m");
        const ok = re.test(content);
        return { probe, ok, detail: ok ? "pattern found" : "pattern not found" };
      } catch {
        return { probe, ok: false, detail: "file could not be read" };
      }
    }
    case "command-registered": {
      const registryNames = new Set((commandRegistry?.listCommands() ?? []).map((c) => c.name));
      if (!registryNames.has(probe.name)) {
        const manifestNames = await loadManifestCommandNames(workspaceRoot);
        for (const name of manifestNames) {
          registryNames.add(name);
        }
      }
      const ok = registryNames.has(probe.name);
      return { probe, ok, detail: ok ? "registered" : "not registered" };
    }
    case "page": {
      return {
        probe,
        ok: true,
        detail: "page probe skipped — run qa.independent.run against a built dist",
      };
    }
  }
}

export async function runRfcAcceptanceRun(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcAcceptanceRunResult>> {
  const { workspaceRoot } = context;
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);
  const targetId = input.flags["id"] as string | undefined;
  const targetStatus = input.flags["status"] as string | undefined;

  if (!targetId && !targetStatus) {
    return {
      data: { command: "rfc.acceptance.run", status: "pass", diagnostics: [], results: [] },
      exitCode: 0,
      summary:
        "rfc.acceptance.run: pass --id <rfc-id> or --status <status> to select target RFC(s)",
    };
  }

  const allFiles = await listRfcFiles(rfcDirPath);
  const results: RfcAcceptanceRunResult["results"] = [];
  const diagnostics: Diagnostic[] = [];

  for (const fileName of allFiles) {
    const parsedFile = await readAndParseRfc(rfcDirPath, fileName);
    if (!parsedFile) continue;
    if ("error" in parsedFile) continue;
    const fm = parsedFile.parsed.frontmatter;
    const rfcId = String(fm["id"] ?? "");

    if (targetId && rfcId.toLowerCase() !== targetId.toLowerCase()) continue;
    if (targetStatus && String(fm["status"] ?? "") !== targetStatus) continue;

    const acceptance = fm["acceptance"];
    const relFile = path.join(RFC_DIR, fileName);
    const status = String(fm["status"] ?? "");

    if (!Array.isArray(acceptance) || acceptance.length === 0) {
      if (status === "accepted" || status === "implemented") {
        diagnostics.push({
          ruleId: "RFC-ACC-02",
          severity: "info",
          file: relFile,
          message: `${rfcId} (${status}) declares no acceptance probes.`,
        });
      }
      results.push({ rfcId, probeResults: [] });
      continue;
    }

    const probeResults: ProbeResult[] = [];
    let pageProbeCount = 0;
    for (const raw of acceptance as AcceptanceProbe[]) {
      if (raw.probe === "page") {
        pageProbeCount++;
        probeResults.push({
          probe: raw,
          ok: true,
          detail: "page probe skipped — run qa.independent.run against a built dist",
        });
        continue;
      }
      const result = await runProbe(raw, workspaceRoot, context.commandRegistry);
      probeResults.push(result);
      if (!result.ok) {
        diagnostics.push({
          ruleId: "RFC-ACC-01",
          severity: "error",
          file: relFile,
          message: `${rfcId}: probe "${raw.probe}" failed — ${result.detail}.`,
        });
      }
    }
    if (pageProbeCount > 0) {
      diagnostics.push({
        ruleId: "RFC-ACC-03",
        severity: "info",
        file: relFile,
        message: `${pageProbeCount} page probe(s) skipped — run \`qa.independent.run --site <app>\` against a built dist.`,
      });
    }
    results.push({ rfcId, probeResults });
  }

  const failedCount = diagnostics.filter((d) => d.severity === "error").length;
  const status: RfcAcceptanceRunResult["status"] = failedCount > 0 ? "fail" : "pass";

  return {
    data: { command: "rfc.acceptance.run", status, diagnostics, results },
    exitCode: failedCount > 0 ? 1 : 0,
    summary: `rfc.acceptance.run: ${results.length} RFC(s), ${failedCount} failed probe(s)`,
  };
}
