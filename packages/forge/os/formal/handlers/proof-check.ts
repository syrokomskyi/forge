/*
<MODULE_CONTRACT>
<purpose>proof.check command handler (RFC-1391) — runs a forge/proof-spec@1
file through the shared runner and returns the mechanical checker verdict.
Exit 0 only when the verdict is `proved`; every other verdict is non-zero.
This command is the only sanctioned source of formal-tier evidence — an
agent-written argument never satisfies a `proof` probe.</purpose>
<non-goals>
  <item>Do not parse or weaken specs — src/formal/proof-runner.ts owns the verdict path.</item>
  <item>Do not run as part of the default build pipeline — formal checks are invoked on demand.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1391: proof.check handler over the shared runner.</item>
  <item>RFC-1391: make the formal verification tier checker-bound (RFC-1391)</item>
  <item>RFC-1391: close RFC-1391 review r1 findings — evidence freshness, config classification, contract guards

REVIEW-CODE-2026-10-24-04 (warning): a stale .cache/proofs report could
fabricate proved; forge.yaml now resolves inside runProofCheck so a malformed
config is error not unavailable, and both surfaces share one path; {entry} is
required in formal.tools.command; spec/entry paths are confined to the
workspace; the exhaustive entry dispatches per packageManager; proved runs
record log, counterexample stays the refuted-path record.</item>
</CHANGE_SUMMARY>
*/

import { runProofCheck } from "../../../src/formal/index.ts";
import type { ProofCheckResult } from "../../../src/formal/index.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface ProofCheckCommandResult {
  command: "proof.check";
  status: "pass" | "fail";
  spec: string | null;
  verdict: ProofCheckResult | null;
}

function missingSpecResult(message: string): ForgeCommandResult<ProofCheckCommandResult> {
  return {
    data: { command: "proof.check", status: "fail", spec: null, verdict: null },
    summary: `proof.check: ${message}`,
    exitCode: 2,
  };
}

export async function runProofCheckCommand(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ProofCheckCommandResult>> {
  const { workspaceRoot } = context;
  const specRelPath = input.flags["spec"] as string | undefined;
  if (!specRelPath) {
    return missingSpecResult("--spec <path> is required — a forge/proof-spec@1 YAML file");
  }

  const timeoutFlag = input.flags["timeout-ms"];
  const parsedTimeout =
    typeof timeoutFlag === "string" && /^\d+$/.test(timeoutFlag) ? Number(timeoutFlag) : NaN;
  const timeoutMs = parsedTimeout > 0 ? parsedTimeout : undefined;
  const verdict = await runProofCheck({
    workspaceRoot,
    specRelPath,
    forgeRoot: context.forgeRoot,
    timeoutMs,
  });
  const proved = verdict.verdict === "proved";
  if (context.outputFormat === "pretty") {
    const line = `${specRelPath}: ${verdict.verdict} — ${verdict.message}`;
    if (proved) context.logger.success(line);
    else context.logger.error(line);
    if (verdict.counterexample) {
      context.logger.info(`  counterexample/log: ${verdict.counterexample}`);
    }
  }
  return {
    data: {
      command: "proof.check",
      status: proved ? "pass" : "fail",
      spec: specRelPath,
      verdict,
    },
    summary: `proof.check: ${specRelPath} → ${verdict.verdict} — ${verdict.message}`,
    exitCode: proved ? 0 : 1,
  };
}
