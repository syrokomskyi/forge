/*
<MODULE_CONTRACT>
<purpose>
RFC-1615 acceptance probes — independent round-24 verification: the declared
policy surface (policy.mutable / policy.additive / policy.freezeFiles) judged
by correctness.gate at the integration base — policy-key, policy-decl, and
policy-file weakenings, the isolated-accept + mixed-weakening contract,
--policy-only CLI behaviour, and the forge init / forge.upgrade scaffold.
</purpose>
<non-goals>
  <item>Not a contract source of truth — gate/run.ts + gate/frozen.ts own behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1615: independent acceptance verification r24 — AC-1..AC-8 adversarial probes.</item>
  <item>RFC-1615: port RFC-1615 round-24 independent verifier probes

Port the clean-context verifier's 56-probe suite verbatim as
policy-freeze-cx25.test.ts and persist its acceptance report
(verdict: pass, isolation: subagent, candidate e532ba63a).</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { DEFAULT_FORGE_POLICY } from "../../../src/config/forge-config.ts";
import { ambientIo } from "../../../src/utils/io.ts";
import { openFlowBranch } from "../../flow/handlers/flow-open.ts";
import { integrateFlowBranch } from "../../flow/handlers/flow-integrate.ts";
import { gitExec, initRepo, installRealPrimaryForge } from "../../flow/tests/helpers.ts";
import { runCorrectnessGate } from "./run.ts";
import { makeGateFixture } from "./tests/gate-fixture.ts";
import type { CorrectnessGateResult } from "./types.ts";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bin/cli.ts");
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../package.json");
const FORGE_VERSION = String(
  (JSON.parse(readFileSync(PKG, "utf8")) as { version?: string }).version ?? "0.0.0",
);
const NOW = new Date("2026-11-17T12:00:00Z");
const VERIFIER_TRAILERS =
  "X-Expectation-Origin: independent-verifier\nX-Verifier-Report: verify-r24.yaml";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scratch repositories
// ---------------------------------------------------------------------------

const POLICY_BLOCK = `policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles:
    - "hooks/**"
    - ".github/workflows/**"
    - ".forge/pinned.yaml"
`;

const FROZEN_FILES: Record<string, string> = {
  "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
  ".forge/pinned.yaml": "files: []\n",
  ".github/workflows/ci.yml": "on: push\n",
};

/** Top-level keys that exist at base unless the probe says otherwise. */
const EXTRA_KEYS = `agentTools:
  front: [flow.digest]
  deny: [danger.cmd]
checksContribution:
  guardRules: [no-skip]
`;

interface BaseOpts {
  mode?: string;
  /** undefined → POLICY_BLOCK; null → no policy section; string → verbatim block. */
  policy?: string | null;
  /** Extra top-level YAML appended after the policy block. */
  extra?: string;
}

function baseForgeYaml(opts: BaseOpts = {}): string {
  return `schema: forge/config@1
project:
  name: policy-probe
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
    test: "node --test {file}"
    verify: "node scripts/verify.mjs"
  paths:
    compassDocs: []
correctness:
  mode: ${opts.mode ?? "warn"}
${opts.extra ?? EXTRA_KEYS}${opts.policy === undefined ? POLICY_BLOCK : (opts.policy ?? "")}`;
}

interface Scratch {
  root: string;
  base: string;
  write(rel: string, body: string): void;
  read(rel: string): string;
  git(args: string[]): string;
  commit(message: string): string;
  /** A commit carrying the RFC-1333 verifier trailer pair. */
  verifierCommit(message: string): string;
}

function scratch(forgeYaml: string, files: Record<string, string> = {}): Scratch {
  const root = mkdtempSync(path.join(os.tmpdir(), "r24-"));
  dirs.push(root);
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = (message: string) => {
    git(["add", "-A"]);
    git(["commit", "-qm", message, "--allow-empty"]);
    return git(["rev-parse", "HEAD"]);
  };
  const verifierCommit = (message: string) => {
    git(["add", "-A"]);
    git(["commit", "-qm", `${message}\n\n${VERIFIER_TRAILERS}`, "--allow-empty"]);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "-q", "-b", "develop"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  git(["config", "commit.gpgsign", "false"]);
  write("forge.yaml", forgeYaml);
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  commit("product");
  const base = git(["rev-parse", "HEAD"]);
  return {
    root,
    base,
    write,
    read: (rel) => readFileSync(path.join(root, rel), "utf8"),
    git,
    commit,
    verifierCommit,
  };
}

// ---------------------------------------------------------------------------
// Gate + CLI runners
// ---------------------------------------------------------------------------

async function gate(
  f: Scratch,
  opts: { policyOnly?: boolean; acceptWeakening?: string } = {},
): Promise<CorrectnessGateResult> {
  const out = await runCorrectnessGate(f.root, {
    base: f.base,
    bundleDir: `${f.root}/.bundles`,
    ...opts,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
}

const weakKinds = (r: CorrectnessGateResult): string[] => r.weakenings.map((w) => w.kind);
const weakSubjects = (r: CorrectnessGateResult, kind: string): string[] =>
  r.weakenings.filter((w) => w.kind === kind).map((w) => w.subject);
const gate02 = (r: CorrectnessGateResult) =>
  r.violations.filter((v) => v.rule === "CORR-GATE-02" && v.severity === "error");
const gate01 = (r: CorrectnessGateResult) =>
  r.violations.filter((v) => v.rule === "CORR-GATE-01" && v.severity === "error");

interface CliOut {
  code: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

function cli(root: string, args: string[]): CliOut {
  const env = { ...process.env };
  delete env["NODE_OPTIONS"];
  const parse = (text: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(text.trim()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      cwd: root,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 240_000,
    });
    return { code: 0, stdout, stderr: "", json: parse(stdout) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      json: parse(String(e.stdout ?? "")),
    };
  }
}

async function write(repo: string, rel: string, body: string): Promise<void> {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), body);
}

// ---------------------------------------------------------------------------
// AC-1 — a key absent from mutable/additive changes → policy-key, refuse
// ---------------------------------------------------------------------------

describe("AC-1: non-declared forge.yaml keys judge as policy-key (refuses in warn mode)", () => {
  it("AC-1: emptying agentTools.deny reports policy-key at leaf subject and fails warn", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.commit("drop a denied tool");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(gate02(r).length, JSON.stringify(r.violations)).toBeGreaterThan(0);
    expect(weakSubjects(r, "policy-key")).toContain("agentTools.deny");
  }, 30_000);

  it("AC-1: emptying checksContribution.guardRules reports policy-key", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("guardRules: [no-skip]", "guardRules: []"),
    );
    f.commit("drop a guard rule");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakSubjects(r, "policy-key")).toContain("checksContribution.guardRules");
  }, 30_000);

  it("AC-1: rebinding an existing bindings.commands.test leaf reports policy-key naming the leaf", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('test: "node --test {file}"', 'test: "true"'),
    );
    f.commit("test becomes a no-op");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakSubjects(r, "policy-key")).toContain("bindings.commands.test");
  }, 30_000);

  it("AC-1: removing an existing additive leaf (bindings.commands.verify) reports policy-key", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('    verify: "node scripts/verify.mjs"\n', ""),
    );
    f.commit("drop the verify binding");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakSubjects(r, "policy-key")).toContain("bindings.commands.verify");
  }, 30_000);

  it("AC-1: removing a whole frozen top-level key reports policy-key", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("forge.yaml", f.read("forge.yaml").replace(/agentTools:[\s\S]*?checksContribution:/, "checksContribution:"));
    f.commit("drop agentTools");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    const msgs = gate02(r).map((v) => v.message).join("\n");
    expect(msgs).toMatch(/agentTools was removed|frozen top-level key agentTools/);
  }, 30_000);

  it("AC-1: verifier trailers on the forge.yaml commit do NOT exempt a policy-key", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.verifierCommit("review: change deny");
    const r = await gate(f);
    // Trailer pairs exempt frozen FILES only — a forge.yaml key diff is judged
    // structurally and has no trailer escape hatch.
    expect(r.status).toBe("fail");
    expect(weakSubjects(r, "policy-key")).toContain("agentTools.deny");
  }, 30_000);

  it("AC-1: a semantics-preserving reformat of forge.yaml is not a weakening (negative)", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    // Same YAML semantics, different spelling: single→double quotes, block→flow.
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("deny: [danger.cmd]", 'deny: ["danger.cmd"]')
        .replace("guardRules: [no-skip]", "guardRules:\n    - no-skip"),
    );
    f.commit("reformat only");
    const r = await gate(f);
    expect(r.weakenings, JSON.stringify(r.weakenings)).toEqual([]);
    expect(r.status).toBe("pass");
  }, 30_000);

  it("AC-1: a checkRun rebind reports BOTH the frozen-binding weakening and policy-key (precedence)", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "echo {file}"'),
    );
    f.commit("rebind checkRun");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakKinds(r)).toContain("binding");
    expect(weakSubjects(r, "policy-key")).toContain("bindings.commands.checkRun");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// AC-2 — new leaves under additive keys are not weakenings
// ---------------------------------------------------------------------------

describe("AC-2: additions under additive keys are allowed", () => {
  it("AC-2: a new bindings.commands.* leaf is not a weakening and the gate passes", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace('    verify: "node scripts/verify.mjs"', '    verify: "node scripts/verify.mjs"\n    lint: "eslint src"'),
    );
    f.commit("add a lint binding");
    const r = await gate(f);
    expect(r.weakenings, JSON.stringify(r.weakenings)).toEqual([]);
    expect(gate02(r)).toEqual([]);
    expect(r.status).toBe("pass");
  }, 30_000);

  it("AC-2: new leaves under additive paths and loopMetrics are allowed", async () => {
    const f = scratch(
      baseForgeYaml({ extra: "agentTools:\n  deny: [danger.cmd]\n" }),
      FROZEN_FILES,
    );
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("paths: {}", "paths:\n  plansDir: docs/plans")
        .replace("correctness:", "loopMetrics:\n  - id: escaped-defects\ncorrectness:"),
    );
    f.commit("add paths leaf + loopMetrics key");
    const r = await gate(f);
    expect(r.weakenings, JSON.stringify(r.weakenings)).toEqual([]);
    expect(r.status).toBe("pass");
  }, 30_000);

  it("AC-2: a fresh leaf does not launder a same-key existing-leaf change", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace('test: "node --test {file}"', 'test: "true"')
        .replace('    verify: "node scripts/verify.mjs"', '    verify: "node scripts/verify.mjs"\n    lint: "eslint src"'),
    );
    f.commit("add lint AND rebind test");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakSubjects(r, "policy-key")).toContain("bindings.commands.test");
    // The genuinely-new leaf stays unreported.
    expect(gate02(r).map((v) => v.message).join("\n")).not.toMatch(/lint/);
  }, 30_000);

  it("AC-2: adding a brand-new leaf under additive bindings is allowed even at deep level", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("    compassDocs: []", "    compassDocs: []\n    reviewsDir: docs/reviews"),
    );
    f.commit("add reviewsDir binding path");
    const r = await gate(f);
    expect(r.weakenings, JSON.stringify(r.weakenings)).toEqual([]);
    expect(r.status).toBe("pass");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// AC-3 — policy: is self-frozen (policy-decl)
// ---------------------------------------------------------------------------

describe("AC-3: edits to the policy: section report policy-decl", () => {
  it("AC-3: shrinking mutable reports policy-decl", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("mutable: [project, forge, moves]", "mutable: [project, forge]"),
    );
    f.commit("shrink mutable");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakKinds(r)).toContain("policy-decl");
  }, 30_000);

  it("AC-3: growing additive reports policy-decl", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("additive: [bindings, paths, loopMetrics]", "additive: [bindings, paths, loopMetrics, agentTools]"),
    );
    f.commit("grow additive");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakKinds(r)).toContain("policy-decl");
  }, 30_000);

  it("AC-3: dropping a freezeFiles glob reports policy-decl — and the file's own edit adds policy-file", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    // Drop the glob AND change the file it covered — the base glob still judges.
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('    - ".forge/pinned.yaml"\n', ""),
    );
    f.write(".forge/pinned.yaml", "files: [smuggled]\n");
    f.commit("drop the pinned glob and edit the file");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakKinds(r)).toContain("policy-decl");
    expect(weakSubjects(r, "policy-file")).toContain(".forge/pinned.yaml");
  }, 30_000);

  it("AC-3: removing the whole policy: section reports policy-decl", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("forge.yaml", f.read("forge.yaml").replace(POLICY_BLOCK, ""));
    f.commit("remove policy");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakKinds(r)).toContain("policy-decl");
  }, 30_000);

  it("AC-3: a list reorder inside policy: is a policy-decl (any semantic diff is frozen)", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("mutable: [project, forge, moves]", "mutable: [forge, project, moves]"),
    );
    f.commit("reorder mutable");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakKinds(r)).toContain("policy-decl");
  }, 30_000);

  it("AC-3: declaring `policy` inside mutable does not exempt policy-decl", async () => {
    const f = scratch(
      baseForgeYaml({
        policy: `policy:
  mutable: [project, forge, moves, policy]
  additive: [bindings, paths, loopMetrics]
  freezeFiles: ["hooks/**"]
`,
      }),
      FROZEN_FILES,
    );
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("moves, policy]", "moves]"),
    );
    f.commit("shrink mutable via self-declared mutable policy");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakKinds(r)).toContain("policy-decl");
  }, 30_000);

  it("AC-3: adopting policy: at HEAD over a policy-less base is exempt — not a weakening (documented opt-in)", async () => {
    const f = scratch(baseForgeYaml({ policy: null }), FROZEN_FILES);
    f.write("forge.yaml", `${f.read("forge.yaml")}${POLICY_BLOCK}`);
    f.commit("adopt policy surface");
    const r = await gate(f);
    expect(
      weakKinds(r).includes("policy-decl"),
      JSON.stringify(r.weakenings),
    ).toBe(false);
    expect(
      r.violations.some((v) => /no policy surface declared/.test(v.message)),
      "the inert-note discloses that the adopted policy binds only the next integration",
    ).toBe(true);
    expect(r.status).toBe("pass");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// AC-4 — freezeFiles are byte-frozen (policy-file)
// ---------------------------------------------------------------------------

describe("AC-4: freezeFiles byte changes, deletions, and additions judge as policy-file", () => {
  it("AC-4: byte-changing hooks/integration-gate.sh reports policy-file and refuses", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n# weakened\n");
    f.commit("weaken the integration gate");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(gate02(r).length).toBeGreaterThan(0);
    expect(weakSubjects(r, "policy-file")).toContain("hooks/integration-gate.sh");
  }, 30_000);

  it("AC-4: deleting .forge/pinned.yaml reports policy-file deleted", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.git(["rm", "-q", ".forge/pinned.yaml"]);
    f.commit("delete pinned");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    const msgs = gate02(r).map((v) => v.message).join("\n");
    expect(msgs).toMatch(/policy-file.*\.forge\/pinned\.yaml.*deleted|deleted.*\.forge\/pinned\.yaml/);
  }, 30_000);

  it("AC-4: a new file matching hooks/** reports a policy-file addition", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("hooks/pre-push.sh", "#!/bin/sh\nexit 0\n");
    f.commit("plant a new hook");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakSubjects(r, "policy-file")).toContain("hooks/pre-push.sh");
  }, 30_000);

  it("AC-4: a new file under .github/workflows/ reports a policy-file addition", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write(".github/workflows/deploy.yml", "on: push\n");
    f.commit("plant a workflow");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakSubjects(r, "policy-file")).toContain(".github/workflows/deploy.yml");
  }, 30_000);

  it("AC-4: a deeply nested file under hooks/** reports a policy-file addition", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("hooks/nested/deep.sh", "#!/bin/sh\nexit 0\n");
    f.commit("plant a nested hook");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakSubjects(r, "policy-file")).toContain("hooks/nested/deep.sh");
  }, 30_000);

  it("AC-4: lookalike paths outside the globs are not flagged", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("hooks.txt", "not a hook\n");
    f.write("xhooks/evil.sh", "#!/bin/sh\nexit 0\n");
    f.write(".forge/pinned.yaml.bak", "backup\n");
    f.commit("lookalikes");
    const r = await gate(f);
    expect(weakSubjects(r, "policy-file"), JSON.stringify(r.weakenings)).toEqual([]);
    expect(r.status).toBe("pass");
  }, 30_000);

  it("AC-4: a verifier-trailer commit editing a frozen file is exempt", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n# reviewed change\n");
    f.verifierCommit("review: hook change");
    const r = await gate(f);
    expect(weakSubjects(r, "policy-file"), JSON.stringify(r.weakenings)).toEqual([]);
    expect(r.status).toBe("pass");
  }, 30_000);

  it("AC-4: a verifier-trailer commit adding a glob-matched file is exempt", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("hooks/reviewed.sh", "#!/bin/sh\nexit 0\n");
    f.verifierCommit("review: new hook");
    const r = await gate(f);
    expect(weakSubjects(r, "policy-file")).toEqual([]);
    expect(r.status).toBe("pass");
  }, 30_000);

  it("AC-4: last-touch ordering — verifier commit then plain edit is refused", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n# v1\n");
    f.verifierCommit("review: hook v1");
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n# v2 unreviewed\n");
    f.commit("plain edit after the verifier commit");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakSubjects(r, "policy-file")).toContain("hooks/integration-gate.sh");
  }, 30_000);

  it("AC-4: last-touch ordering — plain edit then a verifier commit on the same file ends exempt", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n# sneaky\n");
    f.commit("unreviewed edit");
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n# sneaky (now reviewed)\n");
    f.verifierCommit("review: certify end state");
    const r = await gate(f);
    // The verifier pair certifies the end state — the earlier plain edit is
    // covered by the last-touch rule (the documented trailer contract).
    expect(weakSubjects(r, "policy-file"), JSON.stringify(r.weakenings)).toEqual([]);
  }, 30_000);

  it("AC-4: a chmod-only mode flip on a frozen file reports a weakening", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.git(["update-index", "--chmod=+x", "hooks/integration-gate.sh"]);
    // Index-only commit — `git add -A` would re-stage the worktree mode (the
    // filesystem chmod was never applied) and silently revert the flip.
    f.git(["commit", "-qm", "chmod +x the frozen hook"]);
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(
      r.weakenings.some((w) => w.subject === "hooks/integration-gate.sh"),
      JSON.stringify(r.weakenings),
    ).toBe(true);
  }, 30_000);

  it("AC-4: renaming a frozen file reports the delete and the addition", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.git(["mv", "hooks/integration-gate.sh", "hooks/renamed.sh"]);
    f.commit("rename the hook");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    const subs = weakSubjects(r, "policy-file");
    expect(subs).toContain("hooks/integration-gate.sh");
    expect(subs).toContain("hooks/renamed.sh");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// AC-5 — brand-new top-level keys are policy-key weakenings
// ---------------------------------------------------------------------------

describe("AC-5: new top-level keys are policy-key weakenings", () => {
  it("AC-5: a brand-new undeclared top-level key reports policy-key", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("forge.yaml", `${f.read("forge.yaml")}rogue:\n  payload: true\n`);
    f.commit("add a rogue key");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakSubjects(r, "policy-key")).toContain("rogue");
    expect(gate02(r).map((v) => v.message).join("\n")).toMatch(/new top-level key rogue/);
  }, 30_000);

  it("AC-5: adding agentTools entirely (absent at base) reports policy-key", async () => {
    const f = scratch(
      baseForgeYaml({ extra: "checksContribution:\n  guardRules: [no-skip]\n" }),
      FROZEN_FILES,
    );
    f.write("forge.yaml", `${f.read("forge.yaml")}agentTools:\n  deny: []\n`);
    f.commit("plant agentTools");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakSubjects(r, "policy-key")).toContain("agentTools");
  }, 30_000);

  it("AC-5: a mutable-declared key added fresh is allowed", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("forge.yaml", `${f.read("forge.yaml")}moves:\n  metric: escaped-defects\n`);
    f.commit("add moves (mutable)");
    const r = await gate(f);
    expect(r.weakenings, JSON.stringify(r.weakenings)).toEqual([]);
    expect(r.status).toBe("pass");
  }, 30_000);

  it("AC-5: an additive-declared key added fresh is allowed", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("forge.yaml", `${f.read("forge.yaml")}loopMetrics:\n  - id: m1\n`);
    f.commit("add loopMetrics (additive)");
    const r = await gate(f);
    expect(r.weakenings, JSON.stringify(r.weakenings)).toEqual([]);
    expect(r.status).toBe("pass");
  }, 30_000);

  it("AC-5: a case-variant of a declared key is a different (new) key", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("forge.yaml", `${f.read("forge.yaml")}AgentTools:\n  deny: []\n`);
    f.commit("add AgentTools");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakSubjects(r, "policy-key")).toContain("AgentTools");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// AC-6 — isolated weakening sessions accept; mixed diffs refuse
// ---------------------------------------------------------------------------

describe("AC-6: isolated weakening session accepts; mixed refuses", () => {
  it("AC-6: a frozen-path-only weakening + --accept-weakening proceeds with all weakenings accepted", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n# operator-approved change\n");
    f.commit("weaken the hook");
    const r = await gate(f, { acceptWeakening: "operator: gate hook reworked" });
    expect(r.acceptedWeakening).toBe("operator: gate hook reworked");
    expect(gate02(r), JSON.stringify(r.violations)).toEqual([]);
    expect(r.weakenings.every((w) => w.accepted)).toBe(true);
    expect(r.status).toBe("pass");
  }, 30_000);

  it("AC-6: a forge.yaml-only weakening is isolated and acceptable", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.commit("change a frozen key");
    const r = await gate(f, { acceptWeakening: "operator: deny list re-tuned" });
    expect(r.acceptedWeakening).toBe("operator: deny list re-tuned");
    expect(r.weakenings.every((w) => w.accepted)).toBe(true);
    expect(r.status).toBe("pass");
  }, 30_000);

  it("AC-6: weakening + foreign path refuses as mixed-weakening naming the file", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n# weakened\n");
    f.write("src/payload.ts", "export const x = 1;\n");
    f.commit("weaken + smuggle");
    const r = await gate(f, { acceptWeakening: "operator: gate hook reworked" });
    expect(r.acceptedWeakening).toBeNull();
    const msgs = gate02(r).map((v) => v.message).join("\n");
    expect(msgs).toMatch(/mixed-weakening/);
    expect(msgs).toMatch(/src\/payload\.ts/);
    expect(r.status).toBe("fail");
  }, 30_000);

  it("AC-6: weakening touching several frozen paths is still isolated", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n# v2\n");
    f.write(".forge/pinned.yaml", "files: [new]\n");
    f.write("hooks/extra.sh", "#!/bin/sh\nexit 0\n");
    f.commit("several frozen paths");
    const r = await gate(f, { acceptWeakening: "operator: multi-file rework" });
    expect(r.acceptedWeakening).toBe("operator: multi-file rework");
    expect(r.weakenings.length).toBeGreaterThanOrEqual(3);
    expect(r.weakenings.every((w) => w.accepted)).toBe(true);
    expect(r.status).toBe("pass");
  }, 30_000);

  it("AC-6: flow.integrate refuses a policy-file weakening, then lands it with the X-Correctness-Weakening trailer", async () => {
    const repo = await initRepo({ prefix: "r24-flow-" });
    dirs.push(repo);
    await write(
      repo,
      "forge.yaml",
      `schema: forge/config@1\nproject:\n  name: flowprobe\npaths: {}\nagentTools:\n  deny: [danger.cmd]\npolicy:\n  mutable: [project, forge, moves]\n  additive: [bindings, paths, loopMetrics]\n  freezeFiles: ["hooks/**", ".forge/pinned.yaml"]\n`,
    );
    await write(repo, "hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n");
    await write(repo, ".forge/pinned.yaml", "files: []\n");
    await gitExec(repo, ["add", "-A"]);
    await gitExec(repo, ["commit", "-m", "product with policy"]);
    await gitExec(repo, ["branch", "develop", "HEAD"]);
    await gitExec(repo, ["switch", "develop"]);
    await installRealPrimaryForge(repo, CLI);
    const opened = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "weak",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    expect(opened.diagnostics, JSON.stringify(opened.diagnostics)).toEqual([]);
    const wt = opened.worktree!;
    dirs.push(wt);
    await write(wt, "hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n# weakened\n");
    await gitExec(wt, ["add", "-A"]);
    await gitExec(wt, ["commit", "-m", "weaken the hook"]);
    const refused = await integrateFlowBranch(repo, ambientIo, {
      branch: opened.branch!,
      dryRun: false,
      now: NOW,
    });
    expect(refused.integrated).toBe(false);
    const refusal = refused.diagnostics.find((d) => d.ruleId === "FLOW-INT-18");
    expect(refusal?.message, JSON.stringify(refused.diagnostics)).toMatch(/CORR-GATE-02/);
    const accepted = await integrateFlowBranch(repo, ambientIo, {
      branch: opened.branch!,
      dryRun: false,
      now: NOW,
      acceptWeakening: "operator: hook rework approved",
    });
    expect(
      accepted.diagnostics.filter((d) => d.severity === "error"),
      JSON.stringify(accepted.diagnostics),
    ).toEqual([]);
    expect(accepted.integrated).toBe(true);
    const log = await gitExec(repo, ["log", "-1", "--format=%B", "develop"]);
    expect(log.stdout).toMatch(/X-Correctness-Weakening: operator: hook rework approved/);
  }, 300_000);

  it("AC-6: flow.integrate with --accept-weakening refuses a mixed weakening + foreign diff", async () => {
    const repo = await initRepo({ prefix: "r24-flow-mix-" });
    dirs.push(repo);
    await write(
      repo,
      "forge.yaml",
      `schema: forge/config@1\nproject:\n  name: flowmix\npaths: {}\npolicy:\n  mutable: [project, forge, moves]\n  additive: [bindings, paths, loopMetrics]\n  freezeFiles: ["hooks/**"]\n`,
    );
    await write(repo, "hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n");
    await gitExec(repo, ["add", "-A"]);
    await gitExec(repo, ["commit", "-m", "product with policy"]);
    await gitExec(repo, ["branch", "develop", "HEAD"]);
    await gitExec(repo, ["switch", "develop"]);
    await installRealPrimaryForge(repo, CLI);
    const opened = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "mixed",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    expect(opened.diagnostics, JSON.stringify(opened.diagnostics)).toEqual([]);
    const wt = opened.worktree!;
    dirs.push(wt);
    await write(wt, "hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n# weakened\n");
    await write(wt, "notes.txt", "unrelated\n");
    await gitExec(wt, ["add", "-A"]);
    await gitExec(wt, ["commit", "-m", "weaken + foreign"]);
    const refused = await integrateFlowBranch(repo, ambientIo, {
      branch: opened.branch!,
      dryRun: false,
      now: NOW,
      acceptWeakening: "operator: still mixed",
    });
    expect(refused.integrated).toBe(false);
    const refusal = refused.diagnostics.find((d) => d.ruleId === "FLOW-INT-18");
    expect(refusal?.message, JSON.stringify(refused.diagnostics)).toMatch(/mixed-weakening/);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// AC-7 — --policy-only on the real CLI
// ---------------------------------------------------------------------------

describe("AC-7: correctness.gate --policy-only on the real CLI", () => {
  it("AC-7: a repo without policy: exits 0 with the 'no policy surface declared' note", () => {
    const f = scratch(baseForgeYaml({ policy: null }));
    f.commit("empty session diff");
    const out = cli(f.root, ["correctness.gate", "--base", f.base, "--policy-only", "--json"]);
    expect(out.code, out.stderr).toBe(0);
    const data = out.json as {
      status?: string;
      violations?: { severity: string; message: string }[];
    } | null;
    expect(data?.status).toBe("pass");
    expect(
      (data?.violations ?? []).some((v) => /no policy surface declared/.test(v.message)),
      JSON.stringify(data?.violations),
    ).toBe(true);
  }, 120_000);

  it("AC-7: malformed policy: variants refuse with CORR-GATE-01", () => {
    for (const [label, block] of [
      ["scalar", 'policy: "not-a-map"\n'],
      ["bare null", "policy:\n"],
      ["negation glob", 'policy:\n  freezeFiles: ["!hooks/**"]\n'],
      ["non-string list member", "policy:\n  mutable: [1]\n"],
      ["string not list", 'policy:\n  mutable: "hooks"\n'],
    ] as const) {
      const f = scratch(baseForgeYaml({ policy: block }), FROZEN_FILES);
      f.commit("empty diff");
      const out = cli(f.root, ["correctness.gate", "--base", f.base, "--policy-only", "--json"]);
      const data = out.json as {
        status?: string;
        violations?: { rule: string; severity: string; message: string }[];
      } | null;
      expect(data?.status, `${label}: ${out.stderr}`).toBe("fail");
      expect(
        (data?.violations ?? []).some(
          (v) => v.rule === "CORR-GATE-01" && v.severity === "error" && /policy/.test(v.message),
        ),
        `${label}: ${JSON.stringify(data?.violations)}`,
      ).toBe(true);
    }
  }, 240_000);

  it("AC-7: a HEAD-adopted malformed policy refuses CORR-GATE-01", () => {
    const f = scratch(baseForgeYaml({ policy: null }), FROZEN_FILES);
    f.write("forge.yaml", `${f.read("forge.yaml")}policy: "not-a-map"\n`);
    f.commit("adopt malformed policy");
    const out = cli(f.root, ["correctness.gate", "--base", f.base, "--policy-only", "--json"]);
    const data = out.json as {
      status?: string;
      violations?: { rule: string; severity: string }[];
    } | null;
    expect(data?.status, out.stderr).toBe("fail");
    expect(
      (data?.violations ?? []).some((v) => v.rule === "CORR-GATE-01" && v.severity === "error"),
      JSON.stringify(data?.violations),
    ).toBe(true);
  }, 120_000);

  it("AC-7: --policy-only refuses a policy-key weakening and exits non-zero", () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.commit("frozen key change");
    const out = cli(f.root, ["correctness.gate", "--base", f.base, "--policy-only", "--json"]);
    expect(out.code, out.stderr).toBe(1);
    const data = out.json as {
      status?: string;
      weakenings?: { kind: string; subject: string }[];
    } | null;
    expect(data?.status).toBe("fail");
    expect((data?.weakenings ?? []).some((w) => w.kind === "policy-key")).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// AC-8 — forge.init / forge.upgrade scaffold the default policy: block
// ---------------------------------------------------------------------------

describe("AC-8: init/upgrade scaffold the default policy block", () => {
  it("AC-8: forge.init writes forge.yaml with the default policy block", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "r24-init-"));
    dirs.push(root);
    const out = cli(root, ["forge.init"]);
    expect(out.code, `${out.stdout}\n${out.stderr}`).toBe(0);
    const doc = parseYaml(readFileSync(path.join(root, "forge.yaml"), "utf8")) as {
      policy?: unknown;
    };
    expect(doc.policy).toEqual({
      mutable: [...DEFAULT_FORGE_POLICY.mutable],
      additive: [...DEFAULT_FORGE_POLICY.additive],
      freezeFiles: [...DEFAULT_FORGE_POLICY.freezeFiles],
    });
    expect(DEFAULT_FORGE_POLICY.mutable.length).toBeGreaterThan(0);
    expect(DEFAULT_FORGE_POLICY.additive.length).toBeGreaterThan(0);
    expect(DEFAULT_FORGE_POLICY.freezeFiles.length).toBeGreaterThan(0);
  }, 240_000);

  it("AC-8: forge.upgrade scaffolds policy: when absent", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "r24-upgrade-"));
    dirs.push(root);
    writeFileSync(
      path.join(root, "forge.yaml"),
      `schema: forge/config@1\nproject:\n  name: upgrade-probe\npaths: {}\nforge:\n  syncedVersion: "${FORGE_VERSION}"\n`,
    );
    const out = cli(root, ["forge.upgrade"]);
    expect(out.code, `${out.stdout}\n${out.stderr}`).toBe(0);
    const doc = parseYaml(readFileSync(path.join(root, "forge.yaml"), "utf8")) as {
      policy?: { mutable?: string[]; additive?: string[]; freezeFiles?: string[] };
    };
    expect(doc.policy?.mutable).toEqual([...DEFAULT_FORGE_POLICY.mutable]);
    expect(doc.policy?.additive).toEqual([...DEFAULT_FORGE_POLICY.additive]);
    expect(doc.policy?.freezeFiles).toEqual([...DEFAULT_FORGE_POLICY.freezeFiles]);
  }, 240_000);

  it("AC-8: forge.upgrade never rewrites a well-formed tuned policy block", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "r24-upgrade-tuned-"));
    dirs.push(root);
    const tuned = `schema: forge/config@1\nproject:\n  name: tuned-probe\npaths: {}\nforge:\n  syncedVersion: "${FORGE_VERSION}"\npolicy:\n  mutable: [project]\n  additive: []\n  freezeFiles: [".custom/**"]\n`;
    writeFileSync(path.join(root, "forge.yaml"), tuned);
    const out = cli(root, ["forge.upgrade"]);
    expect(out.code, `${out.stdout}\n${out.stderr}`).toBe(0);
    const doc = parseYaml(readFileSync(path.join(root, "forge.yaml"), "utf8")) as {
      policy?: { mutable?: string[]; additive?: string[]; freezeFiles?: string[] };
    };
    expect(doc.policy).toEqual({
      mutable: ["project"],
      additive: [],
      freezeFiles: [".custom/**"],
    });
  }, 240_000);
});

// ---------------------------------------------------------------------------
// Adversarial extras — fail-closed probes beyond the AC letter
// ---------------------------------------------------------------------------

describe("adversarial extras", () => {
  it("an exempt contour still judges the policy surface (exempt does not launder policy-key)", async () => {
    const f = scratch(baseForgeYaml({ mode: "exempt" }), FROZEN_FILES);
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.commit("frozen key change under exempt");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakSubjects(r, "policy-key")).toContain("agentTools.deny");
  }, 30_000);

  it("a policy: {} declaration is deny-by-default — even a project.name change refuses", async () => {
    const f = scratch(baseForgeYaml({ policy: "policy: {}\n" }), FROZEN_FILES);
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("name: policy-probe", "name: renamed"),
    );
    f.commit("rename project under empty policy");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakKinds(r)).toContain("policy-key");
  }, 30_000);

  it("mutable-declared `correctness` does not exempt the mode weakening (frozen subkeys win)", async () => {
    const f = makeGateFixture({
      mode: "enforce",
      forgeYamlAppend: `policy:\n  mutable: [project, forge, moves, correctness]\n  additive: [bindings, paths, loopMetrics]\n  freezeFiles: []\n`,
    });
    dirs.push(f.root);
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: enforce", "mode: warn"));
    f.commit("drop enforce");
    const out = await runCorrectnessGate(f.root, {
      base: f.base,
      bundleDir: `${f.root}/.bundles`,
    });
    if (!out.ok) throw new Error(out.usageError);
    expect(out.result.status).toBe("fail");
    expect(weakKinds(out.result)).toContain("mode");
  }, 60_000);

  it("additive `paths` does not launder a planted paths.rfcsDir (binding weakening wins)", async () => {
    const f = makeGateFixture({
      forgeYamlAppend: `policy:\n  mutable: [project, forge, moves]\n  additive: [bindings, paths, loopMetrics]\n  freezeFiles: []\n`,
    });
    dirs.push(f.root);
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("paths: {}", "paths:\n  rfcsDir: docs/planted"),
    );
    f.commit("plant rfcsDir");
    const out = await runCorrectnessGate(f.root, {
      base: f.base,
      bundleDir: `${f.root}/.bundles`,
    });
    if (!out.ok) throw new Error(out.usageError);
    expect(out.result.status).toBe("fail");
    expect(weakKinds(out.result)).toContain("binding");
    expect(
      weakSubjects(out.result, "policy-key"),
      "the additive leaf is policy-allowed — the binding check owns the refusal",
    ).not.toContain("paths.rfcsDir");
  }, 60_000);

  it("deleting forge.yaml at HEAD refuses via policy-key + policy-decl (fail closed)", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.git(["rm", "-q", "forge.yaml"]);
    f.commit("delete forge.yaml");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(weakKinds(r)).toContain("policy-decl");
    expect(weakKinds(r)).toContain("policy-key");
  }, 30_000);

  it("forge.yaml replaced by a scalar at HEAD refuses CORR-GATE-01 (unreadable)", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write("forge.yaml", "just a string\n");
    f.commit("forge.yaml scalar");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(gate01(r).length, JSON.stringify(r.violations)).toBeGreaterThan(0);
  }, 30_000);

  it("a weakening plus a mutable-key change still refuses as mixed-weakening (conservative isolation)", async () => {
    const f = scratch(baseForgeYaml(), FROZEN_FILES);
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("deny: [danger.cmd]", "deny: []")
        .replace("name: policy-probe", "name: renamed"),
    );
    f.commit("frozen + mutable change");
    const r = await gate(f, { acceptWeakening: "operator: deny re-tuned" });
    expect(r.acceptedWeakening).toBeNull();
    expect(gate02(r).map((v) => v.message).join("\n")).toMatch(/mixed-weakening/);
  }, 30_000);
});
