/*
<MODULE_CONTRACT>
<purpose>forge.conformance.validate command handler (RFC-1365) — fail-closed
lint over forge.yaml contractProducers[] declarations. CONF-01 entry schema +
{bundle} placeholder, CONF-02 test wiring, CONF-03 argv script-path resolution,
CONF-04 absent consumer.root (warning), CONF-05 duplicate ids, CONF-06 missing
mirror (warning).</purpose>
<non-goals>
  <item>Do not run the conformance legs — this is a static lint; forge.conformance.run executes.</item>
  <item>Do not execute or re-implement consumer validation rules.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1365: step 2 — forge.conformance.validate handler (CONF-01..06).</item>
  <item>RFC-1365: step 2 — forge.conformance.run/validate commands + dual-surface registration</item>
  <item>RFC-1365: review round 1 — CONF-03 rescoped producer-side (Q-9), producers[] json shape, crash guard + leg output, transport attribution, env semantics, writes declared, regen sweep</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as parseYaml } from "yaml";
import * as fs from "../../../src/utils/sync-fs.ts";
import { contractProducerSchema } from "../../../src/config/forge-config.ts";
import type { ContractProducerDecl } from "../../../src/conformance/index.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface ConformanceValidateResult {
  command: "forge.conformance.validate";
  status: "pass" | "warn" | "fail";
  producers: number;
  diagnostics: Diagnostic[];
  summary: { error: number; warning: number; info: number };
}

const BUNDLE_PLACEHOLDER = "{bundle}";
const HELPER_SPECIFIER = "@warpgogol/forge/conformance";
const COMMAND_SPECIFIER = "forge.conformance.run";
const SCRIPT_EXT_RE = /\.(ts|js|mjs|cjs)$/;
const PATH_SEP_RE = /[/\\]/;
const FLAG_TOKEN_RE = /^--?[a-zA-Z]/;

interface ParsedEntry {
  index: number;
  raw: unknown;
  decl: ContractProducerDecl | null;
}

function diagnostic(
  ruleId: string,
  severity: Diagnostic["severity"],
  message: string,
  producer?: string,
): Diagnostic {
  return {
    ruleId,
    severity,
    message,
    file: "forge.yaml",
    data: producer !== undefined ? { producer } : undefined,
  };
}

function hasBundlePlaceholder(argv: string[] | undefined): boolean {
  return argv !== undefined && argv.some((arg) => arg.includes(BUNDLE_PLACEHOLDER));
}

/**
 * CONF-03 (Q-3 option B): the first non-flag argv element that ends in a
 * script extension or contains a path separator must resolve from `base`.
 * Elements consumed as flag values (token after a `--flag` without `=`), bare
 * binary/subcommand names, and `{bundle}`-carrying args are skipped; argv with
 * no path-looking element passes vacuously.
 */
function firstResolvableScriptArg(argv: string[]): string | null {
  let skipNext = false;
  for (const arg of argv) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (FLAG_TOKEN_RE.test(arg)) {
      if (!arg.includes("=")) skipNext = true;
      continue;
    }
    if (arg.includes(BUNDLE_PLACEHOLDER)) continue;
    if (SCRIPT_EXT_RE.test(arg) || PATH_SEP_RE.test(arg)) {
      return arg;
    }
  }
  return null;
}

function checkArgvPaths(
  argv: string[] | undefined,
  baseDir: string,
  producerId: string,
  field: string,
  diagnostics: Diagnostic[],
): void {
  if (argv === undefined) return;
  const candidate = firstResolvableScriptArg(argv);
  if (candidate === null) return;
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(baseDir, candidate);
  if (!fs.existsSync(resolved)) {
    diagnostics.push(
      diagnostic(
        "CONF-03",
        "error",
        `producer "${producerId}": ${field} script path does not resolve from ${field.startsWith("consumer") ? "consumer.root" : "repo root"}: ${candidate}`,
        producerId,
      ),
    );
  }
}

export async function runConformanceValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ConformanceValidateResult>> {
  const { workspaceRoot } = context;
  const diagnostics: Diagnostic[] = [];

  const configPath = path.join(workspaceRoot, "forge.yaml");
  if (!fs.existsSync(configPath)) {
    return {
      data: {
        command: "forge.conformance.validate",
        status: "pass",
        producers: 0,
        diagnostics: [],
        summary: { error: 0, warning: 0, info: 0 },
      },
      summary: "forge.conformance.validate: no forge.yaml — 0 producers declared",
      exitCode: 0,
    };
  }

  let rawConfig: unknown;
  try {
    rawConfig = parseYaml(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    diagnostics.push(
      diagnostic("CONF-01", "error", `forge.yaml is not valid YAML: ${(err as Error).message}`),
    );
  }

  const rawProducers =
    rawConfig !== undefined &&
    typeof rawConfig === "object" &&
    rawConfig !== null &&
    "contractProducers" in rawConfig
      ? (rawConfig as Record<string, unknown>)["contractProducers"]
      : undefined;

  const entries: ParsedEntry[] = [];
  if (rawProducers !== undefined) {
    if (!Array.isArray(rawProducers)) {
      diagnostics.push(
        diagnostic("CONF-01", "error", "contractProducers must be an array of producer entries"),
      );
    } else {
      for (const [index, raw] of rawProducers.entries()) {
        const parsed = contractProducerSchema.safeParse(raw);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ");
          const id =
            raw !== null && typeof raw === "object" && "id" in raw
              ? String((raw as { id: unknown }).id)
              : `#${index}`;
          diagnostics.push(
            diagnostic(
              "CONF-01",
              "error",
              `producer "${id}": malformed declaration — ${issues}`,
              id,
            ),
          );
          entries.push({ index, raw, decl: null });
        } else {
          entries.push({ index, raw, decl: parsed.data as ContractProducerDecl });
        }
      }
    }
  }

  const seenIds = new Set<string>();
  for (const entry of entries) {
    const decl = entry.decl;
    if (decl === null) continue;

    // CONF-01: {bundle} placeholder required on emit + consumer validator argv
    if (!hasBundlePlaceholder(decl.emit.argv)) {
      diagnostics.push(
        diagnostic(
          "CONF-01",
          "error",
          `producer "${decl.id}": emit.argv carries no ${BUNDLE_PLACEHOLDER} placeholder — emit cannot locate the forge-provided bundle dir`,
          decl.id,
        ),
      );
    }
    if (!hasBundlePlaceholder(decl.consumer.validator.argv)) {
      diagnostics.push(
        diagnostic(
          "CONF-01",
          "error",
          `producer "${decl.id}": consumer.validator.argv carries no ${BUNDLE_PLACEHOLDER} placeholder — the validator cannot locate the emitted bundle`,
          decl.id,
        ),
      );
    }

    // CONF-05: duplicate producer id
    if (seenIds.has(decl.id)) {
      diagnostics.push(
        diagnostic(
          "CONF-05",
          "error",
          `duplicate producer id "${decl.id}" — ids must be unique across contractProducers[]`,
          decl.id,
        ),
      );
    }
    seenIds.add(decl.id);

    // CONF-06: mirror omitted — stricter-than-consumer drift leg unarmed
    if (decl.mirror === undefined) {
      diagnostics.push(
        diagnostic(
          "CONF-06",
          "warning",
          `producer "${decl.id}": no mirror argv — mirror-stricter-than-consumer drift detection is unarmed`,
          decl.id,
        ),
      );
    }

    // CONF-02: declared test must exist and reference a sanctioned wiring
    if (decl.test === undefined) {
      diagnostics.push(
        diagnostic(
          "CONF-02",
          "error",
          `producer "${decl.id}": no test field — the producer has no declared conformance coverage`,
          decl.id,
        ),
      );
    } else {
      const testPath = path.isAbsolute(decl.test)
        ? decl.test
        : path.resolve(workspaceRoot, decl.test);
      if (!fs.existsSync(testPath)) {
        diagnostics.push(
          diagnostic(
            "CONF-02",
            "error",
            `producer "${decl.id}": declared test file missing: ${decl.test}`,
            decl.id,
          ),
        );
      } else {
        const content = fs.readFileSync(testPath, "utf8");
        if (!content.includes(HELPER_SPECIFIER) && !content.includes(COMMAND_SPECIFIER)) {
          diagnostics.push(
            diagnostic(
              "CONF-02",
              "error",
              `producer "${decl.id}": test ${decl.test} references neither ${HELPER_SPECIFIER} nor ${COMMAND_SPECIFIER} — a bare producer-id mention is not conformance wiring`,
              decl.id,
            ),
          );
        }
      }
    }

    // CONF-04: consumer root absent — self-skip dead-gate risk (warning)
    const consumerRoot = path.isAbsolute(decl.consumer.root)
      ? decl.consumer.root
      : path.resolve(workspaceRoot, decl.consumer.root);
    const consumerRootExists = fs.existsSync(consumerRoot);
    if (!consumerRootExists) {
      diagnostics.push(
        diagnostic(
          "CONF-04",
          "warning",
          `producer "${decl.id}": consumer.root absent on this machine (${decl.consumer.root}) — runs will self-skip here; enforce --require-consumer where the checkout is guaranteed`,
          decl.id,
        ),
      );
    }

    // CONF-03 (Q-9): producer-side argv only — consumer-side execution errors
    // surface as consumer-leg transport failures at run time, keeping this lint
    // single-repo-scoped and machine-independent.
    checkArgvPaths(decl.emit.argv, workspaceRoot, decl.id, "emit.argv", diagnostics);
    checkArgvPaths(decl.mirror?.argv, workspaceRoot, decl.id, "mirror.argv", diagnostics);
  }

  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity] += 1;
  const status = counts.error > 0 ? "fail" : counts.warning > 0 ? "warn" : "pass";

  const { logger } = context;
  if (context.outputFormat === "pretty") {
    for (const d of diagnostics) {
      const line = `  ${d.ruleId}: ${d.message}`;
      if (d.severity === "error") logger.error(line);
      else if (d.severity === "warning") logger.warn(line);
      else logger.info(line);
    }
  }

  return {
    data: {
      command: "forge.conformance.validate",
      status,
      producers: entries.length,
      diagnostics,
      summary: counts,
    },
    summary:
      entries.length === 0 && diagnostics.length === 0
        ? "forge.conformance.validate: OK — no contract producers declared"
        : `forge.conformance.validate: ${status.toUpperCase()} — ${counts.error} error(s), ${counts.warning} warning(s) across ${entries.length} producer(s)`,
    exitCode: status === "fail" ? 1 : 0,
  };
}
