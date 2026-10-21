/*
<MODULE_CONTRACT>
<purpose>forge.conformance.run command handler (RFC-1365) — runs the shared
golden-conformance execution path (emit → mirror → consumer legs) for declared
contractProducers[]. Leg attribution per producer; absent consumer checkouts
self-skip by default and fail closed under --require-consumer /
FORGE_CONFORMANCE_REQUIRE.</purpose>
<non-goals>
  <item>Do not implement leg mechanics here — src/conformance/index.ts owns spawn, tmpdir, substitution, cleanup.</item>
  <item>Do not mutate repo files — legs write only the mkdtemp bundle dir.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1365: step 2 — forge.conformance.run handler over the shared execution path.</item>
  <item>RFC-1365: step 2 — forge.conformance.run/validate commands + dual-surface registration</item>
  <item>RFC-1365: review round 1 — CONF-03 rescoped producer-side (Q-9), producers[] json shape, crash guard + leg output, transport attribution, env semantics, writes declared, regen sweep</item>
</CHANGE_SUMMARY>
*/

import { loadForgeConfig } from "../../../src/config/forge-config.ts";
import { runProducerConformance, type ConformanceVerdict } from "../../../src/conformance/index.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface ConformanceRunResult {
  command: "forge.conformance.run";
  status: "pass" | "fail" | "skip";
  producers: ConformanceVerdict[];
  summary: { pass: number; fail: number; skip: number };
}

const REQUIRE_ENV = "FORGE_CONFORMANCE_REQUIRE";

function requireModeEnabled(input: ForgeCommandInput): boolean {
  if (input.flags["require-consumer"] === true) return true;
  const env = process.env[REQUIRE_ENV];
  return env === "1" || env?.toLowerCase() === "true";
}

function producerSelection(input: ForgeCommandInput): { all: boolean; ids: string[] } {
  const raw = input.flags["producer"];
  const ids = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return { all: input.flags["all"] === true, ids };
}

function usageError(message: string): ForgeCommandResult<ConformanceRunResult> {
  return {
    data: {
      command: "forge.conformance.run",
      status: "fail",
      producers: [],
      summary: { pass: 0, fail: 0, skip: 0 },
    },
    summary: `forge.conformance.run: ${message}`,
    exitCode: 2,
  };
}

export async function runConformanceRun(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ConformanceRunResult>> {
  const { workspaceRoot, logger } = context;
  const { all, ids } = producerSelection(input);

  if (all && ids.length > 0) {
    return usageError("--all cannot be combined with --producer — pick one selection mode");
  }

  let producers;
  try {
    producers = loadForgeConfig(workspaceRoot, context.forgeRoot).contractProducers ?? [];
  } catch (err) {
    return {
      data: {
        command: "forge.conformance.run",
        status: "fail",
        producers: [],
        summary: { pass: 0, fail: 0, skip: 0 },
      },
      summary: `forge.conformance.run: ${(err as Error).message}`,
      exitCode: 1,
    };
  }

  let selected = producers;
  if (!all && ids.length > 0) {
    const declared = new Set(producers.map((p) => p.id));
    const unknown = ids.filter((id) => !declared.has(id));
    if (unknown.length > 0) {
      return usageError(
        `unknown producer id(s): ${unknown.join(", ")} — declared: ${[...declared].join(", ") || "(none)"}`,
      );
    }
    selected = producers.filter((p) => ids.includes(p.id));
  }

  const requireConsumer = requireModeEnabled(input);
  const verdicts: ConformanceVerdict[] = [];

  for (const decl of selected) {
    let verdict: ConformanceVerdict;
    try {
      verdict = await runProducerConformance(decl, {
        repoRoot: workspaceRoot,
        requireConsumer,
      });
    } catch (err) {
      verdict = {
        producer: decl.id,
        status: "fail",
        failedLeg: "emit",
        legs: [],
        diagnostics: [`producer-level failure before legs could run: ${(err as Error).message}`],
      };
    }
    verdicts.push(verdict);

    if (context.outputFormat === "pretty") {
      if (verdict.status === "pass") {
        logger.success(`  ${verdict.producer}: pass`);
      } else if (verdict.status === "skip") {
        logger.warn(`  ${verdict.producer}: skip`);
      } else {
        logger.error(`  ${verdict.producer}: fail (leg: ${verdict.failedLeg ?? "unknown"})`);
      }
      for (const leg of verdict.legs) {
        const code = leg.exitCode !== undefined ? ` exit=${leg.exitCode}` : "";
        const trunc = leg.truncated ? " [output tail-truncated]" : "";
        logger.info(`    ${leg.leg}: ${leg.status} (${leg.durationMs}ms)${code}${trunc}`);
        if (leg.status === "fail" && leg.output) {
          for (const line of leg.output.split("\n")) {
            logger.info(`      | ${line}`);
          }
        }
      }
      for (const diagnostic of verdict.diagnostics) {
        if (verdict.status === "fail") {
          logger.error(`    ${diagnostic}`);
        } else {
          logger.warn(`    ${diagnostic}`);
        }
      }
    }
  }

  const counts = {
    pass: verdicts.filter((v) => v.status === "pass").length,
    fail: verdicts.filter((v) => v.status === "fail").length,
    skip: verdicts.filter((v) => v.status === "skip").length,
  };
  const status =
    counts.fail > 0
      ? "fail"
      : counts.skip === verdicts.length && verdicts.length > 0
        ? "skip"
        : "pass";

  return {
    data: {
      command: "forge.conformance.run",
      status,
      producers: verdicts,
      summary: counts,
    },
    summary:
      verdicts.length === 0
        ? "forge.conformance.run: no contract producers declared"
        : `forge.conformance.run: ${counts.pass} pass, ${counts.skip} skip, ${counts.fail} fail`,
    exitCode: counts.fail > 0 ? 1 : 0,
  };
}
