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
  <item>RFC-1616: external verification trust boundary

policy.digest (canonical SHA-256 over the frozen surface), adversarial.run
with a 12-scenario catalog replayed through the real gate in a scratch
clone, flow.push verifier-trailer hard stop (fail-closed on unreadable
forge.yaml), project.owner + push.requireVerifierReview config, trust-boundary
scaffold (CODEOWNERS + forge-policy workflow) and reference docs.</item>
  <item>RFC-1616: close verifier r1 counterexamples for the RFC-1616 trust boundary</item>
  <item>RFC-1616: close RFC-1616 r2 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r8 trust-boundary counterexamples

Independent clean-context verification (round 8, candidate 9da0bf515)
returned REFUTED with nine live counterexamples against the r7-hardened
evidence channel — this commit closes all root causes.

- Committed-object reads carry an integrity anchor: loose objects under
  .git/objects whose inflated bytes do not hash to their object name
  refuse the channel — forged loose bytes and loose-over-packed
  shadowing can no longer serve the anchored base (CX-104a/b).
- policy.digest --verify --base accepts only concrete immutable commit
  identifiers — symbolic/message/index/path revspecs (HEAD^{/...},
  :/..., bare HEAD, branch names) are rejected before verify (CX-103).
- The heredoc lexer is a bash word-grammar scan: <<~EOF arms literal
  ~EOF (CX-105), quote removal applies across the whole word so
  <<'E'OF and <<E"OF" arm EOF (CX-106), and $/command-substitution
  words arm a never-matching sentinel so body lines stay stdin (CX-107).
- verifierGit is a subcommand + option allowlist: reflog/stash and
  write commands (config writes, update-ref) are refused, caller
  -c/-C/--git-dir/--work-tree/--exec-path are rejected instead of
  landing after the pins, and -g inside short-option clusters (-ng) is
  judged (CX-108/109).
- Every remote.<name>.* class keys the name as greedy .+ so dotted
  remotes no longer escape the REFUSE table or fetch value-judge —
  remote.o.r.uploadpack refuses the channel instead of executing inside
  fetch o.r (CX-110); fetch/ls-remote positional remotes are
  form-judged.

The independent r8 probe file and acceptance report land in the
follow-up port commit.</item>
  <history>RFC-1616</history>
</CHANGE_SUMMARY>
*/

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync as existsSyncForBin,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdversarialScenario,
  AdversarialScenarioResult,
} from "../../src/adversarial/types.ts";
import {
  resolveGitBin,
  verifierScratchGit,
  verifierSpawnEnv,
} from "../../src/utils/verifier-git.ts";
import { packageRoot } from "./catalog.ts";

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

/**
 * The runner's own git — the scrubbed boundary channel, not the session env:
 * `GIT_CONFIG_*` url rewrites could redirect the scratch clone, and
 * `refs/replace` substitution could hide what the attack commits actually
 * change (CX-50/51). `verifierScratchGit` bounds argv to the mutation ops a
 * scratch replay needs plus the evidence read table — a scenario-authored
 * token can never reach reflog/stash/update-ref or a `-c`/`--git-dir`
 * redirect (CX-108/109). Throws on non-zero like promisified execFile did.
 */
const git = async (root: string, args: string[]): Promise<string> => {
  const r = await verifierScratchGit(root, args);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed in ${root} (exit ${r.exitCode}): ${r.stderr.trim()}`);
  }
  return r.stdout;
};

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
 * Extract the refusal signal from gate output — the real gate envelope
 * only. Attacker-controlled text can reach stdout verbatim in pretty mode
 * (a forge.yaml key, a manifest `id`, a commit subject), and any
 * substring/line/slice salvage hands the attacker a channel for a fabricated
 * verdict document: only ONE document counts — `stdout` parsed as a whole
 * (CX-42, CX-55). It must name the spawned command (`command` matches the
 * invoke's first token), and rule tokens are collected only from structured
 * violation/diagnostic array entries — never from arbitrary nested objects
 * an attacker could shape through parsed config values.
 */
function observedVerdict(
  stdout: string,
  expectedCommand: string,
  expectedRule: string,
): { rule: string; fail: boolean } {
  const rules: string[] = [];
  let fail = false;
  const RULE = /^[A-Z]+-[A-Z]+-\d+$/;
  const blob = stdout.trim();
  if (!blob) return { rule: "none", fail: false };
  let doc: unknown;
  try {
    doc = JSON.parse(blob);
  } catch {
    // Pretty-mode or log-wrapped output never yields a verdict doc — a
    // fabricated envelope planted in attacker text must not parse (CX-55).
    return { rule: "none", fail: false };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { rule: "none", fail: false };
  }
  // One `data` unwrap — command envelopes nest the payload under it.
  const rec = doc as Record<string, unknown>;
  const payload =
    rec["data"] && typeof rec["data"] === "object" && !Array.isArray(rec["data"])
      ? (rec["data"] as Record<string, unknown>)
      : rec;
  if (payload["command"] !== expectedCommand) return { rule: "none", fail: false };
  if (payload["status"] === "fail" || payload["status"] === "refused") fail = true;
  if (payload["verdict"] === "fail") fail = true;
  for (const field of ["violations", "weakenings", "diagnostics"] as const) {
    const entries = payload[field];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      if (e["severity"] === "warning") continue;
      for (const k of ["rule", "ruleId"] as const) {
        const token = e[k];
        if (typeof token === "string" && RULE.test(token)) rules.push(token);
      }
      if (typeof e["refusal"] === "string") fail = true;
    }
  }
  return { rule: rules.includes(expectedRule) ? expectedRule : (rules[0] ?? "none"), fail };
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
 * Env the spawned forge binary receives — the shared verifier allowlist,
 * not the session's environment: `NODE_OPTIONS=--require` (and NODE_PATH /
 * LD_* / GIT_* / shell-startup vectors) would preload attacker code into the
 * gate process, and a session PATH dir earlier in order substitutes the
 * `git` the gate resolves (CX-41, CX-52). `verifierSpawnEnv` rebuilds PATH
 * around the resolved real git + node + system dirs.
 */
function spawnEnv(scratch: string): NodeJS.ProcessEnv {
  return verifierSpawnEnv({ FORGE_PRIMARY: scratch });
}

/**
 * Reject `rel` paths that would escape `root` — `../` and absolute paths
 * must never write outside the scratch clone (CX-44), and a symlink planted
 * inside the clone (a committed `links` entry pointing out) must not carry
 * the write out either: every existing ancestor is resolved with
 * `realpathSync` against the real root, so a textual in-root path cannot
 * mask a filesystem-level escape (CX-54). Returns the resolved in-root
 * destination or null.
 */
function insideRoot(root: string, rel: string): string | null {
  const dest = path.resolve(root, rel);
  if (!dest.startsWith(root + path.sep)) return null;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  const parts = dest.slice(root.length).split(path.sep).filter(Boolean);
  let probe = realRoot;
  for (const part of parts.slice(0, -1)) {
    const next = path.join(probe, part);
    if (!existsSyncForBin(next)) break; // non-existent tail — still inside
    let real: string;
    try {
      real = realpathSync(next);
    } catch {
      return null;
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    probe = real;
  }
  // The final segment may itself be a symlink whose target escapes.
  if (existsSyncForBin(dest)) {
    try {
      const real = realpathSync(dest);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    } catch {
      return null;
    }
  }
  return dest;
}

export async function runScenario(
  scenario: AdversarialScenario,
  opts: RunScenarioOptions,
): Promise<AdversarialScenarioResult> {
  // `scenario.name` is catalog-controlled text — it must stay a plain prefix:
  // a `..`-bearing name would place the scratch clone outside os.tmpdir()
  // (CX-53).
  const safeName = scenario.name.replace(/[^A-Za-z0-9._-]/g, "_");
  const scratch = mkdtempSync(path.join(os.tmpdir(), `forge-adv-${safeName}-`));
  try {
    const clone = await verifierScratchGit(scratch, [
      "clone",
      "-q",
      "--no-hardlinks",
      opts.repoRoot,
      scratch,
    ]);
    if (clone.exitCode !== 0) {
      throw new Error(`git clone failed (exit ${clone.exitCode}): ${clone.stderr.trim()}`);
    }
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
    // The verdict command — the first invoke token; the observed document
    // must name it (CX-55).
    const expectedCommand = scenario.invoke.split(/\s+/)[0] ?? "correctness.gate";
    const spawned = await new Promise<{ code: number | null; out: string; err: string }>((done) => {
      // resolveGitBin() pins the gate's own `git` resolution above any PATH
      // shim the session placed first (CX-52).
      void resolveGitBin();
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
        : observedVerdict(spawned.out, expectedCommand, scenario.expect.rule);
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
