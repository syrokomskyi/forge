/*
<MODULE_CONTRACT>
<purpose>
RFC-1616 acceptance probes — independent round-1 verification of the external
verification trust boundary: policy.digest canonicalization/advance detection,
adversarial.run harness integrity (resolveForgeArgv, observedRule extraction,
scratch isolation, exit-code credulity), flow.push verifier-trailer scan, and
the trust-boundary scaffold (CODEOWNERS / forge-policy workflow write-when-
absent). Each CX-* probe is one adversarial attempt: PASS = the contour held,
FAIL = a live counterexample.
</purpose>
<non-goals>
  <item>Not a contract source of truth — os/adversarial, os/core/handlers/policy-digest.ts, os/flow/handlers/flow-push.ts own behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1616: independent acceptance verification r1 — adversarial probes across digest, runner, push scan, and scaffold.</item>
  <item>RFC-1616: port RFC-1616 round-1 independent verifier probes

Port the clean-context verifier's 35-probe suite verbatim as
trust-boundary-cx1.test.ts and persist its acceptance report
(verdict: refuted, isolation: subagent) - 9 counterexamples landed and
were closed in e9add1cd5/8c9e1688a.</item>
</CHANGE_SUMMARY>
*/

import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
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
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { AdversarialScenario } from "../../../src/adversarial/types.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";
import { ambientIo } from "../../../src/utils/io.ts";
import {
  codeownersTemplate,
  scaffoldTrustBoundary,
} from "../../../src/onboarding/trust-boundary.ts";
import { runScenario, resolveForgeArgv } from "../../adversarial/runner.ts";
import { loadCatalog } from "../../adversarial/catalog.ts";
import { runPolicyDigest } from "../../core/handlers/policy-digest.ts";
import { runCorrectnessStep } from "../../flow/correctness-step.ts";
import { collectDigest } from "../../flow/digest.ts";
import { pushFlow } from "../../flow/handlers/flow-push.ts";
import { gitExec, initRepoWithOrigin } from "../../flow/tests/helpers.ts";
import { runCorrectnessGate } from "./run.ts";

const execFileAsync = promisify(execFile);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(MODULE_DIR, "../../..");
const FORGE_BIN = path.join(PKG_ROOT, "bin", "cli.js");
const FORGE_ARGV = [process.execPath, FORGE_BIN];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Minimal git repo the adversarial scenarios clone (mirrors catalog.test.ts). */
function fixtureRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx1-adv-base-"));
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

/** `policy.digest` in a tiny governed repo. */
async function digest(root: string, flags: Record<string, boolean | string>) {
  return runPolicyDigest({ argv: [], flags }, ctx(root));
}

/** Init a git repo carrying a policy declaration; returns {root, base}. */
function initPolicyRepo(opts: {
  mutable?: string;
  freezeFiles?: string;
  extraForgeYaml?: string;
  files?: Record<string, string>;
  policyBlock?: boolean;
}): { root: string; base: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx1-pd-"));
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
  additive: []
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

// ===========================================================================
// adversarial.run — harness integrity
// ===========================================================================

describe("RFC-1616 adversarial.run harness integrity", () => {
  it(
    "CX-1: FORGE_ADVERSARIAL_BIN / forgeArgv injection fabricates refusals — an argv that only echoes rule tokens must NOT yield ok:true",
    { timeout: 120_000 },
    async () => {
      // The env path is honored verbatim (arbitrary argv, not a forge path).
      process.env["FORGE_ADVERSARIAL_BIN"] = "echo CORR-GATE-02 CORR-GATE-03 CORR-GATE-04";
      const envArgv = resolveForgeArgv();
      delete process.env["FORGE_ADVERSARIAL_BIN"];
      expect(envArgv[0]).toBe("echo");
      // Drive the real runner through that argv: nothing executes a gate,
      // yet the printed tokens must not count as the observed refusal.
      const r = await runScenario(catalogScenario("weaken-oracle"), {
        repoRoot: fixtureRepo(),
        forgeArgv: ["/bin/echo", "CORR-GATE-02 CORR-GATE-03 CORR-GATE-04 FLOW-INT-18"],
      });
      expect(
        r.ok,
        "a spawned process that merely echoes rule tokens satisfied the scenario — the demonstration is fabricated",
      ).toBe(false);
    },
  );

  it(
    "CX-2: expected-rule token echo spoofs observation — a violation line carrying 'CORR-GATE-02' as a manifest entry id must not count as a CORR-GATE-02 refusal",
    { timeout: 120_000 },
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
      const r = await runScenario(planted, {
        repoRoot: fixtureRepo(),
        forgeArgv: FORGE_ARGV,
      });
      // The gate DOES refuse — CORR-GATE-03 (self oracle) whose message echoes
      // the planted entry id "CORR-GATE-02". If the runner credits the echoed
      // token, it reports the scenario passed on a refusal that never ran the
      // expected rule. The paired run proves the underlying verdict really was
      // CORR-GATE-03.
      const paired = await runScenario(
        { ...planted, expect: { status: "refused", rule: "CORR-GATE-03" } },
        { repoRoot: fixtureRepo(), forgeArgv: FORGE_ARGV },
      );
      expect(paired.observed, "the planted contour's true refusal").toBe("CORR-GATE-03");
      expect(
        r.ok,
        `observed '${r.observed}' came from entry-id echo inside a CORR-GATE-03 verdict, not a CORR-GATE-02 refusal`,
      ).toBe(false);
    },
  );

  it(
    "CX-3: exit code is ignored — a warn-mode gate that emits the expected rule as a WARNING must not count as a refusal",
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
      // In warn mode CORR-GATE-03 is downgraded to a warning — the gate exits
      // 0 yet the token is in the JSON violations, so observed == expected.
      expect(
        r.ok,
        "a gate that PASSED (warn mode, exit 0) satisfied a 'refused' expectation — exit status is never checked",
      ).toBe(false);
    },
  );

  it(
    "CX-4: control — a benign attack on the seeded contour must observe 'none' (proves the contour base is green and the harness detects non-refusal)",
    { timeout: 120_000 },
    async () => {
      const before = readdirSync(os.tmpdir()).filter((d) => d.startsWith("forge-adv-"));
      const r = await runScenario(
        scenario({ name: "cx-control", expect: { status: "refused", rule: "CORR-GATE-02" } }),
        { repoRoot: fixtureRepo(), forgeArgv: FORGE_ARGV },
      );
      expect(r.observed).toBe("none");
      expect(r.ok).toBe(false);
      // scratch cleanup: the mkdtemp scratch is removed in finally.
      const after = readdirSync(os.tmpdir()).filter((d) => d.startsWith("forge-adv-"));
      expect(after).toEqual(before);
    },
  );

  it(
    "CX-5: attack commit-message tokens must not leak into gate output — 'CORR-GATE-02' in the subject must not satisfy the expected rule",
    { timeout: 120_000 },
    async () => {
      const r = await runScenario(
        scenario({
          name: "cx-commit-msg",
          attack: {
            files: { "src/innocent.ts": "export const ok = 1;\n" },
            commitMessage: "refactor CORR-GATE-02 handling\n\nX-Verifier-Report: CORR-GATE-02",
          },
          expect: { status: "refused", rule: "CORR-GATE-02" },
        }),
        { repoRoot: fixtureRepo(), forgeArgv: FORGE_ARGV },
      );
      expect(r.observed).toBe("none");
      expect(r.ok).toBe(false);
    },
  );

  it.each(["weaken-oracle", "edit-policy-key", "spoof-verifier-trailer", "drop-manifest-entry"])(
    "CX-6: catalog scenario %s refuses as expected through the real spawned gate",
    { timeout: 180_000 },
    async (name) => {
      const r = await runScenario(catalogScenario(name), {
        repoRoot: fixtureRepo(),
        forgeArgv: FORGE_ARGV,
      });
      expect(r.observed).toBe(r.expected);
      expect(r.ok).toBe(true);
    },
  );

  it(
    "CX-7: catalog scenario downgrade-forge drives the REAL runCorrectnessStep (FLOW-INT-18), not a mock",
    { timeout: 120_000 },
    async () => {
      const r = await runScenario(catalogScenario("downgrade-forge"), {
        repoRoot: fixtureRepo(),
        forgeArgv: FORGE_ARGV,
      });
      expect(r.observed).toBe("FLOW-INT-18");
      expect(r.ok).toBe(true);
    },
  );

  it(
    "CX-8: the shipped command path — replay weaken-oracle against a clone of THIS repository",
    { timeout: 240_000 },
    async () => {
      const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: MODULE_DIR,
        encoding: "utf8",
      }).trim();
      const r = await runScenario(catalogScenario("weaken-oracle"), {
        repoRoot,
        forgeArgv: FORGE_ARGV,
      });
      expect(r.observed).toBe("CORR-GATE-02");
      expect(r.ok).toBe(true);
    },
  );

  it(
    "CX-9: downgrade harness discriminates — a primary without the binary refuses, a NON-adopted base degrades to warning only",
    { timeout: 60_000 },
    async () => {
      const scratch = mkdtempSync(path.join(os.tmpdir(), "cx1-down-"));
      dirs.push(scratch);
      gitIn(scratch, ["init", "-q"]);
      gitIn(scratch, ["config", "user.email", "t@t"]);
      gitIn(scratch, ["config", "user.name", "t"]);
      writeFileSync(path.join(scratch, "seed.txt"), "seed\n");
      gitIn(scratch, ["add", "-A"]);
      gitIn(scratch, ["commit", "-qm", "seed — no contour adopted"]);
      const base = gitIn(scratch, ["rev-parse", "HEAD"]).trim();
      // (a) missing primary binary on an adopted-contour base must refuse.
      const adopted = initPolicyRepo({});
      const missing = await runCorrectnessStep(ambientIo, {
        primary: path.join(scratch, "no-such-primary"),
        worktree: adopted.root,
        base: adopted.base,
      });
      expect(missing.status).toBe("not-run");
      expect(missing.refusal, "missing gate binary must refuse").toBeTruthy();
      // (b) unknown-command on a base that never adopted the contour is a
      // warning, never a refusal — the FLOW-INT-18 observation is earned.
      const { mkdirSync: mk, writeFileSync: wf, chmodSync: cm } = await import("node:fs");
      const primary = path.join(scratch, "primary");
      mk(path.join(primary, "node_modules", ".bin"), { recursive: true });
      wf(
        path.join(primary, "node_modules", ".bin", "forge"),
        '#!/bin/sh\necho "Unknown command: correctness.gate" >&2\nexit 1\n',
      );
      cm(path.join(primary, "node_modules", ".bin", "forge"), 0o755);
      const notAdopted = await runCorrectnessStep(ambientIo, {
        primary,
        worktree: scratch,
        base,
      });
      expect(notAdopted.refusal).toBeUndefined();
      expect(notAdopted.warning?.ruleId).toBe("FLOW-INT-18");
    },
  );

  it(
    "CX-10: adversarial.run --list and --scenario <bogus> through the real CLI binary",
    { timeout: 120_000 },
    async () => {
      const list = await execFileAsync(
        process.execPath,
        [FORGE_BIN, "adversarial.run", "--list", "--json"],
        { cwd: fixtureRepo() },
      );
      const parsed = JSON.parse(list.stdout) as { scenarios: { name: string }[] };
      expect(parsed.scenarios.length).toBe(12);
      const bogus = await execFileAsync(
        process.execPath,
        [FORGE_BIN, "adversarial.run", "--scenario", "no-such-scenario", "--json"],
        { cwd: fixtureRepo() },
      ).then(
        () => ({ code: 0 }),
        (e: { code?: number }) => ({ code: e.code ?? 1 }),
      );
      expect(bogus.code).toBe(1);
    },
  );
});

// ===========================================================================
// policy.digest — canonicalization, coverage, advance detection
// ===========================================================================

describe("RFC-1616 policy.digest surface", () => {
  it(
    "CX-11: mutable:[policy] self-exclusion — declaring `policy` mutable must not remove the policy: declaration itself from the digest",
    { timeout: 30_000 },
    async () => {
      // sanity baseline: mutable:[project] — a freezeFiles edit IS digested.
      const sane = initPolicyRepo({
        mutable: "[project]",
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      const w1 = await digest(sane.root, { write: true });
      expect(w1.exitCode).toBe(0);
      const fy = readFileSync(path.join(sane.root, "forge.yaml"), "utf8");
      writeFileSync(
        path.join(sane.root, "forge.yaml"),
        fy.replace('freezeFiles: ["hooks/**"]', "freezeFiles: []"),
      );
      const v1 = await digest(sane.root, { verify: true });
      expect(v1.exitCode, "baseline: editing policy.freezeFiles must fail --verify").toBe(1);
      // the hole: with `policy` in mutable, the whole declaration leaves the surface.
      const hole = initPolicyRepo({
        mutable: "[project, policy]",
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      const w2 = await digest(hole.root, { write: true });
      expect(w2.exitCode).toBe(0);
      const fy2 = readFileSync(path.join(hole.root, "forge.yaml"), "utf8");
      writeFileSync(
        path.join(hole.root, "forge.yaml"),
        fy2.replace('freezeFiles: ["hooks/**"]', "freezeFiles: []"),
      );
      const v2 = await digest(hole.root, { verify: true });
      expect(
        v2.exitCode,
        "policy.mutable:[…,policy] dropped the policy: section out of the digest — freezeFiles mutations verify clean",
      ).toBe(1);
    },
  );

  it(
    "CX-12: .github/CODEOWNERS is outside the digested surface — editing the ownership anchor must fail --verify",
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
      expect(
        v.exitCode,
        "the CODEOWNERS file that owns the boundary is not part of the digested surface",
      ).toBe(1);
    },
  );

  it(
    "CX-13: a mode change on a frozen file is invisible to the digest — chmod +x a hooks file must register as a surface advance",
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
      expect(
        v.exitCode,
        "exec-bit flip on a frozen file digests identically — the gate judges mode weakenings but the digest never sees them",
      ).toBe(1);
    },
  );

  it(
    "CX-14: canonicalization — YAML spell variants of the same parsed doc digest identically",
    { timeout: 30_000 },
    async () => {
      const a = initPolicyRepo({
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      const dA = await digest(a.root, {});
      expect(dA.exitCode).toBe(0);
      const sA = dA.data!.sha256;
      // same parsed doc, different spelling: flow style + quoted keys + reorder.
      writeFileSync(
        path.join(a.root, "forge.yaml"),
        `"paths": {}
"project": { "name": "pd-probe" }
"schema": "forge/config@1"
"policy": { "freezeFiles": ["hooks/**"], "additive": [], "mutable": ["project"] }
`,
      );
      const dB = await digest(a.root, {});
      expect(dB.exitCode).toBe(0);
      expect(dB.data!.sha256).toBe(sA);
    },
  );

  it(
    "CX-15: self-authored X-Policy-Digest trailer on a DIFFERENT commit launders the advance — disclosed as hints-not-proof (verifying the disclosure is honest)",
    { timeout: 30_000 },
    async () => {
      const r = initPolicyRepo({
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      const base = r.base;
      await digest(r.root, { write: true });
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "attest"]);
      // advance the surface in a plain commit — no trailer.
      writeFileSync(path.join(r.root, "hooks", "h.sh"), "#!/bin/sh\necho changed\nexit 0\n");
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "advance the frozen surface"]);
      const sha = (await digest(r.root, {})).data!.sha256!;
      // regenerate the attestation and commit it on a separate benign commit
      // carrying the self-typed trailer — the exact laundering the docs
      // disclose ("trailers are provenance hints, not proof").
      await digest(r.root, { write: true });
      writeFileSync(path.join(r.root, "note.txt"), "x\n");
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", `benign\n\nX-Policy-Digest: ${sha}`]);
      const v = await digest(r.root, { verify: true, base });
      // Documented looseness (trust-boundary.md: trailers are provenance
      // hints): the trailer binds the sha, never the advancing commit.
      expect(v.exitCode).toBe(0);
    },
  );

  it(
    "CX-16: a trailer carrying the WRONG sha does not satisfy the attestation",
    { timeout: 30_000 },
    async () => {
      const r = initPolicyRepo({
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      const base = r.base;
      await digest(r.root, { write: true });
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "attest"]);
      writeFileSync(path.join(r.root, "hooks", "h.sh"), "#!/bin/sh\necho changed\nexit 0\n");
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "advance the frozen surface"]);
      await digest(r.root, { write: true });
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, [
        "commit",
        "-qm",
        `advance with wrong trailer\n\nX-Policy-Digest: ${"0".repeat(64)}`,
      ]);
      const v = await digest(r.root, { verify: true, base });
      expect(v.exitCode).toBe(1);
      expect((v.data?.violations ?? []).join(" ")).toContain("X-Policy-Digest");
    },
  );

  it(
    "CX-17: an untracked file matching freezeFiles changes the worktree digest (fail-closed on tree dirt)",
    { timeout: 30_000 },
    async () => {
      const r = initPolicyRepo({
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      await digest(r.root, { write: true });
      writeFileSync(path.join(r.root, "hooks", "untracked.sh"), "#!/bin/sh\nexit 0\n");
      const v = await digest(r.root, { verify: true });
      expect(v.exitCode).toBe(1);
    },
  );

  it(
    "CX-18: rename of a frozen file advances the surface — verify --base refuses without attestation",
    { timeout: 30_000 },
    async () => {
      const r = initPolicyRepo({
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      await digest(r.root, { write: true });
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "attest"]);
      const base = gitIn(r.root, ["rev-parse", "HEAD"]).trim();
      gitIn(r.root, ["mv", "hooks/h.sh", "hooks/renamed.sh"]);
      gitIn(r.root, ["commit", "-qm", "rename the frozen hook"]);
      const v = await digest(r.root, { verify: true, base });
      expect(v.exitCode).toBe(1);
    },
  );

  it("CX-19: absent/malformed policy: declarations fail closed", { timeout: 30_000 }, async () => {
    const noPolicy = initPolicyRepo({ policyBlock: false });
    const v1 = await digest(noPolicy.root, { verify: true });
    expect(v1.exitCode).toBe(1);
    const scalar = initPolicyRepo({});
    writeFileSync(
      path.join(scalar.root, "forge.yaml"),
      'schema: forge/config@1\nproject:\n  name: x\npaths: {}\npolicy: "nope"\n',
    );
    const v2 = await digest(scalar.root, { verify: true });
    expect(v2.exitCode).toBe(1);
  });

  it(
    "CX-20: --verify --base refuses when the base has no policy surface to compare",
    { timeout: 30_000 },
    async () => {
      const r = initPolicyRepo({
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      await digest(r.root, { write: true });
      gitIn(r.root, ["add", "-A"]);
      gitIn(r.root, ["commit", "-qm", "attest"]);
      const base = gitIn(r.root, ["rev-parse", "HEAD"]).trim();
      // a base ref whose forge.yaml cannot be shown (tag pointing nowhere
      // usable → gatherBaseSurface fails → fail closed).
      const v = await digest(r.root, {
        verify: true,
        base: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      });
      expect(v.exitCode).toBe(1);
      void base;
    },
  );
});

// ===========================================================================
// flow.push — verifier-trailer scan
// ===========================================================================

describe("RFC-1616 flow.push trailer scan", () => {
  async function trailerCommit(repo: string, file: string, trailerLine: string): Promise<string> {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(repo, file), "x\n");
    await gitExec(repo, ["add", file]);
    await gitExec(repo, ["commit", "-qm", `session work\n\n${trailerLine}`]);
    return (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
  }

  it(
    "CX-21: mid-range trailer commits are flagged, not just the tip",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx1-push-" });
      const sha = await trailerCommit(repo, "mid.txt", "X-Verifier-Report: r.yaml");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path.join(repo, "cover.txt"), "x\n");
      await gitExec(repo, ["add", "cover.txt"]);
      await gitExec(repo, ["commit", "-qm", "clean cover commit on top"]);
      const digest = await collectDigest(repo, ambientIo, { fetch: false });
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-08");
      expect(data.verifierTrailerCommits?.[0]?.sha).toBe(sha);
    },
  );

  it("CX-22: a trailer in a merge-commit body is flagged", { timeout: 60_000 }, async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx1-push-" });
    await gitExec(repo, ["checkout", "-qb", "side"]);
    await trailerCommit(repo, "side.txt", "X-Expectation-Origin: independent-verifier");
    await gitExec(repo, ["checkout", "-q", "develop"]);
    await gitExec(repo, [
      "merge",
      "--no-ff",
      "-m",
      "merge side\n\nX-Verifier-Report: merge-report.yaml",
      "side",
    ]);
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-08");
    expect((data.verifierTrailerCommits?.length ?? 0) >= 2).toBe(true);
  });

  it(
    "CX-23: trailer-shaped SUBJECT lines are flagged (stricter is safe)",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx1-push-" });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path.join(repo, "subj.txt"), "x\n");
      await gitExec(repo, ["add", "subj.txt"]);
      await gitExec(repo, ["commit", "-qm", "X-Verifier-Report: subject-as-trailer.yaml"]);
      const digest = await collectDigest(repo, ambientIo, { fetch: false });
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-08");
    },
  );

  it(
    "CX-24: case-variant trailers — lowercase/uppercase X- trailers grant nothing at the gate either; document scan parity (they push unflagged)",
    { timeout: 60_000 },
    async () => {
      // lowercase — git trailer semantics are case-insensitive but the gate's
      // VERIFIER_*_REs are case-sensitive too, so a lowercase trailer is not a
      // verifier claim anywhere in the system: parity, not a hole (O).
      const { repo: repoLower, origin } = await initRepoWithOrigin(dirs, {
        prefix: "cx1-push-",
      });
      const sha = await trailerCommit(repoLower, "low.txt", "x-verifier-report: r.yaml");
      let digest = await collectDigest(repoLower, ambientIo, { fetch: false });
      let data = await pushFlow(repoLower, ambientIo, {
        digest: digest.digestId,
        dryRun: false,
      });
      expect(data.pushed).toBe(true);
      expect((await gitExec(origin, ["rev-parse", "refs/heads/develop"])).stdout.trim()).toBe(sha);
      // all-caps — same parity argument.
      const { repo: repoUpper } = await initRepoWithOrigin(dirs, { prefix: "cx1-push-" });
      await trailerCommit(repoUpper, "up.txt", "X-VERIFIER-REPORT: r.yaml");
      digest = await collectDigest(repoUpper, ambientIo, { fetch: false });
      data = await pushFlow(repoUpper, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(data.pushed).toBe(true);
    },
  );

  it("CX-25: folded continuation value is still flagged", { timeout: 60_000 }, async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx1-push-" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(repo, "fold.txt"), "x\n");
    await gitExec(repo, ["add", "fold.txt"]);
    await gitExec(repo, [
      "commit",
      "-qm",
      "session work\n\nX-Verifier-Report:\n  folded-value.yaml",
    ]);
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-08");
  });

  it(
    "CX-26: unreadable/invalid forge.yaml fails CLOSED — a malformed push: block or broken YAML must not disable the scan",
    { timeout: 60_000 },
    async () => {
      // a) schema-invalid push.requireVerifierReview value → whole doc fails
      //    validation → default required.
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx1-push-" });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        path.join(repo, "forge.yaml"),
        "schema: forge/config@1\nproject:\n  name: x\npaths: {}\npush:\n  requireVerifierReview: banana\n",
      );
      await gitExec(repo, ["add", "forge.yaml"]);
      await gitExec(repo, ["commit", "-qm", "malformed opt-out"]);
      await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      let digest = await collectDigest(repo, ambientIo, { fetch: false });
      let data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-08");
      // b) unparseable YAML → loader throws → default required.
      const { repo: repo2 } = await initRepoWithOrigin(dirs, { prefix: "cx1-push-" });
      await writeFile(path.join(repo2, "forge.yaml"), "schema: [\n");
      await gitExec(repo2, ["add", "forge.yaml"]);
      await gitExec(repo2, ["commit", "-qm", "corrupt forge.yaml"]);
      await trailerCommit(repo2, "t.txt", "X-Policy-Digest: abc");
      digest = await collectDigest(repo2, ambientIo, { fetch: false });
      data = await pushFlow(repo2, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-08");
    },
  );

  it(
    "CX-27: --accept-verifier-trailers covers weakening AND verifier AND digest trailers in one flag",
    { timeout: 60_000 },
    async () => {
      const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "cx1-push-" });
      await trailerCommit(repo, "a.txt", "X-Correctness-Weakening: accepted by op");
      await trailerCommit(repo, "b.txt", "X-Policy-Digest: " + "0".repeat(64));
      await trailerCommit(repo, "c.txt", "X-Verifier-Report: r.yaml");
      const tip = (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
      const digest = await collectDigest(repo, ambientIo, { fetch: false });
      const data = await pushFlow(repo, ambientIo, {
        digest: digest.digestId,
        dryRun: false,
        acceptVerifierTrailers: "reviewed all three",
      });
      expect(data.diagnostics).toEqual([]);
      expect(data.pushed).toBe(true);
      expect(data.verifierTrailerCommits?.length).toBe(3);
      expect((await gitExec(origin, ["rev-parse", "refs/heads/develop"])).stdout.trim()).toBe(tip);
    },
  );
});

// ===========================================================================
// scaffold + config
// ===========================================================================

describe("RFC-1616 scaffold", () => {
  it(
    "CX-28: write-when-absent can be pre-empted — a session-planted inert CODEOWNERS/workflow must not silently count as adoption",
    { timeout: 30_000 },
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "cx1-scaffold-"));
      dirs.push(root);
      mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(path.join(root, ".github", "CODEOWNERS"), "# agent's own file\n");
      writeFileSync(
        path.join(root, ".github", "workflows", "forge-policy.yml"),
        "# inert workflow — no jobs\n",
      );
      const r = scaffoldTrustBoundary(root, "@operator");
      // Both boundary artifacts are skipped as "already exists": forge
      // init/upgrade now reports the trust boundary adopted while the files
      // enforce nothing.
      expect(
        r.created,
        `an inert session-planted file satisfied write-when-absent (skipped: ${r.skipped.join(", ")})`,
      ).toContain(".github/CODEOWNERS");
    },
  );

  it(
    "CX-29: CODEOWNERS.template names the AC-8 paths — and owns itself",
    { timeout: 30_000 },
    () => {
      const tpl = readFileSync(
        path.join(PKG_ROOT, "src", "scaffold", "github", "CODEOWNERS.template"),
        "utf8",
      );
      for (const owned of ["forge.yaml", ".forge/", "hooks/", ".github/workflows/"]) {
        expect(tpl).toContain(owned);
      }
      // The file that defines ownership has no owner — under GitHub
      // code-owner review a PR rewriting CODEOWNERS needs no code owner.
      expect(tpl).toMatch(/\.github\/CODEOWNERS/);
    },
  );

  it(
    "CX-30: forge-policy.template.yml invokes the three AC-7 commands",
    { timeout: 30_000 },
    () => {
      const tpl = readFileSync(
        path.join(PKG_ROOT, "src", "scaffold", "github", "forge-policy.template.yml"),
        "utf8",
      );
      expect(tpl).toContain("correctness.gate --policy-only");
      expect(tpl).toContain("pinned.validate");
      expect(tpl).toContain("policy.digest --verify");
    },
  );

  it(
    "CX-31: project.owner renders into CODEOWNERS; absent owner keeps the placeholder",
    { timeout: 30_000 },
    () => {
      expect(codeownersTemplate("@agent-team")).toContain("@agent-team");
      expect(codeownersTemplate(undefined)).toContain("@OWNER");
      const root = mkdtempSync(path.join(os.tmpdir(), "cx1-scaffold-"));
      dirs.push(root);
      const r = scaffoldTrustBoundary(root, "@agent-team");
      expect(r.created).toContain(".github/CODEOWNERS");
      expect(readFileSync(path.join(root, ".github", "CODEOWNERS"), "utf8")).toContain(
        "@agent-team",
      );
    },
  );

  it(
    "CX-32: RFC claim 'project.owner is itself a policy:-frozen key' — under the shipped default mutable:[project] an owner flip must refuse",
    { timeout: 60_000 },
    async () => {
      const r = initPolicyRepo({
        mutable: "[project]",
        extraForgeYaml: "",
        files: { "hooks/h.sh": "#!/bin/sh\nexit 0\n", ".forge/pinned.yaml": "pinned: []\n" },
      });
      // put an owner into the base project block, then flip it at HEAD.
      const fyPath = path.join(r.root, "forge.yaml");
      writeFileSync(
        fyPath,
        readFileSync(fyPath, "utf8").replace(
          "name: pd-probe",
          "name: pd-probe\n  owner: '@operator'",
        ),
      );
      gitIn(r.root, ["add", "forge.yaml"]);
      gitIn(r.root, ["commit", "-qm", "adopt owner"]);
      const base = gitIn(r.root, ["rev-parse", "HEAD"]).trim();
      writeFileSync(fyPath, readFileSync(fyPath, "utf8").replace("'@operator'", "'@agent-self'"));
      gitIn(r.root, ["add", "forge.yaml"]);
      gitIn(r.root, ["commit", "-qm", "rebind the code owner to the session's own handle"]);
      const out = await runCorrectnessGate(r.root, { base, policyOnly: true });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(
          out.result.status,
          `project.owner flip under mutable:[project] produced status '${out.result.status}' — the CODEOWNERS handle is session-editable unjudged`,
        ).toBe("fail");
      }
    },
  );
});
