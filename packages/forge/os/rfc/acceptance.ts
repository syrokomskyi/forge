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
  <item>RFC-1453: page probes execute through an OutcomeSession (outcomeBuild/outcomeServe bindings); tri-state verdicts; RFC-ACC-03 skip removed; RFC-ACC-04 reports unverified.</item>
  <item>RFC-1391: close RFC-1391 review r1 findings — evidence freshness, config classification, contract guards

REVIEW-CODE-2026-10-24-04 (warning): a stale .cache/proofs report could
fabricate proved; forge.yaml now resolves inside runProofCheck so a malformed
config is error not unavailable, and both surfaces share one path; {entry} is
required in formal.tools.command; spec/entry paths are confined to the
workspace; the exhaustive entry dispatches per packageManager; proved runs
record log, counterexample stays the refuted-path record.</item>
  <item>RFC-1445: run-probe timeoutMs + RFC-1445 outcome probe AC-9 (RFC-1445)</item>
  <item>RFC-1489: batch test probes through one instrumented Vitest run + frontmatter corpus reads

runProbeSet is the single shared execution point: barrier-free segments of test probes sharing one effective bound run in one vitest --reporter=json --outputFile process with per-(file,testName) attribution; missing files/reports yield unverified. run/page/proof and all non-test kinds are barriers. --no-batch escapes to the legacy path on acceptance.run, verification.emit and verification.refresh. rfc.validate reads non-target corpus files frontmatter-only via readRfcFrontmatter (64 KiB bound, full-parse fallback); emit/refresh/acceptance corpus scans use the same accessor. Corpus map slimmed to RfcCorpusEntry {fileName, frontmatter}.</item>
  <item>RFC-1489: resolve REVIEW-RFC-1489-R1 soft-block — spec-exact barrier semantics, dedup, verdict parity; DEV-1489-001 amend recorded</item>
  <history>RFC-0268, RFC-0998, RFC-1271, RFC-1334, RFC-1391, RFC-1401</history>
</CHANGE_SUMMARY>
*/

import { probeReachableCommand, probeReachableSymbol } from "./reachable-symbol.ts";
import { createOutcomeSession, type OutcomeSession } from "./outcome-probe.ts";
import { spawn } from "../../src/utils/sync-fs.ts";
import { ambientIo, resolveIo } from "../../src/utils/io.ts";
import { runProofCheck } from "../../src/formal/index.ts";

import path from "node:path";
import { parse as yamlParse } from "yaml";
import { Ajv } from "ajv";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  CommandRegistry,
} from "../../src/types.ts";
import type {
  AcceptanceProbe,
  ProbeResult,
  RfcAcceptanceRunResult,
  ProbeCoverageReport,
} from "./types.ts";
import { RFC_DIR, RFC_PROBE_BINDING_CUTOFF, RFC_EXPECTATION_SOURCES } from "./types.ts";
import { listRfcFiles, readAndParseRfc, readRfcFrontmatter } from "./frontmatter-io.ts";
import { planProbeSegments, runBatchedTestSegment } from "./probe-batch.ts";
import { evaluateAcceptanceCriteria, computeProbeCoverage } from "./handlers/validate-rules.ts";

// Ambient default for helper fns without a context param — handlers override
// with `const io = resolveIo(context.io)` inside their own scope.
const io = ambientIo;

const RUN_PROBE_ALLOWED_PREFIX = "werkstatt ";

async function loadManifestCommandNames(workspaceRoot: string): Promise<Set<string>> {
  const manifestPath = path.join(workspaceRoot, "docs", "command-manifest.generated.yaml");
  try {
    const raw = await io.readFile(manifestPath);
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
        const runTimeoutMs = (entry as Record<string, unknown>)["timeoutMs"];
        if (
          runTimeoutMs !== undefined &&
          (typeof runTimeoutMs !== "number" || !Number.isFinite(runTimeoutMs) || runTimeoutMs <= 0)
        ) {
          issues.push({
            index,
            message: 'probe "run" timeoutMs must be a positive number if present',
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
      case "test": {
        const file = (entry as Record<string, unknown>)["file"];
        if (typeof file !== "string") {
          issues.push({ index, message: 'probe "test" requires a string "file"' });
        }
        const testName = (entry as Record<string, unknown>)["testName"];
        if (testName !== undefined && typeof testName !== "string") {
          issues.push({ index, message: 'probe "test" testName must be a string if present' });
        }
        const timeoutMs = (entry as Record<string, unknown>)["timeoutMs"];
        if (
          timeoutMs !== undefined &&
          (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
        ) {
          issues.push({
            index,
            message: 'probe "test" timeoutMs must be a positive number if present',
          });
        }
        const expect = (entry as Record<string, unknown>)["expect"];
        if (
          !expect ||
          typeof expect !== "object" ||
          typeof (expect as Record<string, unknown>)["exitCode"] !== "number"
        ) {
          issues.push({ index, message: 'probe "test" requires expect: { exitCode: <number> }' });
        }
        break;
      }
      case "reachable": {
        const rec = entry as Record<string, unknown>;
        const hasSymbol = rec["symbol"] !== undefined;
        const hasCommand = rec["command"] !== undefined;
        if (hasSymbol === hasCommand) {
          issues.push({
            index,
            message:
              'probe "reachable" requires exactly one of "symbol" (with "module") or "command"',
          });
        } else if (hasSymbol) {
          if (typeof rec["symbol"] !== "string" || typeof rec["module"] !== "string") {
            issues.push({
              index,
              message: 'probe "reachable" symbol mode requires string "symbol" and "module"',
            });
          }
          if (rec["root"] !== undefined && typeof rec["root"] !== "string") {
            issues.push({ index, message: 'probe "reachable" "root" must be a string if present' });
          }
        } else {
          if (typeof rec["command"] !== "string") {
            issues.push({
              index,
              message: 'probe "reachable" command mode requires a string "command"',
            });
          }
          if (rec["root"] !== undefined || rec["module"] !== undefined) {
            issues.push({
              index,
              message: 'probe "reachable" command mode takes no "root" or "module"',
            });
          }
        }
        break;
      }
      case "json-schema": {
        const artifact = (entry as Record<string, unknown>)["artifact"];
        if (typeof artifact !== "string") {
          issues.push({ index, message: 'probe "json-schema" requires a string "artifact"' });
        }
        const schemaInline = (entry as Record<string, unknown>)["schemaInline"];
        if (!schemaInline || typeof schemaInline !== "object") {
          issues.push({ index, message: 'probe "json-schema" requires an object "schemaInline"' });
        }
        break;
      }
      case "proof": {
        // RFC-1391: spec path required; spec CONTENT is validated by V-46
        // (forge/proof-spec@1), not here — shape validation stays cheap.
        const spec = (entry as Record<string, unknown>)["spec"];
        if (typeof spec !== "string") {
          issues.push({ index, message: 'probe "proof" requires a string "spec"' });
        }
        break;
      }
      default:
        issues.push({
          index,
          message: `unknown probe kind "${String(probe)}" — expected one of: run, file-exists, file-contains, command-registered, page, test, json-schema, reachable, proof`,
        });
    }

    // RFC-1271: optional metadata shared by every probe kind.
    const expectationSource = (entry as Record<string, unknown>)["expectationSource"];
    if (
      expectationSource !== undefined &&
      !RFC_EXPECTATION_SOURCES.includes(
        expectationSource as (typeof RFC_EXPECTATION_SOURCES)[number],
      )
    ) {
      issues.push({
        index,
        message: `probe "expectationSource" must be one of: ${RFC_EXPECTATION_SOURCES.join(", ")}`,
      });
    }
    const limitations = (entry as Record<string, unknown>)["limitations"];
    if (limitations !== undefined && typeof limitations !== "string") {
      issues.push({ index, message: 'probe "limitations" must be a string if present' });
    }
  });

  return issues;
}

async function spawnSiteKernel(
  workspaceRoot: string,
  commandLine: string,
  timeoutMs?: number,
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  const args = commandLine
    .slice(RUN_PROBE_ALLOWED_PREFIX.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const binPath = path.join(workspaceRoot, "packages", "werkstatt-engine", "bin", "werkstatt.mjs");

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
    }, timeoutMs ?? RUN_PROBE_TIMEOUT_MS);
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

async function spawnVitest(
  workspaceRoot: string,
  file: string,
  testName?: string,
  timeoutMs?: number,
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  const args = ["exec", "vitest", "run", file];
  if (testName) {
    args.push("-t", testName);
  }
  const bound = timeoutMs ?? RUN_PROBE_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn("pnpm", args, {
      cwd: workspaceRoot,
      stdio: "ignore",
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ exitCode: null, timedOut: true });
    }, bound);
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
  forgeRoot?: string,
  outcomeSession?: OutcomeSession,
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
      const { exitCode, timedOut } = await spawnSiteKernel(
        workspaceRoot,
        probe.command,
        probe.timeoutMs,
      );
      if (timedOut) {
        return {
          probe,
          ok: false,
          detail: `timed out after ${probe.timeoutMs ?? RUN_PROBE_TIMEOUT_MS}ms`,
        };
      }
      const ok = exitCode === probe.expect.exitCode;
      return { probe, ok, detail: `exitCode=${exitCode} (expected ${probe.expect.exitCode})` };
    }
    case "file-exists": {
      try {
        await io.stat(path.join(workspaceRoot, probe.path));
        return { probe, ok: true, detail: "exists" };
      } catch {
        return { probe, ok: false, detail: "does not exist" };
      }
    }
    case "file-contains": {
      try {
        const content = await io.readFile(path.join(workspaceRoot, probe.path));
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
      // RFC-1453: page probes execute against the served output of their
      // `target` via the outcomeBuild/outcomeServe bindings. A probe that
      // cannot run reports `unverified` — never `ok` without executing.
      if (outcomeSession) {
        return outcomeSession.runPageProbe(probe);
      }
      const session = createOutcomeSession({ workspaceRoot, forgeRoot });
      try {
        return await session.runPageProbe(probe);
      } finally {
        await session.dispose();
      }
    }
    case "test": {
      const { exitCode, timedOut } = await spawnVitest(
        workspaceRoot,
        probe.file,
        probe.testName,
        probe.timeoutMs,
      );
      if (timedOut) {
        return {
          probe,
          ok: false,
          detail: `timed out after ${probe.timeoutMs ?? RUN_PROBE_TIMEOUT_MS}ms`,
        };
      }
      const ok = exitCode === probe.expect.exitCode;
      return { probe, ok, detail: `exitCode=${exitCode} (expected ${probe.expect.exitCode})` };
    }
    case "reachable": {
      const r =
        "command" in probe
          ? await probeReachableCommand({ workspaceRoot, command: probe.command })
          : await probeReachableSymbol({
              workspaceRoot,
              symbol: probe.symbol,
              module: probe.module,
              ...(probe.root ? { root: probe.root } : {}),
            });
      return { probe, ok: r.ok, detail: r.detail };
    }
    case "json-schema": {
      const artifactPath = path.join(workspaceRoot, probe.artifact);
      let raw: string;
      try {
        raw = await io.readFile(artifactPath);
      } catch {
        return { probe, ok: false, detail: "artifact file not found" };
      }
      let parsed: unknown;
      const ext = path.extname(probe.artifact).toLowerCase();
      try {
        if (ext === ".yaml" || ext === ".yml") {
          parsed = yamlParse(raw);
        } else {
          parsed = JSON.parse(raw);
        }
      } catch {
        return { probe, ok: false, detail: "artifact file could not be parsed" };
      }
      try {
        const ajv = new Ajv({ allErrors: false });
        const validate = ajv.compile(probe.schemaInline);
        const valid = validate(parsed);
        if (valid) {
          return { probe, ok: true, detail: "schema valid" };
        }
        const firstError = validate.errors?.[0];
        const errorPath = firstError?.instancePath || "(root)";
        const errorMessage = firstError?.message || "validation failed";
        return { probe, ok: false, detail: `Ajv error at ${errorPath}: ${errorMessage}` };
      } catch {
        return { probe, ok: false, detail: "schema compilation failed" };
      }
    }
    case "proof": {
      // RFC-1391: the probe is ok ⇔ the mechanical checker verdict is `proved`.
      // Shares the exact execution path — and forge.yaml resolution — with
      // the `proof.check` command.
      const verdict = await runProofCheck({
        workspaceRoot,
        specRelPath: probe.spec,
        forgeRoot,
      });
      return {
        probe,
        ok: verdict.verdict === "proved",
        detail: `${verdict.specId} → ${verdict.verdict} — ${verdict.message}`,
        proof: {
          tool: verdict.tool,
          toolVersion: verdict.toolVersion,
          verdict: verdict.verdict,
          specSha256: verdict.specSha256,
          entrySha256: verdict.entrySha256,
          ...(verdict.enumerated !== undefined ? { enumerated: verdict.enumerated } : {}),
          ...(verdict.counterexample ? { counterexample: verdict.counterexample } : {}),
          ...(verdict.log ? { log: verdict.log } : {}),
        },
      };
    }
  }
}

export interface ProbeSetOptions {
  workspaceRoot: string;
  commandRegistry?: CommandRegistry;
  forgeRoot?: string;
  outcomeSession?: OutcomeSession;
  /** RFC-1489: diagnostic escape — forces the legacy per-probe path. */
  noBatch?: boolean;
}

export interface ProbeSetResult {
  /** One entry per declared probe, in declared order. */
  results: ProbeResult[];
  /** Wall-clock ms per declared index; batched members share the segment time. */
  durationsMs: number[];
}

/**
 * RFC-1489: single shared execution point for a declared probe list.
 * Barrier-free segments of `test` probes sharing one effective bound run in
 * a single instrumented Vitest process; every other probe executes through
 * `runProbe` individually. `--no-batch` forces the legacy path entirely.
 */
export async function runProbeSet(
  probes: AcceptanceProbe[],
  options: ProbeSetOptions,
): Promise<ProbeSetResult> {
  const { workspaceRoot, commandRegistry, forgeRoot, outcomeSession, noBatch } = options;
  const results: ProbeResult[] = new Array(probes.length);
  const durationsMs: number[] = new Array(probes.length).fill(0);
  const runOne = async (p: AcceptanceProbe): Promise<ProbeResult> =>
    runProbe(p, workspaceRoot, commandRegistry, forgeRoot, outcomeSession);

  const segments = noBatch ? [] : planProbeSegments(probes, RUN_PROBE_TIMEOUT_MS);
  const segmentByStart = new Map(segments.map((s) => [s.start, s]));
  const covered = new Set<number>();

  for (let i = 0; i < probes.length; i++) {
    if (covered.has(i)) continue;
    const segment = segmentByStart.get(i);
    if (segment && segment.members.length > 1) {
      const start = performance.now();
      const segResults = await runBatchedTestSegment(probes, segment, workspaceRoot);
      const wall = Math.round(performance.now() - start);
      for (const j of segment.members) {
        results[j] = segResults.get(j)!;
        // Spec: every member records the group's measured wall time — never
        // a fabricated per-probe split.
        durationsMs[j] = wall;
        covered.add(j);
      }
      continue;
    }
    const start = performance.now();
    results[i] = await runOne(probes[i]!);
    durationsMs[i] = Math.round(performance.now() - start);
  }
  return { results, durationsMs };
}

export async function runRfcAcceptanceRun(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcAcceptanceRunResult>> {
  const _io = resolveIo(context.io);
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

  // RFC-1453: one outcome session per invocation — page probes of the same
  // target share one build + one serve; disposed in `finally`.
  const session = createOutcomeSession({ workspaceRoot, forgeRoot: context.forgeRoot });
  try {
    for (const fileName of allFiles) {
      // RFC-1489: frontmatter-only scan; the body is parsed lazily only for
      // matched files that need probe-coverage evaluation.
      const headFile = await readRfcFrontmatter(rfcDirPath, fileName);
      if (!headFile) continue;
      if ("error" in headFile) continue;
      const fm = headFile.parsed.frontmatter;
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

    const probes = acceptance as AcceptanceProbe[];
    const { results: probeResults } = await runProbeSet(probes, {
      workspaceRoot,
      commandRegistry: context.commandRegistry,
      forgeRoot: context.forgeRoot,
      outcomeSession: session,
      noBatch: input.flags["no-batch"] === true,
    });
    for (const [i, raw] of probes.entries()) {
      const result = probeResults[i]!;
      if (result.verdict === "unverified") {
        diagnostics.push({
          ruleId: "RFC-ACC-04",
          severity: "error",
          file: relFile,
          message: `${rfcId}: probe "${raw.probe}" unverified — ${result.detail}.`,
        });
      } else if (!result.ok) {
        diagnostics.push({
          ruleId: "RFC-ACC-01",
          severity: "error",
          file: relFile,
          message: `${rfcId}: probe "${raw.probe}" failed — ${result.detail}.`,
        });
      }
    }

    let rfcCoverage: ProbeCoverageReport | undefined;
    const createdAt = String(fm["createdAt"] ?? "");
    const isArchived = fileName.startsWith("archive/");
    if (createdAt >= RFC_PROBE_BINDING_CUTOFF && !isArchived) {
      const fullFile = await readAndParseRfc(rfcDirPath, fileName);
      const parsedBody = fullFile && !("error" in fullFile) ? fullFile.parsed.body : "";
      const criteriaEval = evaluateAcceptanceCriteria(parsedBody);
      rfcCoverage = computeProbeCoverage(criteriaEval.criterionIds, acceptance);
    }

      results.push({ rfcId, probeResults, coverage: rfcCoverage });
    }
  } finally {
    await session.dispose();
  }

  const failedCount = diagnostics.filter((d) => d.severity === "error").length;
  const status: RfcAcceptanceRunResult["status"] = failedCount > 0 ? "fail" : "pass";

  return {
    data: { command: "rfc.acceptance.run", status, diagnostics, results },
    exitCode: failedCount > 0 ? 1 : 0,
    summary: `rfc.acceptance.run: ${results.length} RFC(s), ${failedCount} failed probe(s)`,
    nextSteps:
      failedCount > 0
        ? [
            {
              action: `Fix the ${failedCount} failed acceptance probe(s) above, then re-run: pnpm exec forge run rfc.acceptance.run`,
              kind: "required",
            },
          ]
        : undefined,
  };
}
