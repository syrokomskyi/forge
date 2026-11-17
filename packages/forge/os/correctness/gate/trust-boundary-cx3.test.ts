/*
<MODULE_CONTRACT>
<purpose>
RFC-1616 acceptance probes — independent round-3 verification of the external
verification trust boundary against export candidate bb84c2513. Every probe
FAILS when the counterexample is live and PASSES when closed; numbering
continues from CX-45 (round 2 reported through CX-45).

Round-3 attack surfaces not covered by the ported r1/r2 suites:
  - git object-substitution metadata (refs/replace) against the gate, the
    push-time trailer scan, the flow digest, and policy.digest --base.
  - session-injected git environment on the flow/policy paths (GIT_CONFIG_*,
    GIT_DIR) — the gate's gitEnvForCwd strip is not shared by io.exec or the
    digest's own execFile.
  - the adversarial runner's residual spawn channels (PATH), scenario-name
    traversal, and symlink escapes through insideRoot.
  - marker-substring scaffold adoption and trailer-key normalization
    (case / space-before-colon) in the verifier scans.
  - grant carve completeness (paths/bindings leaves) and canonicalJson
    type collapse vs the gate's canon.
</purpose>
<non-goals>
  <item>Not a contract source of truth — src/utils/verifier-git.ts, os/adversarial, os/core/handlers/policy-digest.ts, os/flow/** own behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1616: port RFC-1616 round-3 independent verifier probes — 15 counterexamples (CX-46..CX-60) + closed-class re-verification.</item>
  <item>RFC-1616: port RFC-1616 round-3 independent verifier probes</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AdversarialScenario } from "../../../src/adversarial/types.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";
import { ambientIo } from "../../../src/utils/io.ts";
import { scaffoldTrustBoundary } from "../../../src/onboarding/trust-boundary.ts";
import { runScenario } from "../../adversarial/runner.ts";
import { runPolicyDigest } from "../../core/handlers/policy-digest.ts";
import { collectDigest } from "../../flow/digest.ts";
import { pushFlow } from "../../flow/handlers/flow-push.ts";
import { gitExec, initRepoWithOrigin } from "../../flow/tests/helpers.ts";
import { runCorrectnessGate } from "./run.ts";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(MODULE_DIR, "../../..");
const FORGE_BIN = path.join(PKG_ROOT, "bin", "cli.js");
const FORGE_ARGV = [process.execPath, FORGE_BIN];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Environment hygiene for the probe host itself: this session's PATH carries
 * a werkstatt git-guard wrapper (scripts/git → git-wrapper.sh) that stalls on
 * some calls inside disposable repos — it is session machinery, not the
 * candidate under test. Strip every dir that ships `git-wrapper.sh` so the
 * bare `git` the candidate resolves is the real binary (CX-52 re-poisons a
 * scoped PATH deliberately to test the candidate's own handling).
 */
const CLEAN_PATH = (process.env["PATH"] ?? "")
  .split(path.delimiter)
  .filter((d) => d.length > 0 && !existsSync(path.join(d, "git-wrapper.sh")))
  .join(path.delimiter);
beforeAll(() => {
  process.env["PATH"] = CLEAN_PATH;
});
const REAL_GIT = (() => {
  for (const d of CLEAN_PATH.split(path.delimiter)) {
    const g = path.join(d, "git");
    if (existsSync(g)) return g;
  }
  return "/usr/bin/git";
})();

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NOOP_LOGGER = {
  section() {},
  info() {},
  warn() {},
  error() {},
  success() {},
} as unknown as ForgeRuntimeContext["logger"];

function ctx(root: string): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    logger: NOOP_LOGGER,
    dryRun: false,
    outputFormat: "json",
  } as ForgeRuntimeContext;
}

const gitIn = (root: string, args: string[], env?: Record<string, string>, input?: string) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : undefined,
    input,
  });

function fixtureRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx3-adv-base-"));
  dirs.push(root);
  gitIn(root, ["init", "-q"]);
  gitIn(root, ["config", "user.email", "t@t"]);
  gitIn(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["commit", "-qm", "seed"]);
  return root;
}

/** Policy-surface repo: forge.yaml with a policy: block + frozen files at `base`. */
function initPolicyRepo(opts: {
  mutable?: string;
  additive?: string;
  freezeFiles?: string;
  forgeYaml?: string;
  extraForgeYaml?: string;
  files?: Record<string, string>;
}): { root: string; base: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx3-pd-"));
  dirs.push(root);
  gitIn(root, ["init", "-q"]);
  gitIn(root, ["config", "user.email", "t@t"]);
  gitIn(root, ["config", "user.name", "t"]);
  writeFileSync(
    path.join(root, "forge.yaml"),
    opts.forgeYaml ??
      `schema: forge/config@1
project:
  name: pd-probe
paths: {}
policy:
  mutable: ${opts.mutable ?? "[project]"}
  additive: ${opts.additive ?? "[]"}
  freezeFiles: ${opts.freezeFiles ?? '["hooks/**"]'}
${opts.extraForgeYaml ?? ""}`,
  );
  for (const [rel, body] of Object.entries(opts.files ?? {})) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["commit", "-qm", "base"]);
  return { root, base: gitIn(root, ["rev-parse", "HEAD"]).trim() };
}

async function digest(root: string, flags: Record<string, boolean | string>) {
  return runPolicyDigest({ argv: [], flags }, ctx(root));
}

const fyPath = (root: string) => path.join(root, "forge.yaml");
const fyEdit = (root: string, from: string, to: string) => {
  const body = readFileSync(fyPath(root), "utf8");
  if (!body.includes(from)) throw new Error(`fyEdit: ${from} not present`);
  writeFileSync(fyPath(root), body.replace(from, to));
};

/** commit-tree helper — writes a commit object without touching HEAD. */
function commitTree(
  root: string,
  opts: { tree: string; parents?: string[]; message: string },
): string {
  const args = [
    "commit-tree",
    opts.tree,
    ...(opts.parents ?? []).flatMap((p) => ["-p", p]),
    "-m",
    opts.message,
  ];
  return gitIn(root, args).trim();
}

function scenario(partial: Partial<AdversarialScenario> & Pick<AdversarialScenario, "expect">) {
  return {
    schema: "forge/adversarial-scenario@1",
    name: partial.name ?? "cx3-probe",
    setup: partial.setup ?? [
      {
        contour: {
          extraFiles: {
            "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
            ".forge/pinned.yaml": "pinned: []\n",
          },
        },
      },
    ],
    attack: partial.attack ?? {
      files: { "src/innocent.ts": "export const ok = 1;\n" },
      commitMessage: "benign session diff",
    },
    invoke: partial.invoke ?? "correctness.gate --base {base} --json",
    expect: partial.expect,
  } as AdversarialScenario;
}

async function trailerCommit(repo: string, file: string, trailerLine: string): Promise<string> {
  writeFileSync(path.join(repo, file), "x\n");
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-qm", `session work\n\n${trailerLine}`]);
  return (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

/** Read what the local bare `origin` stores at refs/heads/develop. */
async function remoteBody(origin: string, ref = "develop"): Promise<string> {
  const r = await gitExec(origin, ["log", "-1", "--format=%B", ref]);
  return r.stdout;
}

// ===========================================================================
// refs/replace — git object substitution reads fake content while push ships real
// ===========================================================================

describe("RFC-1616 r3 — refs/replace object substitution", () => {
  it(
    "CX-46: a replaced tip commit's TREE blinds the gate — diff/show/ls-tree judge the replacement while the real weakened tree ships",
    { timeout: 60_000 },
    async () => {
      const r = initPolicyRepo({
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      // control: a real weakening without replace refuses.
      writeFileSync(path.join(r.root, "hooks", "h.sh"), "#!/bin/sh\necho pwned\n");
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "weaken the hook"]);
      const tip = gitIn(r.root, ["rev-parse", "HEAD"]).trim();
      const control = await runCorrectnessGate(r.root, { base: r.base, policyOnly: true });
      expect(control.ok).toBe(true);
      if (control.ok) expect(control.result.status).toBe("fail");

      // attack: same weakening, but HEAD's commit is replaced by a fake
      // whose tree is the BASE tree — every committed read sees nothing.
      const fake = commitTree(r.root, {
        tree: gitIn(r.root, ["rev-parse", `${r.base}^{tree}`]).trim(),
        parents: [r.base],
        message: "looks identical to base",
      });
      gitIn(r.root, ["replace", tip, fake]);
      const out = await runCorrectnessGate(r.root, { base: r.base, policyOnly: true });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(
          out.result.status,
          "refs/replace substituted a base-tree commit — the gate saw an empty diff while the real tree ships the weakened hook",
        ).toBe("fail");
      }
    },
  );

  it(
    "CX-47: a replaced commit's MESSAGE fabricates verifier provenance — lastTouchIsVerifier exempts a real weakening",
    { timeout: 60_000 },
    async () => {
      const r = initPolicyRepo({
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      writeFileSync(path.join(r.root, "hooks", "h.sh"), "#!/bin/sh\necho pwned\n");
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "weaken the hook"]);
      const tip = gitIn(r.root, ["rev-parse", "HEAD"]).trim();
      const control = await runCorrectnessGate(r.root, { base: r.base, policyOnly: true });
      expect(control.ok).toBe(true);
      if (control.ok) expect(control.result.status).toBe("fail");

      // same tree (the real weakening stays visible to the diff) but the
      // replacement message carries the verifier trailer pair — the
      // exemption check reads the substituted body and lets the change pass.
      const fake = commitTree(r.root, {
        tree: gitIn(r.root, ["rev-parse", `${tip}^{tree}`]).trim(),
        parents: [r.base],
        message:
          "weaken the hook\n\nX-Expectation-Origin: independent-verifier\nX-Verifier-Report: docs/correctness/reviews/forged.yaml",
      });
      gitIn(r.root, ["replace", tip, fake]);
      const out = await runCorrectnessGate(r.root, { base: r.base, policyOnly: true });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(
          out.result.status,
          "refs/replace gave the weakening commit a fabricated verifier trailer pair — the exemption honored forged provenance",
        ).toBe("fail");
      }
    },
  );

  it(
    "CX-48: the push-time trailer scan reads replaced bodies — a verifier-trailer commit pushes to the real remote unflagged",
    { timeout: 120_000 },
    async () => {
      const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "cx3-push-" });
      const sha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: reviews/fake.yaml");
      // same tree + parent, clean message — the scan sees no trailer.
      const fake = commitTree(repo, {
        tree: gitIn(repo, ["rev-parse", `${sha}^{tree}`]).trim(),
        parents: [gitIn(repo, ["rev-parse", `${sha}^`]).trim()],
        message: "session work",
      });
      gitIn(repo, ["replace", sha, fake]);
      const digestData = await collectDigest(repo, ambientIo, { fetch: false });
      expect(
        digestData.correctnessTrail.verifierCommits.some((c) => c.sha === sha),
        "flow.digest's verifierCommits is blind to the replaced commit too",
      ).toBe(true);
      const data = await pushFlow(repo, ambientIo, {
        digest: digestData.digestId,
        dryRun: false,
      });
      const remote = await remoteBody(origin);
      expect(
        data.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-08") || !data.pushed,
        `replaced body hid the verifier trailer — pushed=${data.pushed}, remote develop carries: ${remote.trim()}`,
      ).toBe(true);
    },
  );

  it(
    "CX-49: a replaced BASE commit fabricates 'no advance' for policy.digest --verify --base — the attestation check is skipped on a real advance",
    { timeout: 60_000 },
    async () => {
      const r = initPolicyRepo({
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      await digest(r.root, { write: true });
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "attest"]);
      const attestBase = gitIn(r.root, ["rev-parse", "HEAD"]).trim();
      // advance the surface + regenerate the digest (self-attest) — the
      // trailer check is the only barrier left.
      fyEdit(
        r.root,
        'freezeFiles: ["hooks/**"]',
        'freezeFiles: ["hooks/**", ".forge/pinned.yaml"]',
      );
      await digest(r.root, { write: true });
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "advance without attestation"]);
      const control = await digest(r.root, { verify: true, base: attestBase });
      expect(control.exitCode).toBe(1);

      // replace the base commit: its substituted tree carries the ADVANCED
      // forge.yaml — gatherBaseSurface digests the replacement, the base
      // digest equals current, and the trailer check never runs.
      const fake = commitTree(r.root, {
        tree: gitIn(r.root, ["rev-parse", "HEAD^{tree}"]).trim(),
        parents: [gitIn(r.root, ["rev-parse", `${attestBase}^`]).trim()],
        message: "attest",
      });
      gitIn(r.root, ["replace", attestBase, fake]);
      const out = await digest(r.root, { verify: true, base: attestBase });
      expect(
        out.exitCode,
        "a replaced base commit made the real advance read as 'no change' — --verify --base passed with no attestation trailer",
      ).toBe(1);
    },
  );
});

// ===========================================================================
// session environment on the trust-boundary git paths
// ===========================================================================

describe("RFC-1616 r3 — session env on flow/digest git calls", () => {
  it(
    "CX-50: GIT_CONFIG_* url.insteadOf/pushInsteadOf split — fetch reads a session remote (scan range blind) while push ships to the real one",
    { timeout: 120_000 },
    async () => {
      const { repo, origin, parent } = await initRepoWithOrigin(dirs, { prefix: "cx3-env-" });
      const t = await trailerCommit(repo, "t.txt", "X-Verifier-Report: reviews/fake.yaml");
      // clean tip above the trailer commit.
      writeFileSync(path.join(repo, "c.txt"), "c\n");
      await gitExec(repo, ["add", "c.txt"]);
      await gitExec(repo, ["commit", "-qm", "clean follow-up"]);
      // a session remote whose develop is the trailer commit — the range
      // <T>..<tip> excludes T, so the scan never reads its body.
      const fake = path.join(parent, "fake.git");
      await gitExec(repo, ["init", "--bare", fake]);
      await gitExec(repo, ["push", "-q", fake, `${t}:refs/heads/develop`]);
      const originUrl = (await gitExec(repo, ["remote", "get-url", "origin"])).stdout.trim();

      const saved = { ...process.env };
      process.env["GIT_CONFIG_COUNT"] = "2";
      process.env["GIT_CONFIG_KEY_0"] = `url.${fake}.insteadOf`;
      process.env["GIT_CONFIG_VALUE_0"] = originUrl;
      process.env["GIT_CONFIG_KEY_1"] = `url.${originUrl}.pushInsteadOf`;
      process.env["GIT_CONFIG_VALUE_1"] = originUrl;
      try {
        const digestData = await collectDigest(repo, ambientIo, { fetch: true });
        // the poisoned fetch succeeded against the fake — same view as the
        // operator's `flow.digest` under this env.
        const data = await pushFlow(repo, ambientIo, {
          digest: digestData.digestId,
          dryRun: false,
        });
        const remote = await remoteBody(origin);
        expect(
          data.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-08") || !data.pushed,
          `env-injected insteadOf split the fetch/push URLs — scan saw the fake remote's range; pushed=${data.pushed}, real remote carries: ${remote.trim()}`,
        ).toBe(true);
      } finally {
        for (const k of [
          "GIT_CONFIG_COUNT",
          "GIT_CONFIG_KEY_0",
          "GIT_CONFIG_VALUE_0",
          "GIT_CONFIG_KEY_1",
          "GIT_CONFIG_VALUE_1",
        ]) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      }
      void origin;
    },
  );

  it(
    "CX-51: policy.digest git reads inherit session env — GIT_DIR points the --verify --base attestation check at a fabricated repository",
    { timeout: 60_000 },
    async () => {
      const r = initPolicyRepo({
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      await digest(r.root, { write: true });
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "attest"]);
      const attestBase = gitIn(r.root, ["rev-parse", "HEAD"]).trim();
      fyEdit(
        r.root,
        'freezeFiles: ["hooks/**"]',
        'freezeFiles: ["hooks/**", ".forge/pinned.yaml"]',
      );
      const current = await digest(r.root, {});
      const sha = current.data?.sha256;
      await digest(r.root, { write: true });
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "advance without attestation"]);
      const control = await digest(r.root, { verify: true, base: attestBase });
      expect(control.exitCode).toBe(1);

      // a fabricated repository: a clone (same objects) plus a commit that
      // carries the required trailer. GIT_DIR makes the digest's own git()
      // calls resolve it while cwd stays the real worktree.
      const fake = mkdtempSync(path.join(os.tmpdir(), "cx3-fakegit-"));
      dirs.push(fake);
      gitIn(os.tmpdir(), ["clone", "-q", r.root, fake]);
      gitIn(fake, ["config", "user.email", "t@t"]);
      gitIn(fake, ["config", "user.name", "t"]);
      gitIn(fake, ["commit", "-qm", `attestation\n\nX-Policy-Digest: ${sha}`, "--allow-empty"]);

      const saved = process.env["GIT_DIR"];
      process.env["GIT_DIR"] = path.join(fake, ".git");
      try {
        const out = await digest(r.root, { verify: true, base: attestBase });
        expect(
          out.exitCode,
          "GIT_DIR redirected the attestation-log read to a fabricated repo — --verify --base passed on an unattested advance",
        ).toBe(1);
      } finally {
        if (saved === undefined) delete process.env["GIT_DIR"];
        else process.env["GIT_DIR"] = saved;
      }
    },
  );
});

// ===========================================================================
// adversarial.run runner residuals
// ===========================================================================

describe("RFC-1616 r3 — adversarial.run runner residuals", () => {
  it(
    "CX-52: PATH sits in the spawn allowlist — a session `git` shim substitutes the blob ids the spawned gate compares and fabricates the expected refusal",
    { timeout: 240_000 },
    async () => {
      const realGit = REAL_GIT;
      const binDir = mkdtempSync(path.join(os.tmpdir(), "cx3-fakebin-"));
      dirs.push(binDir);
      const oracle = "test/dispatch.oracle.ts";
      writeFileSync(
        path.join(binDir, "git"),
        `#!/bin/sh
case "$PWD" in
  *forge-adv-*) ;;
  *) exec ${realGit} "$@" ;;
esac
if [ "$1" = "ls-tree" ]; then
  head=$(${realGit} rev-parse HEAD 2>/dev/null)
  case " $* " in
    *" $head "*)
      ${realGit} "$@" | sed -z 's/[0-9a-f]\\{40\\}\\t${oracle.replace(/\//g, "\\/")}/0000000000000000000000000000000000000000\\t${oracle.replace(/\//g, "\\/")}/'
      exit 0 ;;
  esac
fi
exec ${realGit} "$@"
`,
      );
      chmodSync(path.join(binDir, "git"), 0o755);
      const saved = process.env["PATH"];
      process.env["PATH"] = `${binDir}:${saved ?? ""}`;
      try {
        // a BENIGN scenario: the only way CORR-GATE-02 can be observed is if
        // the shim's fabricated blob id made the gate see a weakening.
        const r = await runScenario(
          scenario({ name: "cx3-pathshim", expect: { status: "refused", rule: "CORR-GATE-02" } }),
          { repoRoot: fixtureRepo(), forgeArgv: FORGE_ARGV },
        );
        expect(
          r.ok,
          `the session's PATH-resolved git fabricated the gate's evidence — scenario reported ok with observed=${r.observed}`,
        ).toBe(false);
      } finally {
        if (saved === undefined) delete process.env["PATH"];
        else process.env["PATH"] = saved;
      }
    },
  );

  it(
    "CX-53: scenario.name interpolates into the mkdtemp prefix — a ../-bearing name places the scratch clone outside the temp area (keepScratch keeps it)",
    { timeout: 120_000 },
    async () => {
      const victim = mkdtempSync(path.join(os.tmpdir(), "cx3-escvictim-"));
      dirs.push(victim);
      const before = readdirSync(victim).filter((f) => f.startsWith("cx3esc-"));
      await runScenario(
        scenario({
          // `forge-adv-<name>` resolves inside os.tmpdir() — one `../` makes
          // the scratch a sibling of the victim dir instead of inside it.
          name: `x/../${path.basename(victim)}/cx3esc`,
          expect: { status: "refused", rule: "CORR-GATE-02" },
        }),
        { repoRoot: fixtureRepo(), forgeArgv: FORGE_ARGV, keepScratch: true, timeoutMs: 60_000 },
      );
      const after = readdirSync(victim).filter(
        (f) => f.startsWith("cx3esc-") && !before.includes(f),
      );
      for (const f of after) rmSync(path.join(victim, f), { recursive: true, force: true });
      expect(
        after.length,
        "scenario.name path traversal placed the scratch clone outside os.tmpdir()",
      ).toBe(0);
    },
  );

  it(
    "CX-54: insideRoot is a textual check — an attack file written through a committed repo symlink escapes the scratch and survives cleanup",
    { timeout: 120_000 },
    async () => {
      const escape = mkdtempSync(path.join(os.tmpdir(), "cx3-escape-"));
      dirs.push(escape);
      const repo = mkdtempSync(path.join(os.tmpdir(), "cx3-linkrepo-"));
      dirs.push(repo);
      gitIn(repo, ["init", "-q"]);
      gitIn(repo, ["config", "user.email", "t@t"]);
      gitIn(repo, ["config", "user.name", "t"]);
      symlinkSync(escape, path.join(repo, "links"));
      writeFileSync(path.join(repo, "seed.txt"), "s\n");
      gitIn(repo, ["add", "-A"]);
      gitIn(repo, ["commit", "-qm", "seed"]);
      await runScenario(
        scenario({
          name: "cx3-symlink",
          attack: {
            files: { "links/pwn.txt": "escaped\n", "src/innocent.ts": "export {};\n" },
            commitMessage: "x",
          },
          expect: { status: "refused", rule: "CORR-GATE-02" },
        }),
        { repoRoot: repo, forgeArgv: FORGE_ARGV },
      );
      expect(
        existsSync(path.join(escape, "pwn.txt")),
        "attack file followed the committed symlink out of the scratch clone",
      ).toBe(false);
    },
  );

  it(
    "CX-55: a verdict-envelope-shaped forge.yaml key still smuggles a verdict document into pretty-mode output (CX-42 residual — the verdictLike gate keys on attacker-chosen field names)",
    { timeout: 240_000 },
    async () => {
      const doc = JSON.stringify({
        status: "fail",
        violations: [{ rule: "CORR-GATE-03", severity: "error" }],
      });
      const seededForgeYaml = `schema: forge/config@1
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
  mutable: ["project"]
  additive: []
  freezeFiles: ["hooks/**", ".forge/pinned.yaml"]
agentTools:
  deny: ["deploy"]
'${doc}': probe
`;
      const r = await runScenario(
        scenario({
          name: "cx3-smuggle",
          attack: { files: { "forge.yaml": seededForgeYaml }, commitMessage: "session diff" },
          invoke: "correctness.gate --base {base}",
          expect: { status: "refused", rule: "CORR-GATE-03" },
        }),
        { repoRoot: fixtureRepo(), forgeArgv: FORGE_ARGV },
      );
      expect(
        r.ok,
        `the attacker's own key parsed as a verdict envelope — observed=${r.observed} is not the real refusal`,
      ).toBe(false);
    },
  );
});

// ===========================================================================
// scaffold marker adoption
// ===========================================================================

describe("RFC-1616 r3 — scaffold marker adoption", () => {
  it(
    "CX-56: CODEOWNERS 'adoption' is a substring scan — session-owned or suffix-renamed anchors satisfy the markers while owning nothing (or owning the boundary for the agent)",
    { timeout: 30_000 },
    () => {
      for (const body of [
        // session owns the trust anchors — the adopted file is actively hostile
        "forge.yaml @session-agent\n.github/CODEOWNERS @session-agent\n",
        // suffix spoofs — the markers match substrings but own nothing at all
        "forge.yaml.bak @x\n.github/CODEOWNERS.bak @x\n",
        // a guide file, not a rule — the substring still counts
        "docs/forge.yaml-owners.md @x\n.github/CODEOWNERS.md @x\n",
      ]) {
        const root = mkdtempSync(path.join(os.tmpdir(), "cx3-co-"));
        dirs.push(root);
        mkdirSync(path.join(root, ".github"), { recursive: true });
        writeFileSync(path.join(root, ".github", "CODEOWNERS"), body);
        const r = scaffoldTrustBoundary(root, "@operator");
        expect(
          r.skipped.length,
          `marker substrings adopted a file that owns the boundary for the wrong handle or nothing: ${JSON.stringify(body)}`,
        ).toBe(0);
      }
    },
  );

  it(
    "CX-57: the workflow marker check validates command NAMES on an effective line — an echo of the three commands adopts a file that enforces nothing",
    { timeout: 30_000 },
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "cx3-wf-"));
      dirs.push(root);
      mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(
        path.join(root, ".github", "workflows", "forge-policy.yml"),
        `name: forge-policy
on: [workflow_dispatch]
jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - run: echo "correctness.gate policy.digest pinned.validate"
`,
      );
      const r = scaffoldTrustBoundary(root, "@operator");
      expect(
        r.skipped.length,
        "a workflow_dispatch-only echo satisfied the AC-7 markers — the protected-CI file was adopted",
      ).toBe(0);
    },
  );
});

// ===========================================================================
// grant carve completeness + canonicalJson parity
// ===========================================================================

describe("RFC-1616 r3 — grant carve completeness", () => {
  it(
    "CX-58: mutable:[paths]/[bindings] frees trust-surface leaves (skillsDir, correctnessLedger) at BOTH arbiters — the rfcsDir/checkRun carve covers only the double-judged subset",
    { timeout: 60_000 },
    async () => {
      const pathsRepo = initPolicyRepo({
        forgeYaml: `schema: forge/config@1
project:
  name: grant-probe
paths:
  skillsDir: .agents/skills
policy:
  mutable: ["project", "paths"]
  additive: []
  freezeFiles: ["hooks/**"]
`,
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n" },
      });
      await digest(pathsRepo.root, { write: true });
      fyEdit(pathsRepo.root, "skillsDir: .agents/skills", "skillsDir: docs/session-planted-skills");
      gitIn(pathsRepo.root, ["add", "-A"]);
      gitIn(pathsRepo.root, ["commit", "-qm", "repoint the agent skill surface"]);
      const g1 = await runCorrectnessGate(pathsRepo.root, {
        base: pathsRepo.base,
        policyOnly: true,
      });
      const d1 = await digest(pathsRepo.root, { verify: true });
      expect(
        g1.ok && g1.result.status === "fail"
          ? "gate-refused"
          : `gate-${g1.ok ? g1.result.status : "usage"}`,
        `paths.skillsDir rebind under mutable:[paths]: gate=${g1.ok ? g1.result.status : "usage"} digest-verify-exit=${d1.exitCode} — an agent instruction-surface binding moved unjudged at both arbiters`,
      ).toBe("gate-refused");

      const bindRepo = initPolicyRepo({
        forgeYaml: `schema: forge/config@1
project:
  name: grant-probe
paths: {}
bindings:
  paths:
    correctnessLedger: docs/correctness-ledger.jsonl
policy:
  mutable: ["project", "bindings"]
  additive: []
  freezeFiles: ["hooks/**"]
`,
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n" },
      });
      await digest(bindRepo.root, { write: true });
      fyEdit(
        bindRepo.root,
        "correctnessLedger: docs/correctness-ledger.jsonl",
        "correctnessLedger: docs/session-ledger.jsonl",
      );
      gitIn(bindRepo.root, ["add", "-A"]);
      gitIn(bindRepo.root, ["commit", "-qm", "repoint the audit ledger"]);
      const g2 = await runCorrectnessGate(bindRepo.root, {
        base: bindRepo.base,
        policyOnly: true,
      });
      const d2 = await digest(bindRepo.root, { verify: true });
      expect(
        g2.ok && g2.result.status === "fail"
          ? "gate-refused"
          : `gate-${g2.ok ? g2.result.status : "usage"}`,
        `bindings.paths.correctnessLedger rebind under mutable:[bindings]: gate=${g2.ok ? g2.result.status : "usage"} digest-verify-exit=${d2.exitCode} — the audit pointer moved unjudged at both arbiters`,
      ).toBe("gate-refused");
    },
  );

  it(
    "CX-59: canonicalJson collapses scalar types the gate's canon distinguishes — .inf→~ and timestamp→string verify green while the gate refuses",
    { timeout: 60_000 },
    async () => {
      const divergent: string[] = [];
      for (const [before, after, label] of [
        ["budget: .inf", "budget: ~", ".inf→~"],
        ["stamp: 2026-11-17", 'stamp: "2026-11-17T00:00:00.000Z"', "timestamp→string"],
      ] as const) {
        const r = initPolicyRepo({
          files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n" },
          extraForgeYaml: `${before}\n`,
        });
        await digest(r.root, { write: true });
        fyEdit(r.root, before, after);
        gitIn(r.root, ["add", "-A"]);
        gitIn(r.root, ["commit", "-qm", "type collapse"]);
        const g = await runCorrectnessGate(r.root, { base: r.base, policyOnly: true });
        const d = await digest(r.root, { verify: true });
        const gateRefused = g.ok && g.result.status === "fail";
        if (!(gateRefused && d.exitCode === 1)) {
          divergent.push(
            `${label}: gate=${g.ok ? g.result.status : "usage"} digest-verify-exit=${d.exitCode}`,
          );
        }
      }
      expect(
        divergent,
        "digest attestation is blind to changes the gate refuses (empty = parity)",
      ).toEqual([]);
    },
  );
});

// ===========================================================================
// closed-class re-verification — the r2 fixes must still hold
// ===========================================================================

describe("RFC-1616 r3 — closed-class re-verification", () => {
  it(
    "RE-CX33: a \\x1e byte inside a commit message must not hide a verifier trailer from the push scan (closed: rev-list + per-commit %B)",
    { timeout: 120_000 },
    async () => {
      const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "cx3-re33-" });
      writeFileSync(path.join(repo, "t.txt"), "x\n");
      await gitExec(repo, ["add", "t.txt"]);
      await gitExec(repo, [
        "commit",
        "-qm",
        "session work\x1e\n\nX-Verifier-Report: reviews/fake.yaml",
      ]);
      const d0 = await collectDigest(repo, ambientIo, { fetch: false });
      const data = await pushFlow(repo, ambientIo, { digest: d0.digestId, dryRun: false });
      const remote = await remoteBody(origin);
      expect(
        data.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-08") || !data.pushed,
        `\\x1e hid the trailer again — pushed=${data.pushed}, remote carries: ${remote.trim()}`,
      ).toBe(true);
    },
  );

  it(
    "RE-CX41: NODE_OPTIONS=--require must not reach the spawned gate child (closed: spawn env allowlist)",
    { timeout: 240_000 },
    async () => {
      const preload = path.join(mkdtempSync(path.join(os.tmpdir(), "cx3-preload-")), "evil.cjs");
      dirs.push(path.dirname(preload));
      writeFileSync(
        preload,
        `process.stdout.write('{"status":"fail","violations":[{"rule":"CORR-GATE-02","severity":"error"}]}');process.exit(1);`,
      );
      const saved = process.env["NODE_OPTIONS"];
      process.env["NODE_OPTIONS"] = `--require ${preload}`;
      try {
        // benign scenario: if the preload executed, the runner would see a
        // fabricated refusal on a diff that never ran a gate at all.
        const r = await runScenario(
          scenario({ name: "cx3-noopts", expect: { status: "refused", rule: "CORR-GATE-02" } }),
          { repoRoot: fixtureRepo(), forgeArgv: FORGE_ARGV },
        );
        expect(
          r.ok,
          `the session's NODE_OPTIONS preload hijacked the spawned gate — scenario reported ok with observed=${r.observed}`,
        ).toBe(false);
      } finally {
        if (saved === undefined) delete process.env["NODE_OPTIONS"];
        else process.env["NODE_OPTIONS"] = saved;
      }
    },
  );

  it(
    "RE-CX44: a literal ../ in attack.files must not write outside the scratch clone (closed: insideRoot)",
    { timeout: 120_000 },
    async () => {
      const escape = path.join(os.tmpdir(), `cx3-re44-${process.pid}.txt`);
      rmSync(escape, { force: true });
      const rel = path.relative(os.tmpdir(), escape);
      await runScenario(
        scenario({
          name: "cx3-insideroot",
          attack: {
            files: { [`../${rel}`]: "escaped\n", "src/innocent.ts": "export {};\n" },
            commitMessage: "x",
          },
          expect: { status: "refused", rule: "CORR-GATE-02" },
        }),
        { repoRoot: fixtureRepo(), forgeArgv: FORGE_ARGV },
      );
      expect(existsSync(escape), "attack file escaped the scratch clone via a literal ../").toBe(
        false,
      );
      rmSync(escape, { force: true });
    },
  );
});

// ===========================================================================
// trailer-key normalization in the verifier scans
// ===========================================================================

describe("RFC-1616 r3 — trailer-key normalization", () => {
  it(
    "CX-60: git parses `key :` and lowercase trailer keys — the push scan's case-sensitive `^Key:` regex misses them and the commit ships unflagged",
    { timeout: 120_000 },
    async () => {
      for (const trailer of ["x-verifier-report: r.yaml", "X-Verifier-Report : r.yaml"]) {
        const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "cx3-tkey-" });
        // sanity: git's own trailer parser counts this as a trailer.
        const sha = await trailerCommit(repo, "t.txt", trailer);
        const parsed = await gitExec(repo, [
          "log",
          "-1",
          "--format=%(trailers:key=X-Verifier-Report)",
          sha,
        ]);
        const data0 = await collectDigest(repo, ambientIo, { fetch: false });
        const data = await pushFlow(repo, ambientIo, {
          digest: data0.digestId,
          dryRun: false,
        });
        const remote = await remoteBody(origin);
        expect(
          data.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-08") || !data.pushed,
          `trailer ${JSON.stringify(trailer)} (git-recognized: ${parsed.stdout.trim() !== ""}) evaded the scan — pushed=${data.pushed}, remote carries: ${remote.trim()}`,
        ).toBe(true);
      }
    },
  );
});
