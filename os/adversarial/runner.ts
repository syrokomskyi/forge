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
  <item>RFC-1616: close verifier r1 counterexamples for the RFC-1616 trust boundary</item>
  <item>RFC-1616: close RFC-1616 r2 trust-boundary counterexamples</item>
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

/**
 * argv prefix that invokes this install's forge binary. `FORGE_ADVERSARIAL_BIN`
 * is a test-only override — honored under vitest, ignored by the shipped CLI:
 * a session-controlled env var must never redirect the demonstration away from
 * the real gate (CX-1).
 */
export function resolveForgeArgv(explicit?: string[]): string[] {
  if (explicit && explicit.length > 0) return explicit;
  const env = process.env["FORGE_ADVERSARIAL_BIN"];
  if (env && process.env["VITEST"] === "true") return env.split(/\s+/).filter(Boolean);
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
    const dest = insideRoot(scratch, rel);
    if (dest === null) throw new Error(`contour path escapes scratch: ${rel}`);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, interpolate(body));
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
 * Extract the refusal signal from gate output — verdict-shaped JSON only. A
 * rule token in attacker-controlled text (a manifest `id`, a commit message,
 * a forge.yaml key naming `{"rule": "X"}`) must never count as a refusal:
 * only parsed documents carrying an envelope key (`status`/`violations`/
 * `refusal`/`ruleId`/`verdict`) contribute (CX-2, CX-42), and only
 * error-severity violations cause a refusal — a warn-mode run prints the
 * expected rule as `severity: "warning"` while the refusal (if any) comes
 * from a different rule (CX-3).
 */
function observedVerdict(
  stdout: string,
  stderr: string,
  expected: string,
): { rule: string; fail: boolean } {
  const rules: string[] = [];
  let fail = false;
  const RULE = /^[A-Z]+-[A-Z]+-\d+$/;
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) collect(v);
      return;
    }
    const rec = value as Record<string, unknown>;
    for (const k of ["rule", "refusal", "ruleId"] as const) {
      const token = rec[k];
      if (typeof token === "string" && RULE.test(token) && rec["severity"] !== "warning")
        rules.push(token);
    }
    if (
      rec["status"] === "fail" ||
      rec["status"] === "refused" ||
      rec["verdict"] === "fail" ||
      typeof rec["refusal"] === "string" ||
      typeof rec["ruleId"] === "string"
    )
      fail = true;
    for (const v of Object.values(rec)) {
      if (v && typeof v === "object") collect(v);
    }
  };
  /** A doc only counts when it carries a verdict envelope — a bare
   * `{"rule": "X"}` object is attacker text, not a gate verdict (CX-42). */
  const verdictLike = (d: unknown): d is Record<string, unknown> =>
    !!d &&
    typeof d === "object" &&
    !Array.isArray(d) &&
    ["status", "violations", "refusal", "ruleId", "verdict"].some(
      (k) => k in (d as Record<string, unknown>),
    );
  // Parse whole documents FIRST — `--json` output is one pretty-printed
  // object; the first-{-to-last-} slice exists only for a doc wrapped in log
  // noise and is still gated by verdictLike.
  const docs: unknown[] = [];
  for (const blob of [`${stdout}\n${stderr}`.trim(), stdout.trim(), stderr.trim()]) {
    if (!blob) continue;
    try {
      docs.push(JSON.parse(blob));
      continue;
    } catch {
      /* not one JSON document — try the largest top-level object */
    }
    const start = blob.indexOf("{");
    const end = blob.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        docs.push(JSON.parse(blob.slice(start, end + 1)));
      } catch {
        /* unbalanced — fall through */
      }
    }
  }
  if (docs.length === 0) {
    for (const line of `${stdout}\n${stderr}`.split("\n")) {
      try {
        docs.push(JSON.parse(line));
      } catch {
        /* non-JSON line */
      }
    }
  }
  for (const d of docs.filter(verdictLike)) collect(d);
  return { rule: rules.includes(expected) ? expected : (rules[0] ?? "none"), fail };
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

/**
 * Env the spawned forge binary receives — an allowlist, not the session's
 * whole environment: `NODE_OPTIONS=--require` (and NODE_PATH / LD_* /
 * GIT_* / shell-startup vectors) would preload attacker code into the gate
 * process and fabricate a refusal verdict (CX-41).
 */
const SPAWN_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "CI",
  "USER",
  "LOGNAME",
  "SHELL",
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "PROGRAMFILES",
  "ProgramFiles",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

function spawnEnv(scratch: string): Record<string, string> {
  const env: Record<string, string> = { FORGE_PRIMARY: scratch };
  for (const k of SPAWN_ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** Reject `rel` paths that would escape `root` — `../` and absolute paths
 * must never write outside the scratch clone (CX-44). Returns the resolved
 * in-root destination or null. */
function insideRoot(root: string, rel: string): string | null {
  const dest = path.resolve(root, rel);
  return dest.startsWith(root + path.sep) ? dest : null;
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
          const dest = insideRoot(scratch, rel);
          if (dest === null) throw new Error(`setup path escapes scratch: ${rel}`);
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, interpolate(content));
        }
      }
      await g(["add", "-A"]);
      await g(["commit", "-qm", typeof step === "string" ? step : step.message, "--allow-empty"]);
    }
    const base = (await g(["rev-parse", "HEAD"])).trim();
    for (const [rel, content] of Object.entries(scenario.attack.files)) {
      const dest = insideRoot(scratch, rel);
      if (dest === null) {
        // a scenario whose attack escapes the scratch clone is malformed —
        // refuse the run, never write outside it (CX-44).
        return {
          name: scenario.name,
          expected: scenario.expect.rule,
          observed: `error:path-escape:${rel}`,
          ok: false,
        };
      }
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, interpolate(content));
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
        env: spawnEnv(scratch),
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
    const verdict =
      spawned.code === -1
        ? { rule: `error:${argv[0]}`, fail: false }
        : observedVerdict(spawned.out, spawned.err, scenario.expect.rule);
    // A refusal costs a non-zero exit — warn-mode still prints `status: fail`
    // with the violation tokens while exiting 0, so the process status is the
    // only honest signal (CX-3).
    const refused = spawned.code !== 0;
    return {
      name: scenario.name,
      expected: scenario.expect.rule,
      observed: verdict.rule,
      ok: refused && verdict.rule === scenario.expect.rule,
    };
  } finally {
    if (!opts.keepScratch) rmSync(scratch, { recursive: true, force: true });
  }
}
