/*
<MODULE_CONTRACT>
<purpose>
RFC-1616 acceptance probes — independent round-2 verification of the external
verification trust boundary after the r1 fixes (e9add1cd5 + 8c9e1688a).
R2-CX* probes re-run the previously-failing behaviours (exit-code refusal
semantics, digest coverage, inert-file scaffold, project.owner carve). CX-33+
probes attack the REPAIRED surfaces: observedVerdict JSON slicing, spawn env
inheritance, \x1e git-record framing in the trailer scans, the additive/mutable
grant asymmetries between the in-repo gate and the digest, CODEOWNERS merge
precedence, marker spoofing, and owner-string injection. PASS = contour held,
FAIL = live counterexample.
</purpose>
<non-goals>
  <item>Not a contract source of truth — os/adversarial, os/core/handlers/policy-digest.ts, os/flow/handlers/flow-push.ts own behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1616: independent acceptance verification r2 — 26 probes, 13 counterexamples.</item>
  <item>RFC-1616: port RFC-1616 round-2 independent verifier probes

Port the clean-context verifier's 27-probe suite verbatim as
trust-boundary-cx2.test.ts and persist its acceptance report
(verdict: refuted, isolation: subagent) - 13 counterexamples landed and
were closed in 7c8049616.</item>
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
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { AdversarialScenario } from "../../../src/adversarial/types.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";
import { ambientIo } from "../../../src/utils/io.ts";
import {
  codeownersTemplate,
  scaffoldTrustBoundary,
} from "../../../src/onboarding/trust-boundary.ts";
import { loadForgeConfig } from "../../../src/config/forge-config.ts";
import { runScenario } from "../../adversarial/runner.ts";
import { loadCatalog } from "../../adversarial/catalog.ts";
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

// ---------------------------------------------------------------------------
// fixtures (self-contained copies of the cx1 helpers)
// ---------------------------------------------------------------------------

function fixtureRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx2-adv-base-"));
  dirs.push(root);
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "seed"]);
  return root;
}

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

async function digest(root: string, flags: Record<string, boolean | string>) {
  return runPolicyDigest({ argv: [], flags }, ctx(root));
}

function initPolicyRepo(opts: {
  mutable?: string;
  additive?: string;
  freezeFiles?: string;
  extraForgeYaml?: string;
  files?: Record<string, string>;
  policyBlock?: boolean;
}): { root: string; base: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx2-pd-"));
  dirs.push(root);
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  const policy =
    opts.policyBlock === false
      ? ""
      : `policy:
  mutable: ${opts.mutable ?? "[project]"}
  additive: ${opts.additive ?? "[]"}
  freezeFiles: ${opts.freezeFiles ?? '["hooks/**"]'}
`;
  writeFileSync(
    path.join(root, "forge.yaml"),
    `schema: forge/config@1
project:
  name: pd-probe
paths: {}
${policy}${opts.extraForgeYaml ?? ""}`,
  );
  for (const [rel, body] of Object.entries(opts.files ?? {})) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  g(["add", "-A"]);
  g(["commit", "-qm", "base"]);
  return { root, base: g(["rev-parse", "HEAD"]).trim() };
}

const gitIn = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const fyPath = (root: string) => path.join(root, "forge.yaml");
const fyEdit = (root: string, from: string, to: string) => {
  const body = readFileSync(fyPath(root), "utf8");
  if (!body.includes(from)) throw new Error(`fyEdit: ${from} not present`);
  writeFileSync(fyPath(root), body.replace(from, to));
};

function scenario(partial: Partial<AdversarialScenario> & Pick<AdversarialScenario, "expect">) {
  return {
    schema: "forge/adversarial-scenario@1",
    name: partial.name ?? "cx-probe",
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

function catalogScenario(name: string): AdversarialScenario {
  const e = loadCatalog().find((x) => x.name === name);
  if (!e?.scenario) throw new Error(`catalog scenario ${name} missing/invalid: ${e?.error}`);
  return e.scenario;
}

async function trailerCommit(repo: string, file: string, trailerLine: string): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(repo, file), "x\n");
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-qm", `session work\n\n${trailerLine}`]);
  return (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

// ===========================================================================
// A. re-verification of the r1 fixes
// ===========================================================================

describe("RFC-1616 r2 — r1 fix re-verification: adversarial.run", () => {
  it(
    "R2-CX1: echo-argv no longer fabricates a refusal — the spawned process's exit code, not its printed tokens, is the refusal signal",
    { timeout: 120_000 },
    async () => {
      const r = await runScenario(catalogScenario("weaken-oracle"), {
        repoRoot: fixtureRepo(),
        forgeArgv: ["/bin/echo", "CORR-GATE-02 CORR-GATE-03 CORR-GATE-04 FLOW-INT-18"],
      });
      expect(r.ok).toBe(false);
    },
  );

  it(
    "R2-CX2: manifest-entry id echo — the true CORR-GATE-03 refusal is observed; the echoed CORR-GATE-02 token is not credited",
    { timeout: 240_000 },
    async () => {
      const planted = scenario({
        name: "token-echo",
        setup: [
          {
            contour: {
              manifestExtra: `  - id: CORR-GATE-02
    source: req
    ref: REQ-01
    seam: data
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:no-such-oracle.ts
        substrate: L1
`,
              extraFiles: {
                "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
                ".forge/pinned.yaml": "pinned: []\n",
              },
            },
          },
        ],
        expect: { status: "refused", rule: "CORR-GATE-02" },
      });
      const paired = await runScenario(
        {
          ...planted,
          name: "token-echo-pair",
          expect: { status: "refused", rule: "CORR-GATE-03" },
        },
        { repoRoot: fixtureRepo(), forgeArgv: FORGE_ARGV },
      );
      expect(paired.observed).toBe("CORR-GATE-03");
      const r = await runScenario(planted, {
        repoRoot: fixtureRepo(),
        forgeArgv: FORGE_ARGV,
      });
      expect(r.ok).toBe(false);
    },
  );

  it(
    "R2-CX3: warn-mode gate exits 0 — a warning-severity expected rule is not a refusal",
    { timeout: 120_000 },
    async () => {
      const warnForgeYaml = `schema: forge/config@1
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
  mode: warn
  tier: standard
policy:
  mutable: ["project"]
  additive: []
  freezeFiles: ["hooks/**", ".forge/pinned.yaml"]
agentTools:
  deny: ["deploy"]
`;
      const warnContour = scenario({
        name: "warn-mode-pass",
        setup: [
          {
            contour: {
              manifestExtra: `  - id: CM-self-oracle
    source: req
    ref: REQ-01
    seam: data
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:no-such-oracle.ts
        substrate: L1
`,
              extraFiles: {
                "forge.yaml": warnForgeYaml,
                "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
                ".forge/pinned.yaml": "pinned: []\n",
              },
            },
          },
        ],
        expect: { status: "refused", rule: "CORR-GATE-03" },
      });
      const r = await runScenario(warnContour, {
        repoRoot: fixtureRepo(),
        forgeArgv: FORGE_ARGV,
      });
      expect(r.ok).toBe(false);
    },
  );
});

describe("RFC-1616 r2 — r1 fix re-verification: policy.digest coverage", () => {
  it(
    "R2-CX11: mutable:[policy] can no longer drop the policy: declaration out of the digest (ALWAYS_JUDGED)",
    { timeout: 30_000 },
    async () => {
      const hole = initPolicyRepo({
        mutable: "[project, policy]",
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      await digest(hole.root, { write: true });
      fyEdit(hole.root, 'freezeFiles: ["hooks/**"]', "freezeFiles: []");
      const v = await digest(hole.root, { verify: true });
      expect(v.exitCode).toBe(1);
    },
  );

  it(
    "R2-CX12: .github/CODEOWNERS is inside the digested surface — editing the ownership anchor fails --verify",
    { timeout: 30_000 },
    async () => {
      const r = initPolicyRepo({
        files: {
          "hooks/h.sh": "#!/bin/sh\nexit 0\n",
          ".forge/pinned.yaml": "pinned: []\n",
          ".github/workflows/forge-policy.yml": "on: push\n",
          ".github/CODEOWNERS": "forge.yaml @owner\n",
        },
      });
      await digest(r.root, { write: true });
      writeFileSync(path.join(r.root, ".github/CODEOWNERS"), "# boundary removed\n");
      const v = await digest(r.root, { verify: true });
      expect(v.exitCode).toBe(1);
    },
  );

  it(
    "R2-CX13: a committed exec-bit flip on a frozen file advances the digest (--verify --base refuses)",
    { timeout: 30_000 },
    async () => {
      const r = initPolicyRepo({
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      await digest(r.root, { write: true });
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "attest"]);
      const base = gitIn(r.root, ["rev-parse", "HEAD"]).trim();
      chmodSync(path.join(r.root, "hooks", "h.sh"), 0o755);
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "chmod the frozen hook"]);
      const v = await digest(r.root, { verify: true, base });
      expect(v.exitCode).toBe(1);
    },
  );
});

describe("RFC-1616 r2 — r1 fix re-verification: scaffold + owner carve", () => {
  it(
    "R2-CX28: session-planted inert files are replaced, not silently adopted — marker-missing CODEOWNERS is merged, workflow backed up + rewritten",
    { timeout: 30_000 },
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "cx2-scaffold-"));
      dirs.push(root);
      mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(path.join(root, ".github", "CODEOWNERS"), "# agent's own file\n");
      writeFileSync(
        path.join(root, ".github", "workflows", "forge-policy.yml"),
        "# inert workflow — no jobs\n",
      );
      const r = scaffoldTrustBoundary(root, "@operator");
      expect(r.replaced).toContain(".github/CODEOWNERS");
      expect(r.replaced).toContain(".github/workflows/forge-policy.yml");
      const wf = readFileSync(path.join(root, ".github", "workflows", "forge-policy.yml"), "utf8");
      expect(wf).toContain("correctness.gate");
      expect(
        readFileSync(
          path.join(root, ".github", "workflows", "forge-policy.yml.pre-scaffold"),
          "utf8",
        ),
      ).toContain("inert workflow");
    },
  );

  it("R2-CX29: the shipped CODEOWNERS template owns .github/CODEOWNERS itself", () => {
    const tpl = readFileSync(
      path.join(PKG_ROOT, "src", "scaffold", "github", "CODEOWNERS.template"),
      "utf8",
    );
    expect(tpl).toMatch(/\.github\/CODEOWNERS/);
  });

  it(
    "R2-CX32: project.owner flip/add/remove under the default mutable:[project] all refuse (the trust-anchor carve)",
    { timeout: 60_000 },
    async () => {
      const mk = async (baseOwner: string | null, headOwner: string | null) => {
        const r = initPolicyRepo({ mutable: "[project]" });
        if (baseOwner !== null) {
          fyEdit(r.root, "name: pd-probe", `name: pd-probe\n  owner: '${baseOwner}'`);
        }
        gitIn(r.root, ["add", "forge.yaml"]);
        gitIn(r.root, ["commit", "-qm", "adopt", "--allow-empty"]);
        const base = gitIn(r.root, ["rev-parse", "HEAD"]).trim();
        const fy = readFileSync(fyPath(r.root), "utf8");
        const now =
          baseOwner !== null && headOwner === null
            ? fy.replace(`\n  owner: '${baseOwner}'`, "")
            : baseOwner !== null
              ? fy.replace(`'${baseOwner}'`, `'${headOwner}'`)
              : fy.replace("name: pd-probe", `name: pd-probe\n  owner: '${headOwner}'`);
        writeFileSync(fyPath(r.root), now);
        gitIn(r.root, ["add", "forge.yaml"]);
        gitIn(r.root, ["commit", "-qm", "owner change"]);
        return runCorrectnessGate(r.root, { base, policyOnly: true });
      };
      for (const [b, h, label] of [
        ["@operator", "@agent-self", "flip"],
        [null, "@agent-self", "add"],
        ["@operator", null, "remove"],
      ] as const) {
        const out = await mk(b, h);
        expect(out.ok).toBe(true);
        if (out.ok) {
          expect(
            out.result.status,
            `project.owner ${label} under mutable:[project] must refuse`,
          ).toBe("fail");
        }
      }
    },
  );

  it(
    "R2-CX32b: combined micro-weakening — owner rebind + inert CODEOWNERS + mode downgrade in ONE diff still refuses",
    { timeout: 60_000 },
    async () => {
      const r = initPolicyRepo({
        mutable: "[project]",
        freezeFiles: '["hooks/**", ".github/CODEOWNERS", ".forge/pinned.yaml"]',
        files: {
          ".github/CODEOWNERS": "forge.yaml @operator\n",
          "hooks/h.sh": "#!/bin/sh\nexit 0\n",
          ".forge/pinned.yaml": "pinned: []\n",
        },
        extraForgeYaml: "correctness:\n  mode: enforce\n",
      });
      fyEdit(r.root, "name: pd-probe", "name: pd-probe\n  owner: '@operator'");
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "adopt"]);
      const base = gitIn(r.root, ["rev-parse", "HEAD"]).trim();
      // one session diff combining three small weakenings.
      fyEdit(r.root, "'@operator'", "'@agent-self'");
      fyEdit(r.root, "mode: enforce", "mode: warn");
      writeFileSync(path.join(r.root, ".github", "CODEOWNERS"), "# nothing owned\n");
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "routine tidy-up"]);
      const out = await runCorrectnessGate(r.root, { base, policyOnly: true });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result.status).toBe("fail");
    },
  );
});

// ===========================================================================
// B. new counterexample probes — repaired surfaces under adversarial input
// ===========================================================================

describe("RFC-1616 r2 — adversarial.run integrity", () => {
  it(
    "CX-33: \\x1e in a commit message splits the git record — a verifier trailer hidden behind the record separator pushes unflagged (scanVerifierTrailers + correctnessTrailOf share the framing bug)",
    { timeout: 120_000 },
    async () => {
      const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "cx2-push-" });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path.join(repo, "inj.txt"), "x\n");
      await gitExec(repo, ["add", "inj.txt"]);
      // \x1e inside %B: `git log --format=%H\x1f%B\x1e` emits the body verbatim —
      // the record splits mid-message and the trailer tail is dropped.
      await gitExec(repo, ["commit", "-qm", "session work\x1e\n\nX-Verifier-Report: r.yaml"]);
      const sha = (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
      const digest = await collectDigest(repo, ambientIo, { fetch: false });
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect
        .soft(
          data.diagnostics[0]?.ruleId,
          `the \\x1e-framed trailer scan missed a verifier commit — push outcome ${JSON.stringify({ pushed: data.pushed })}`,
        )
        .toBe("FLOW-PUSH-08");
      // the digest's own correctness trail is blind to the same commit:
      expect(
        digest.correctnessTrail?.verifierCommits.some((c) => c.sha === sha),
        "flow.digest's verifierCommits listing is blind to the \\x1e-split commit too",
      ).toBe(true);
      void origin;
    },
  );

  it(
    "CX-34: the 'policy:-frozen' review switch honors the UNCOMMITTED forge.yaml — a dirty `push.requireVerifierReview: false` skips the hard stop while the judged (committed) surface still requires it",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx2-push-" });
      await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      // valid config opting out — left dirty in the worktree, never committed.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        path.join(repo, "forge.yaml"),
        "schema: forge/config@1\nproject:\n  name: x\npaths: {}\npush:\n  requireVerifierReview: false\n",
      );
      const digest = await collectDigest(repo, ambientIo, { fetch: false });
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(data.pushed, "a verifier-trailer commit left the machine under a dirty opt-out").toBe(
        false,
      );
    },
  );

  it(
    "CX-41: the 'real forge binary' is spawned with the session's whole env — NODE_OPTIONS=--require preloads attacker code into the gate process and fabricates the verdict",
    { timeout: 120_000 },
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "cx2-preload-"));
      dirs.push(dir);
      const preload = path.join(dir, "evil.cjs");
      writeFileSync(
        preload,
        `console.log(JSON.stringify({status:"fail",violations:[{rule:"CORR-GATE-02",severity:"error"}]}));\nprocess.exit(1);\n`,
      );
      const saved = process.env["NODE_OPTIONS"];
      process.env["NODE_OPTIONS"] = `--require ${preload}`;
      try {
        // Amended probe (implementation session): a BENIGN scenario — the
        // real gate passes (exit 0), so a refusal can ONLY come from the
        // preload. `weaken-oracle` cannot isolate the env channel: the real
        // gate refuses CORR-GATE-02 there honestly, so r.ok===true is the
        // CORRECT outcome under a fixed spawn env and the assertion cannot
        // distinguish fabricated from real refusal.
        const r = await runScenario(
          scenario({ name: "cx2-preload", expect: { status: "refused", rule: "CORR-GATE-02" } }),
          {
            repoRoot: fixtureRepo(),
            forgeArgv: FORGE_ARGV,
          },
        );
        expect(
          r.ok,
          "NODE_OPTIONS preload printed a synthetic verdict and exited 1 — the runner credited it as a real CORR-GATE-02 refusal",
        ).toBe(false);
      } finally {
        if (saved === undefined) delete process.env["NODE_OPTIONS"];
        else process.env["NODE_OPTIONS"] = saved;
      }
    },
  );

  it(
    'CX-42: non-json (pretty) gate output is brace-sliced — an attacker-authored forge.yaml key `{"rule": "CORR-GATE-03"}` parses as a verdict document and fabricates the expected rule',
    { timeout: 240_000 },
    async () => {
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
'{"rule": "CORR-GATE-03"}': probe
`;
      const mk = (invoke: string) =>
        scenario({
          name: invoke.includes("--json") ? "brace-json" : "brace-pretty",
          attack: {
            files: { "forge.yaml": seededForgeYaml },
            commitMessage: "session diff",
          },
          invoke,
          expect: { status: "refused", rule: "CORR-GATE-03" },
        });
      // control: with --json the real refusal surfaces as CORR-GATE-02.
      const control = await runScenario(mk("correctness.gate --base {base} --json"), {
        repoRoot: fixtureRepo(),
        forgeArgv: FORGE_ARGV,
      });
      expect(control.observed).toBe("CORR-GATE-02");
      // pretty mode: stderr renders the policy-key message verbatim; the
      // slice-from-first-{ to last-} extracts the attacker key as a JSON doc.
      const r = await runScenario(mk("correctness.gate --base {base}"), {
        repoRoot: fixtureRepo(),
        forgeArgv: FORGE_ARGV,
      });
      expect(
        r.ok,
        `pretty-mode run reported observed=${r.observed} — the scenario's expected rule came out of the attacker's own forge.yaml key, not the gate`,
      ).toBe(false);
    },
  );

  it(
    "CX-44: attack.files `../` path escape — a scenario writes outside the scratch clone and the file survives cleanup",
    { timeout: 120_000 },
    async () => {
      const escapee = path.join(os.tmpdir(), "cx2-escape-marker.txt");
      rmSync(escapee, { force: true });
      await runScenario(
        scenario({
          name: "cx2-escape",
          attack: {
            files: {
              "../cx2-escape-marker.txt": "pwn\n",
              "src/innocent.ts": "export const ok = 1;\n",
            },
            commitMessage: "x",
          },
          expect: { status: "refused", rule: "CORR-GATE-02" },
        }),
        { repoRoot: fixtureRepo(), forgeArgv: FORGE_ARGV },
      );
      const escaped = existsSync(escapee);
      rmSync(escapee, { force: true });
      expect(
        escaped,
        "attack file with a ../ path landed outside the scratch dir and persists after rmSync(scratch)",
      ).toBe(false);
    },
  );
});

describe("RFC-1616 r2 — gate/digest grant asymmetries", () => {
  it(
    "CX-35: mutable:[push] — the review opt-out is mutable at the GATE but ALWAYS_JUDGED at the digest; a committed requireVerifierReview flip integrates unjudged",
    { timeout: 60_000 },
    async () => {
      const hole = initPolicyRepo({
        mutable: "[project, push]",
        extraForgeYaml: "push:\n  requireVerifierReview: true\n",
      });
      await digest(hole.root, { write: true });
      fyEdit(hole.root, "requireVerifierReview: true", "requireVerifierReview: false");
      gitIn(hole.root, ["add", "forge.yaml"]);
      gitIn(hole.root, ["commit", "-qm", "disable verifier review"]);
      const out = await runCorrectnessGate(hole.root, { base: hole.base, policyOnly: true });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect
          .soft(
            out.result.status,
            `mutable:[push] let the review switch flip unjudged — violations: ${JSON.stringify(out.result.violations)}`,
          )
          .toBe("fail");
      }
      // asymmetry proven: the same diff IS caught by policy.digest (push is
      // ALWAYS_JUDGED there) — the in-repo gate is the blind arbiter.
      const v = await digest(hole.root, { verify: true });
      expect(v.exitCode, "the digest DOES judge push — gate/digest divergence").toBe(1);
      // control: with push outside mutable the same flip refuses.
      const ctl = initPolicyRepo({
        mutable: "[project]",
        extraForgeYaml: "push:\n  requireVerifierReview: true\n",
      });
      fyEdit(ctl.root, "requireVerifierReview: true", "requireVerifierReview: false");
      gitIn(ctl.root, ["add", "forge.yaml"]);
      gitIn(ctl.root, ["commit", "-qm", "disable verifier review"]);
      const ctlOut = await runCorrectnessGate(ctl.root, { base: ctl.base, policyOnly: true });
      expect(ctlOut.ok).toBe(true);
      if (ctlOut.ok) expect(ctlOut.result.status).toBe("fail");
    },
  );

  it(
    "CX-36: additive:[push] — a session may ADD `push.requireVerifierReview: false` unjudged (every leaf is new)",
    { timeout: 60_000 },
    async () => {
      const hole = initPolicyRepo({ mutable: "[project]", additive: "[push]" });
      writeFileSync(
        fyPath(hole.root),
        readFileSync(fyPath(hole.root), "utf8") + "push:\n  requireVerifierReview: false\n",
      );
      gitIn(hole.root, ["add", "forge.yaml"]);
      gitIn(hole.root, ["commit", "-qm", "opt the repo out of verifier review"]);
      const out = await runCorrectnessGate(hole.root, { base: hole.base, policyOnly: true });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect
          .soft(
            out.result.status,
            `additive:[push] let the review opt-out appear unjudged — violations: ${JSON.stringify(out.result.violations)}`,
          )
          .toBe("fail");
      }
      // control: with additive:[] the same addition refuses as a new frozen key.
      const ctl = initPolicyRepo({ mutable: "[project]", additive: "[]" });
      writeFileSync(
        fyPath(ctl.root),
        readFileSync(fyPath(ctl.root), "utf8") + "push:\n  requireVerifierReview: false\n",
      );
      gitIn(ctl.root, ["add", "forge.yaml"]);
      gitIn(ctl.root, ["commit", "-qm", "opt out"]);
      const ctlOut = await runCorrectnessGate(ctl.root, { base: ctl.base, policyOnly: true });
      expect(ctlOut.ok).toBe(true);
      if (ctlOut.ok) expect(ctlOut.result.status).toBe("fail");
    },
  );

  it(
    "CX-37: additive:[project] — the owner carve only lives inside the mutable branch; adding project.owner under an additive grant is unjudged (digest still catches it)",
    { timeout: 60_000 },
    async () => {
      const hole = initPolicyRepo({ mutable: "[]", additive: "[project]" });
      await digest(hole.root, { write: true });
      fyEdit(hole.root, "name: pd-probe", "name: pd-probe\n  owner: '@agent-self'");
      gitIn(hole.root, ["add", "forge.yaml"]);
      gitIn(hole.root, ["commit", "-qm", "claim code ownership"]);
      const out = await runCorrectnessGate(hole.root, { base: hole.base, policyOnly: true });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect
          .soft(
            out.result.status,
            `additive:[project] let owner appear unjudged — violations: ${JSON.stringify(out.result.violations)}`,
          )
          .toBe("fail");
      }
      const v = await digest(hole.root, { verify: true });
      expect(v.exitCode, "the digest DOES judge the owner add").toBe(1);
    },
  );

  it(
    "CX-45: mutable:[correctness] — `correctness` is claimed self-frozen regardless of mutable membership, but unjudged subkeys (oracleTimeoutMs) flip clean through gate AND digest",
    { timeout: 60_000 },
    async () => {
      const hole = initPolicyRepo({
        mutable: "[project, correctness]",
        extraForgeYaml: "correctness:\n  mode: enforce\n  oracleTimeoutMs: 30000\n",
      });
      await digest(hole.root, { write: true });
      fyEdit(hole.root, "oracleTimeoutMs: 30000", "oracleTimeoutMs: 1");
      gitIn(hole.root, ["add", "forge.yaml"]);
      gitIn(hole.root, ["commit", "-qm", "shrink oracle budget"]);
      const out = await runCorrectnessGate(hole.root, { base: hole.base, policyOnly: true });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect
          .soft(
            out.result.status,
            `mutable:[correctness] let oracleTimeoutMs flip unjudged — violations: ${JSON.stringify(out.result.violations)}`,
          )
          .toBe("fail");
      }
      const v = await digest(hole.root, { verify: true });
      expect(
        v.exitCode,
        "correctness is excluded from the digest under mutable:[correctness] — no ALWAYS_JUDGED coverage despite the 'self-frozen' claim",
      ).toBe(1);
    },
  );
});

describe("RFC-1616 r2 — digest canonicalization edge", () => {
  it(
    "CX-43: the digest parses forge.yaml without intAsBigInt — a frozen-leaf change between integers that collapse to the same double verifies clean while the gate (intAsBigInt) refuses",
    { timeout: 60_000 },
    async () => {
      const r = initPolicyRepo({
        mutable: "[project]",
        extraForgeYaml: "correctness:\n  oracleTimeoutMs: 9007199254740993\n",
      });
      await digest(r.root, { write: true });
      fyEdit(r.root, "9007199254740993", "9007199254740992");
      // worktree verify: the stored sha attests ...993, the surface now ...992.
      const v = await digest(r.root, { verify: true });
      expect
        .soft(
          v.exitCode,
          "9007199254740993 and 9007199254740992 digest identically — a real change to a judged leaf is invisible to the attestation",
        )
        .toBe(1);
      // control: the gate's canon (intAsBigInt) sees the same diff as a weakening.
      gitIn(r.root, ["add", "forge.yaml"]);
      gitIn(r.root, ["commit", "-qm", "int collapse"]);
      const out = await runCorrectnessGate(r.root, { base: r.base, policyOnly: true });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result.status).toBe("fail");
    },
  );
});

describe("RFC-1616 r2 — scaffold adversarial surface", () => {
  it(
    "CX-38: marker-missing CODEOWNERS is 'merged' — but the kept lines land AFTER the boundary block, so GitHub's last-match-wins hands the planted wildcard rule ownership of everything",
    { timeout: 30_000 },
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "cx2-scaffold-"));
      dirs.push(root);
      mkdirSync(path.join(root, ".github"), { recursive: true });
      writeFileSync(path.join(root, ".github", "CODEOWNERS"), "# team file\n* @session-agent\n");
      const r = scaffoldTrustBoundary(root, "@operator");
      expect(r.replaced).toContain(".github/CODEOWNERS");
      const body = readFileSync(path.join(root, ".github", "CODEOWNERS"), "utf8");
      // GitHub CODEOWNERS semantics: the LAST matching pattern owns the file.
      // The scaffold appends pre-existing lines after the boundary block, so
      // the planted `* @session-agent` shadows every `forge.yaml @operator` line.
      expect(
        body.indexOf("* @session-agent") < body.lastIndexOf("forge.yaml"),
        "a pre-existing wildcard rule survives the merge positioned after the boundary rules — the session keeps ownership",
      ).toBe(true);
    },
  );

  it(
    "CX-39: marker check is `body.includes` — pure-comment files containing the marker strings count as adopted and are skipped verbatim",
    { timeout: 30_000 },
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "cx2-scaffold-"));
      dirs.push(root);
      mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(
        path.join(root, ".github", "CODEOWNERS"),
        "# forge.yaml\n# .github/CODEOWNERS\n# (markers in comments — enforces nothing)\n",
      );
      writeFileSync(
        path.join(root, ".github", "workflows", "forge-policy.yml"),
        "# correctness.gate\n# policy.digest\n# pinned.validate\non: [push]\njobs: {}\n",
      );
      const r = scaffoldTrustBoundary(root, "@operator");
      expect
        .soft(
          r.replaced,
          `comment-spoofed CODEOWNERS was skipped as adopted (skipped: ${r.skipped.join(", ")})`,
        )
        .toContain(".github/CODEOWNERS");
      expect(
        r.replaced,
        `comment-spoofed workflow was skipped as adopted (skipped: ${r.skipped.join(", ")})`,
      ).toContain(".github/workflows/forge-policy.yml");
    },
  );

  it(
    "CX-40: project.owner flows into CODEOWNERS unsanitized — a newline-bearing owner injects an arbitrary ownership rule",
    { timeout: 30_000 },
    () => {
      const tpl = codeownersTemplate("@team\n* @agent-self");
      expect
        .soft(
          /^\* @agent-self$/m.test(tpl),
          "owner injection: `* @agent-self` now owns every path in CODEOWNERS",
        )
        .toBe(false);
      // and the schema accepts the injected value unchanged.
      const root = mkdtempSync(path.join(os.tmpdir(), "cx2-owner-"));
      dirs.push(root);
      writeFileSync(
        path.join(root, "forge.yaml"),
        'schema: forge/config@1\nproject:\n  name: x\n  owner: "@team\\n* @agent-self"\npaths: {}\n',
      );
      const cfg = loadForgeConfig(root);
      expect(
        cfg.project.owner,
        "loadForgeConfig returns a newline-bearing owner — nothing sanitizes the trust anchor string",
      ).not.toContain("\n");
    },
  );
});

// ===========================================================================
// C. documented semantics (pass) — kept as probes so the report can cite runs
// ===========================================================================

describe("RFC-1616 r2 — documented behaviour", () => {
  it(
    "CX-46: a SIGKILL'd (timed-out) gate counts as refused but yields no rule — the kill path cannot fabricate a verdict",
    { timeout: 60_000 },
    async () => {
      const r = await runScenario(
        scenario({ name: "cx2-kill", expect: { status: "refused", rule: "CORR-GATE-02" } }),
        {
          repoRoot: fixtureRepo(),
          forgeArgv: [process.execPath, "-e", "setTimeout(()=>{},60000)"],
          timeoutMs: 50,
        },
      );
      expect(r.observed).toBe("none");
      expect(r.ok).toBe(false);
    },
  );

  it(
    "CX-47: keepScratch leaves the scratch clone; scratch git identity is adversarial@forge (commit provenance is honest)",
    { timeout: 120_000 },
    async () => {
      const before = readdirSync(os.tmpdir()).filter((d) => d.startsWith("forge-adv-cx2-ident-"));
      await runScenario(
        scenario({ name: "cx2-ident", expect: { status: "refused", rule: "CORR-GATE-02" } }),
        { repoRoot: fixtureRepo(), forgeArgv: FORGE_ARGV, keepScratch: true },
      );
      const news = readdirSync(os.tmpdir()).filter(
        (d) => d.startsWith("forge-adv-cx2-ident-") && !before.includes(d),
      );
      expect(news.length).toBe(1);
      const scratch = path.join(os.tmpdir(), news[0]!);
      dirs.push(scratch);
      expect(gitIn(scratch, ["log", "-1", "--format=%ae"]).trim()).toBe("adversarial@forge");
      expect(gitIn(scratch, ["log", "-1", "--format=%an"]).trim()).toBe("adversarial");
    },
  );

  it(
    "CX-48: freezeFiles ['.forge/**'] self-includes .forge/policy.digest — every --verify fails forever (operator trap, fail-closed direction)",
    { timeout: 30_000 },
    async () => {
      const r = initPolicyRepo({
        freezeFiles: '[".forge/**"]',
        files: { ".forge/pinned.yaml": "pinned: []\n" },
      });
      const w = await digest(r.root, { write: true });
      expect(w.exitCode).toBe(0);
      const v = await digest(r.root, { verify: true });
      expect(v.exitCode).toBe(1);
    },
  );

  it(
    "CX-49: re-scaffolding overwrites .pre-scaffold backups; kept CODEOWNERS lines are LF-normalized but content-preserved",
    { timeout: 30_000 },
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "cx2-scaffold-"));
      dirs.push(root);
      mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
      const wf = path.join(root, ".github", "workflows", "forge-policy.yml");
      const backup = `${wf}.pre-scaffold`;
      writeFileSync(wf, "# inert v1\n");
      scaffoldTrustBoundary(root, "@op");
      expect(readFileSync(backup, "utf8")).toBe("# inert v1\n");
      writeFileSync(wf, "# inert v2\n");
      scaffoldTrustBoundary(root, "@op");
      expect(
        readFileSync(backup, "utf8"),
        "the second scaffold silently overwrote the first backup — v1 is gone",
      ).toBe("# inert v2\n");
      const root2 = mkdtempSync(path.join(os.tmpdir(), "cx2-scaffold-"));
      dirs.push(root2);
      mkdirSync(path.join(root2, ".github"), { recursive: true });
      writeFileSync(path.join(root2, ".github", "CODEOWNERS"), "docs/ @téam\r\n# france\n");
      scaffoldTrustBoundary(root2, "@op");
      const merged = readFileSync(path.join(root2, ".github", "CODEOWNERS"), "utf8");
      expect(merged).toContain("docs/ @téam");
      expect(merged).not.toContain("\r");
    },
  );
});
