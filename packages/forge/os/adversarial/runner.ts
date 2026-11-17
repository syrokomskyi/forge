/*
<MODULE_CONTRACT>
<purpose>RFC-1616: the adversarial replay runner — for each catalog scenario,
clone the consumer repository into a scratch dir under the OS temp area,
apply the setup commits, apply the attack file writes + commit, spawn the
invoke command through the forge binary, and compare the observed refusal
rule against expect.rule. Scratch dirs are cleaned in finally; a crash
leaves only a tmp dir.</purpose>
<non-goals>
  <item>Does not enumerate or seed the catalog — catalog.ts/docs fixtures own that.</item>
  <item>Does not weaken the gate — the runner observes refusals, never grants.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>forge argv resolution: explicit forgeArgv option (tests) → FORGE_ADVERSARIAL_BIN env → process argv pair → the package's own bin/cli.js. The spawned gate is the install's real binary, never an in-process call — that is what the demonstration proves.</item>
  <item>{base} in the invoke template binds the pre-attack HEAD — the same base the integrate step passes.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1616: initial runner — scratch clone, setup/attack commits, spawned gate, expected-vs-observed rule compare.</item>
  <item>RFC-1616: external verification trust boundary

policy.digest (canonical SHA-256 over the frozen surface), adversarial.run
with a 12-scenario catalog replayed through the real gate in a scratch
clone, flow.push verifier-trailer hard stop (fail-closed on unreadable
forge.yaml), project.owner + push.requireVerifierReview config, trust-boundary
scaffold (CODEOWNERS + forge-policy workflow) and reference docs.</item>
</CHANGE_SUMMARY>
*/

import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync as existsSyncForBin,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  AdversarialScenario,
  AdversarialScenarioResult,
} from "../../src/adversarial/types.ts";
import { packageRoot } from "./catalog.ts";

const execFileAsync = promisify(execFile);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = packageRoot(MODULE_DIR);
const OWN_BIN = path.join(PKG_ROOT, "bin", "cli.js");

/** argv prefix that invokes this install's forge binary. */
export function resolveForgeArgv(explicit?: string[]): string[] {
  if (explicit && explicit.length > 0) return explicit;
  const env = process.env["FORGE_ADVERSARIAL_BIN"];
  if (env) return env.split(/\s+/).filter(Boolean);
  const argv1 = process.argv[1] ?? "";
  if (/(cli\.(js|ts)|forge)$/.test(argv1)) return [process.execPath, argv1];
  return [process.execPath, OWN_BIN];
}

const git = (root: string, args: string[]) =>
  execFileAsync("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout);

/** `src/correctness/index.ts` (source layout) or `dist/src/correctness/index.js`. */
const CORRECTNESS_HELPERS = (() => {
  for (const rel of [
    "src/correctness/index.ts",
    "src/correctness/index.js",
    "dist/src/correctness/index.js",
  ]) {
    const p = path.join(PKG_ROOT, rel);
    if (existsSyncForBin(p)) return p;
  }
  return null;
})();

/** `{{FORGE_HELPERS}}` → the installed package's correctness test-side helpers. */
const interpolate = (content: string) =>
  CORRECTNESS_HELPERS ? content.replaceAll("{{FORGE_HELPERS}}", CORRECTNESS_HELPERS) : content;

const ORACLE_PATH = "test/dispatch.oracle.ts";
const MARK = "@ai-" + "invariant";

const L1_ORACLE = `import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { attestSubstrate } from "{{FORGE_HELPERS}}";
const db = new DatabaseSync(":memory:");
db.exec(readFileSync("apps/api/migrations/0001_init.sql", "utf8"));
attestSubstrate(db, { level: "L1", engine: "node:sqlite" });
`;

interface ContourOpts {
  message?: string;
  mutable?: string[];
  additive?: string[];
  freezeFiles?: string[];
  agentToolsDeny?: string[];
  extraFiles?: Record<string, string>;
  manifestExtra?: string;
}

/**
 * Seed the canonical clean gate contour — mirrors the gate test fixture so the
 * base commit passes and only the attack can trip the expected rule: product
 * commit (forge.yaml + compass doc + anchor + L1 oracle + manifest) followed by
 * a verifier-committed forge/oracle-review@1 record carrying the trailer pair.
 */
async function seedContour(scratch: string, c: ContourOpts): Promise<void> {
  const g = (args: string[]) => git(scratch, args);
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true });
    writeFileSync(path.join(scratch, rel), interpolate(body));
  };
  const yamlList = (xs: string[] | undefined, dflt: string[]) =>
    `[${(xs ?? dflt).map((x) => JSON.stringify(x)).join(", ")}]`;
  write(
    "forge.yaml",
    `schema: forge/config@1
project:
  name: adversarial-demo
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
  paths:
    compassDocs: [docs/requirements.xml]
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: enforce
  tier: standard
policy:
  mutable: ${yamlList(c.mutable, ["project"])}
  additive: ${yamlList(c.additive, [])}
  freezeFiles: ${yamlList(c.freezeFiles, ["hooks/**", ".forge/pinned.yaml"])}
agentTools:
  deny: ${yamlList(c.agentToolsDeny, ["deploy"])}
`,
  );
  write(
    "docs/requirements.xml",
    '<requirements>\n  <meta><document-id>requirements</document-id></meta>\n  <requirement id="REQ-01">demo</requirement>\n</requirements>\n',
  );
  write(
    "apps/api/wrangler.jsonc",
    '{ "d1_databases": [{ "binding": "DB", "database_name": "main", "database_id": "x" }] }\n',
  );
  write(
    "apps/api/migrations/0001_init.sql",
    "CREATE TABLE candidates (id TEXT PRIMARY KEY, state TEXT NOT NULL);\n",
  );
  write(
    "apps/api/src/dispatch.ts",
    `export function dispatch(): void {\n  // ${MARK}[INV-dispatch-01]: dispatch moves an approved candidate to queued exactly once\n  //   (checked-by: test:${ORACLE_PATH})\n}\n`,
  );
  write(ORACLE_PATH, L1_ORACLE);
  write(
    "docs/correctness.yaml",
    `schema: forge/correctness-manifest@1
entries:
  - id: CM-dispatch-01
    source: req
    ref: REQ-01
    seam: data
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:${ORACLE_PATH}
        substrate: L1
${c.manifestExtra ?? ""}support: []
exemptions: []
`,
  );
  for (const [rel, body] of Object.entries(c.extraFiles ?? {})) write(rel, body);
  await g(["add", "-A"]);
  await g(["commit", "-qm", c.message ?? "seed the adopted contour"]);
  // the oracle review record, committed the way the verifier workflow does —
  // sha256 of the interpolated oracle body + the trailer pair.
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const sha = createHash("sha256")
    .update(readFileSync(path.join(scratch, ORACLE_PATH), "utf8"))
    .digest("hex");
  const rel = "docs/correctness/reviews/2026-11-16-base.yaml";
  write(
    rel,
    `schema: forge/oracle-review@1
reviewedAt: 2026-11-16T10:00:00Z
isolation: subagent
candidate: deadbeef
export: "rfc.verify.workspace --manifest"
verdict: pass
oracles:
  - check: test:${ORACLE_PATH}
    sha256: "${sha}"
    verdict: pass
    attestedHandleIsUnderTest: true
`,
  );
  await g(["add", "-A"]);
  await g([
    "commit",
    "-qm",
    `review: oracle review\n\nX-Expectation-Origin: independent-verifier\nX-Verifier-Report: ${rel}`,
  ]);
}

function tokenize(template: string, vars: Record<string, string>): string[] {
  const replaced = template.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? _m);
  return replaced.split(/\s+/).filter(Boolean);
}

/**
 * Extract the refusal rule from gate output. The expected rule wins when it
 * appears anywhere in the verdict (a refusal may name several rules);
 * otherwise the first rule token, else "none".
 */
function observedRule(stdout: string, stderr: string, expected: string): string {
  const text = `${stdout}\n${stderr}`;
  const all = [...text.matchAll(/\b([A-Z]+-[A-Z]+-\d+)\b/g)].map((m) => m[1]!);
  if (all.includes(expected)) return expected;
  try {
    for (const line of stdout.split("\n").filter(Boolean)) {
      const j = JSON.parse(line) as Record<string, unknown>;
      const data = (j["data"] ?? j) as Record<string, unknown>;
      const violations = data?.["violations"];
      if (Array.isArray(violations)) {
        const rule = violations
          .map((v) =>
            v && typeof v === "object" ? String((v as Record<string, unknown>)["rule"] ?? "") : "",
          )
          .find((r) => /^[A-Z]+-[A-Z]+-\d+/.test(r));
        if (rule) return rule;
      }
    }
  } catch {
    /* not JSON — fall through */
  }
  return all[0] ?? "none";
}

/**
 * `internal:downgrade-forge` — the FLOW-INT-18 replay. Plants a fake primary
 * install whose forge binary answers "Unknown command: correctness.gate",
 * then drives the REAL flow correctness step against the scratch repo — an
 * adopted base must refuse (a forge downgrade must not drop the gate), never
 * silently degrade. No mock verdict: the production step produces the result.
 */
async function runDowngradeHarness(scratch: string, base: string): Promise<string> {
  const { runCorrectnessStep } = await import("../flow/correctness-step.ts");
  const { ambientIo } = await import("../../src/utils/io.ts");
  const primary = path.join(scratch, ".adv-primary");
  const binDir = path.join(primary, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "forge");
  writeFileSync(bin, `#!/bin/sh\necho "Unknown command: correctness.gate" >&2\nexit 1\n`);
  chmodSync(bin, 0o755);
  const result = await runCorrectnessStep(ambientIo, {
    primary,
    worktree: scratch,
    base,
  });
  if (result.status === "not-run" && result.refusal) return "FLOW-INT-18";
  return "none";
}

export interface RunScenarioOptions {
  /** repo whose contour the attack replays against */
  repoRoot: string;
  forgeArgv?: string[];
  keepScratch?: boolean;
  timeoutMs?: number;
}

export async function runScenario(
  scenario: AdversarialScenario,
  opts: RunScenarioOptions,
): Promise<AdversarialScenarioResult> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `forge-adv-${scenario.name}-`));
  try {
    await execFileAsync("git", ["clone", "-q", "--no-hardlinks", opts.repoRoot, scratch]);
    const g = (args: string[]) => git(scratch, args);
    await g(["config", "user.email", "adversarial@forge"]);
    await g(["config", "user.name", "adversarial"]);
    for (const step of scenario.setup) {
      if (typeof step === "object" && "contour" in step) {
        await seedContour(scratch, step.contour);
        continue;
      }
      if (typeof step !== "string") {
        for (const [rel, content] of Object.entries(step.files ?? {})) {
          mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true });
          writeFileSync(path.join(scratch, rel), interpolate(content));
        }
      }
      await g(["add", "-A"]);
      await g(["commit", "-qm", typeof step === "string" ? step : step.message, "--allow-empty"]);
    }
    const base = (await g(["rev-parse", "HEAD"])).trim();
    for (const [rel, content] of Object.entries(scenario.attack.files)) {
      mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true });
      writeFileSync(path.join(scratch, rel), interpolate(content));
    }
    await g(["add", "-A"]);
    await g(["commit", "-qm", scenario.attack.commitMessage]);

    if (scenario.invoke === "internal:downgrade-forge") {
      const observed = await runDowngradeHarness(scratch, base);
      return {
        name: scenario.name,
        expected: scenario.expect.rule,
        observed,
        ok: observed === scenario.expect.rule,
      };
    }

    const argv = [
      ...resolveForgeArgv(opts.forgeArgv),
      ...tokenize(scenario.invoke, { base, scratch }),
    ];
    const spawned = await new Promise<{ code: number | null; out: string; err: string }>((done) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: scratch,
        env: { ...process.env, FORGE_PRIMARY: scratch },
      });
      let out = "";
      let err = "";
      const kill = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", () => {
        clearTimeout(kill);
        done({ code: -1, out, err });
      });
      child.on("close", (code) => {
        clearTimeout(kill);
        done({ code, out, err });
      });
    });
    const observed =
      spawned.code === -1
        ? `error:${argv[0]}`
        : observedRule(spawned.out, spawned.err, scenario.expect.rule);
    return {
      name: scenario.name,
      expected: scenario.expect.rule,
      observed,
      ok: observed === scenario.expect.rule,
    };
  } finally {
    if (!opts.keepScratch) rmSync(scratch, { recursive: true, force: true });
  }
}
