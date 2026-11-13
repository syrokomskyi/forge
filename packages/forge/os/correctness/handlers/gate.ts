/*
<MODULE_CONTRACT>
<purpose>RFC-1580: `correctness.gate` command handler — flags, exit codes
(1 on any error, 2 on usage), pretty output. Read-only except for its
bundle file under the git common dir.</purpose>
<non-goals>
  <item>No gate logic — gate/run.ts.</item>
  <item>Never passes --accept-weakening on its own — the operator decides.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: initial handler.</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { runCorrectnessGate } from "../gate/run.ts";
import type { CorrectnessGateResult } from "../gate/types.ts";

function forgeVersion(): string {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../package.json");
    return String(
      (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "unknown",
    );
  } catch {
    return "unknown";
  }
}

export async function runCorrectnessGateCommand(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<CorrectnessGateResult>> {
  const base = typeof input.flags["base"] === "string" ? (input.flags["base"] as string) : "";
  if (!base)
    return { exitCode: 2, summary: "[correctness.gate] usage error: --base <sha> is required" };
  const accept =
    typeof input.flags["accept-weakening"] === "string"
      ? (input.flags["accept-weakening"] as string)
      : undefined;
  const outcome = await runCorrectnessGate(context.workspaceRoot, {
    base,
    acceptWeakening: accept,
    forgeVersion: forgeVersion(),
    forgePath: process.argv[1],
  });
  if (!outcome.ok)
    return { exitCode: 2, summary: `[correctness.gate] usage error: ${outcome.usageError}` };
  const data = outcome.result;
  if (context.outputFormat === "pretty") {
    for (const v of data.violations) {
      const line = `${v.rule} ${v.message}`;
      if (v.severity === "error") context.logger.error(line);
      else context.logger.warn(line);
    }
  }
  const errors = data.violations.filter((v) => v.severity === "error").length;
  const summary =
    data.status === "exempt"
      ? "correctness.gate: exempt (correctness.mode: exempt)"
      : `correctness.gate: ${data.status} (mode ${data.mode}, ${errors} error(s), ${data.violations.length - errors} warning(s), ${data.weakenings.length} weakening(s)${data.acceptedWeakening ? " accepted" : ""}) — bundle ${data.bundlePath}`;
  return { data, summary, exitCode: data.status === "fail" ? 1 : 0 };
}
