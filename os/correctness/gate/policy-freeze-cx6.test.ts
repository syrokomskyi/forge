/*
RFC-1615 acceptance verification — ROUND 5 (independent adversarial verifier).

Re-verifies the claimed round-5 fixes and hunts new attacks:

 CX-27  accept path threw TypeError on BigInt leaves (intAsBigInt +
        JSON.parse(JSON.stringify)) — now structuredClone.
 CX-28  YAML alias cycle crashed the same serialization — structuredClone
        preserves cycles, canon() has its own guard.
 CX-29  exempt×exempt early return skipped the entire weakening diff — a
        declared policy on an exempt contour now gets policy-kind judgements.

New probes (potential CX-30+):
 - HEAD-adopted MALFORMED policy on an exempt repo (base has none) —
   early "exempt" return pre-dates the malformed check at run.ts:327.
 - worktree/commit MODE desync — validation.status is worktree-flavored
   (readCorrectnessSettings) while the judged sides are commits; an
   uncommitted `mode: exempt` masks committed weakenings.
 - policy-file judgement on the exempt+policy contour (trailer pair rules).
 - --policy-only × exempt interplay, BigInt under additive, alias cycles in
   additive keys, freezeFiles:["forge.yaml"], strip-path edge values.
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { policyWeakenings, sideFrom, type FrozenSet } from "./frozen.ts";
import { runCorrectnessGate } from "./run.ts";
import { makeGateFixture, verifierCommit, type GateFixture } from "./tests/gate-fixture.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POLICY_APPEND = `agentTools:
  deny: [danger.cmd]
loopMetrics: []
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles:
    - "hooks/**"
    - ".forge/pinned.yaml"
`;

const POLICY_FILES = {
  "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
  ".forge/pinned.yaml": "pinned:\n  - path: forge.yaml\n    rule: protect\n",
};

const fixtures: GateFixture[] = [];
const tmpdirs: string[] = [];
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.cleanup());
  tmpdirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const fx = (opts: Parameters<typeof makeGateFixture>[0]) => {
  const f = makeGateFixture(opts);
  fixtures.push(f);
  return f;
};

const gate = async (
  f: GateFixture,
  opts: { policyOnly?: boolean; acceptWeakening?: string; base?: string } = {},
) => {
  const out = await runCorrectnessGate(f.root, {
    base: opts.base ?? f.base,
    bundleDir: `${f.root}/.bundles`,
    ...opts,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out;
};

interface MiniRepo {
  root: string;
  write(rel: string, body: string): void;
  read(rel: string): string;
  git(args: string[]): string;
  commit(message: string): string;
}

/** Bare git repo for exempt-contour probes (makeGateFixture always binds a manifest). */
function makeMiniRepo(
  forgeYaml: string,
  extraFiles: Record<string, string> = {},
): MiniRepo & { base: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "forge-gate-exempt-"));
  tmpdirs.push(root);
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = (message: string) => {
    git(["add", "-A"]);
    git(["commit", "-qm", message, "--allow-empty"]);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "-q", "-b", "develop"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  write("forge.yaml", forgeYaml);
  for (const [rel, body] of Object.entries(extraFiles)) write(rel, body);
  commit("base");
  const base = git(["rev-parse", "HEAD"]);
  return {
    root,
    base,
    write,
    read: (rel) => readFileSync(path.join(root, rel), "utf8"),
    git,
    commit,
  };
}

const EXEMPT_YAML = `schema: forge/config@1
project:
  name: probe
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
  paths: {}
correctness:
  mode: exempt
`;

const EXEMPT_POLICY_YAML = `schema: forge/config@1
project:
  name: probe
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
  paths: {}
agentTools:
  deny: [danger.cmd]
correctness:
  mode: exempt
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths]
  freezeFiles:
    - "hooks/**"
`;

const miniGate = async (
  r: MiniRepo,
  base: string,
  opts: { policyOnly?: boolean; acceptWeakening?: string } = {},
) => {
  const out = await runCorrectnessGate(r.root, {
    base,
    bundleDir: `${r.root}/.bundles`,
    ...opts,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out;
};

// ===========================================================================
// CX-27 re-verify: BigInt (intAsBigInt) leaves through the accept-path strip.
// The old JSON.parse(JSON.stringify(doc)) threw TypeError on ANY int leaf.
// ===========================================================================

describe("CX-27 re-verify: BigInt leaves + --accept-weakening (no TypeError)", () => {
  it("isolated weakening session with a >2^53 int leaf accepts", async () => {
    const f = fx({
      forgeYamlAppend: `limits:\n  cap: 9007199254740993\n${POLICY_APPEND}`,
      extraFiles: POLICY_FILES,
    });
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.commit("weaken frozen key");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved");
  });

  it("BigInt leaf + weakening + FOREIGN file still mixed-weakening", async () => {
    const f = fx({
      forgeYamlAppend: `limits:\n  cap: 9007199254740993\n${POLICY_APPEND}`,
      extraFiles: POLICY_FILES,
    });
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.write("src/foreign.ts", "export const x = 1;\n");
    f.commit("weaken + foreign");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    expect(result.status).toBe("fail");
    expect(result.acceptedWeakening).toBeNull();
    expect(
      result.violations.some((v) => /mixed-weakening/.test(v.message)),
      JSON.stringify(result.violations),
    ).toBe(true);
  });

  it("equal int leaves on both sides stay isolated (canon identical)", async () => {
    const f = fx({
      forgeYamlAppend: `limits:\n  cap: 5\n  big: 9007199254740993\n${POLICY_APPEND}`,
      extraFiles: POLICY_FILES,
    });
    // Only a policy-file weakening — forge.yaml untouched.
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 1\n");
    f.commit("touch hook");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved");
  });
});

// ===========================================================================
// CX-28 re-verify: YAML alias cycles through the accept path and the diff.
// ===========================================================================

describe("CX-28 re-verify: alias cycles — no crash, judgement still works", () => {
  const CYCLE_APPEND = `agentTools:
  deny: [danger.cmd]
cycleKey: &cy
  loop: *cy
  tag: same
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles:
    - "hooks/**"
`;

  it("cyclic value under a MUTABLE-declared-adjacent frozen key, unchanged → gate runs clean", async () => {
    const f = fx({ forgeYamlAppend: CYCLE_APPEND, extraFiles: POLICY_FILES });
    f.commit("noop");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.status).toBe("pass");
    expect(result.weakenings).toEqual([]);
  });

  it("cyclic forge.yaml + weakening + --accept-weakening — no RangeError/TypeError", async () => {
    const f = fx({ forgeYamlAppend: CYCLE_APPEND, extraFiles: POLICY_FILES });
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.commit("weaken frozen key");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved");
  });

  it("cycle content changed inside the cyclic key → policy-key, not a crash", async () => {
    const f = fx({ forgeYamlAppend: CYCLE_APPEND, extraFiles: POLICY_FILES });
    f.write("forge.yaml", f.read("forge.yaml").replace("  tag: same", "  tag: different"));
    f.commit("mutate cycle leaf");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("cycle inside the policy: declaration itself — policy-decl judges without crash", async () => {
    const f = fx({ forgeYamlAppend: CYCLE_APPEND, extraFiles: POLICY_FILES });
    // Amend the policy block (self-frozen) — diff contains no cycle but the
    // doc does; both strip and policy-decl must survive.
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("mutable: [project, forge, moves]", "mutable: [project]"),
    );
    f.commit("shrink mutable");
    const { result } = await gate(f, { policyOnly: true });
    expect(result.weakenings.some((w) => w.kind === "policy-decl")).toBe(true);
  });
});

// ===========================================================================
// CX-29 re-verify: exempt×exempt contour + declared policy.
// ===========================================================================

describe("CX-29 re-verify: exempt×exempt + declared policy judges the policy surface", () => {
  it("exempt base+HEAD + committed frozen-key weakening → policy-key CORR-GATE-02, fail", async () => {
    const r = makeMiniRepo(EXEMPT_POLICY_YAML, {
      "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
    });
    r.write(
      "forge.yaml",
      (r.read("forge.yaml") as string).replace("deny: [danger.cmd]", "deny: []"),
    );
    r.commit("weaken frozen key");
    const out = await miniGate(r, r.base);
    expect(out.result.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
    expect(
      out.result.violations.some((v) => v.rule === "CORR-GATE-02" && v.severity === "error"),
    ).toBe(true);
    expect(out.result.status).toBe("fail");
  });

  it("exempt+policy: an isolated weakening session accepts via --accept-weakening", async () => {
    const r = makeMiniRepo(EXEMPT_POLICY_YAML, {
      "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
    });
    r.write(
      "forge.yaml",
      (r.read("forge.yaml") as string).replace("deny: [danger.cmd]", "deny: []"),
    );
    r.commit("weaken frozen key");
    const out = await miniGate(r, r.base, { acceptWeakening: "operator approved" });
    expect(out.result.status).toBe("pass");
    expect(out.result.acceptedWeakening).toBe("operator approved");
    expect(out.result.weakenings.every((w) => w.accepted)).toBe(true);
  });

  it("exempt+policy: policy-file weakening (no trailers) → policy-file fail", async () => {
    const r = makeMiniRepo(EXEMPT_POLICY_YAML, {
      "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
    });
    r.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 9\n");
    r.commit("weaken hook without trailers");
    const out = await miniGate(r, r.base);
    expect(out.result.weakenings.some((w) => w.kind === "policy-file")).toBe(true);
    expect(out.result.status).toBe("fail");
  });

  it("exempt+policy: policy-file DELETION without trailers → policy-file fail", async () => {
    const r = makeMiniRepo(EXEMPT_POLICY_YAML, {
      "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
    });
    r.git(["rm", "-q", "hooks/integration-gate.sh"]);
    r.commit("delete hook without trailers");
    const out = await miniGate(r, r.base);
    expect(out.result.weakenings.some((w) => w.kind === "policy-file")).toBe(true);
    expect(out.result.status).toBe("fail");
  });

  it("exempt+policy: NEW file matching freezeFiles glob → policy-file fail", async () => {
    const r = makeMiniRepo(EXEMPT_POLICY_YAML, {
      "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
    });
    r.write("hooks/new-hook.sh", "#!/bin/sh\nexit 0\n");
    r.commit("add hook without trailers");
    const out = await miniGate(r, r.base);
    expect(out.result.weakenings.some((w) => w.kind === "policy-file")).toBe(true);
    expect(out.result.status).toBe("fail");
  });

  it("exempt+policy: verifier-trailer commit may change a frozen file", async () => {
    const r = makeMiniRepo(EXEMPT_POLICY_YAML, {
      "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
    });
    r.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 7\n");
    verifierCommit(r.git, "hooks/integration-gate.sh", "review: hook update");
    const out = await miniGate(r, r.base);
    expect(out.result.weakenings.filter((w) => w.kind === "policy-file")).toEqual([]);
    expect(out.result.status).toBe("pass");
  });

  it("exempt+policy: foreign-path session + --accept-weakening → mixed-weakening", async () => {
    const r = makeMiniRepo(EXEMPT_POLICY_YAML, {
      "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
    });
    r.write(
      "forge.yaml",
      (r.read("forge.yaml") as string).replace("deny: [danger.cmd]", "deny: []"),
    );
    r.write("src/foreign.ts", "export const x = 1;\n");
    r.commit("weaken + foreign");
    const out = await miniGate(r, r.base, { acceptWeakening: "operator approved" });
    expect(out.result.status).toBe("fail");
    expect(out.result.acceptedWeakening).toBeNull();
    expect(out.result.violations.some((v) => /mixed-weakening/.test(v.message))).toBe(true);
  });

  it("exempt+policy: --policy-only on the exempt contour still judges", async () => {
    const r = makeMiniRepo(EXEMPT_POLICY_YAML, {
      "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
    });
    r.write(
      "forge.yaml",
      (r.read("forge.yaml") as string).replace("deny: [danger.cmd]", "deny: []"),
    );
    r.commit("weaken frozen key");
    const out = await miniGate(r, r.base, { policyOnly: true });
    expect(out.result.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
    expect(out.result.status).toBe("fail");
  });

  it("exempt+policy: policy-decl amendment on the exempt contour → fail", async () => {
    const r = makeMiniRepo(EXEMPT_POLICY_YAML, {
      "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
    });
    r.write(
      "forge.yaml",
      (r.read("forge.yaml") as string).replace(
        "mutable: [project, forge, moves]",
        "mutable: [project, forge, moves, agentTools]",
      ),
    );
    r.commit("self-expand policy");
    const out = await miniGate(r, r.base);
    expect(out.result.weakenings.some((w) => w.kind === "policy-decl")).toBe(true);
    expect(out.result.status).toBe("fail");
  });

  it("exempt×exempt + NO policy → clean exempt status, no violations", async () => {
    const r = makeMiniRepo(EXEMPT_YAML);
    r.write("src/anything.ts", "export const x = 1;\n");
    r.write(
      "forge.yaml",
      (r.read("forge.yaml") as string).replace('checkRun: "node {file}"', 'checkRun: "true"'),
    );
    r.commit("touch things under exempt");
    const out = await miniGate(r, r.base);
    expect(out.result.status).toBe("exempt");
    expect(out.result.weakenings).toEqual([]);
  });
});

// ===========================================================================
// CX-30 candidate: HEAD adopts a MALFORMED policy on an exempt repo whose
// base declared none — the early exempt return (run.ts:284) fires before
// `now` (and thus `now.policyMalformed`) is even computed (run.ts:315/327).
// AC-7/doc p.43: a malformed declaration refuses CORR-GATE-01, never inert.
// ===========================================================================

describe("CX-30?: malformed policy adopted at HEAD on an exempt no-policy repo", () => {
  it("policy: <scalar> at HEAD — must refuse CORR-GATE-01, not return exempt", async () => {
    const r = makeMiniRepo(EXEMPT_YAML);
    r.write("forge.yaml", `${r.read("forge.yaml")}policy: "garbage"\n`);
    r.commit("adopt malformed policy");
    const out = await miniGate(r, r.base);
    // Expected per AC-7: CORR-GATE-01 fail-closed. Observed: ???
    expect(
      out.result.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error"),
      `status=${out.result.status} violations=${JSON.stringify(out.result.violations)}`,
    ).toBe(true);
  });

  it("policy: {freezeFiles: [1]} at HEAD — must refuse CORR-GATE-01, not return exempt", async () => {
    const r = makeMiniRepo(EXEMPT_YAML);
    r.write("forge.yaml", `${r.read("forge.yaml")}policy:\n  freezeFiles: [1]\n`);
    r.commit("adopt malformed policy");
    const out = await miniGate(r, r.base);
    expect(
      out.result.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error"),
      `status=${out.result.status} violations=${JSON.stringify(out.result.violations)}`,
    ).toBe(true);
  });

  it("--policy-only variant of the same adoption — must refuse CORR-GATE-01", async () => {
    const r = makeMiniRepo(EXEMPT_YAML);
    r.write("forge.yaml", `${r.read("forge.yaml")}policy:\n  mutable: 1\n`);
    r.commit("adopt malformed policy");
    const out = await miniGate(r, r.base, { policyOnly: true });
    expect(
      out.result.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error"),
      `status=${out.result.status} violations=${JSON.stringify(out.result.violations)}`,
    ).toBe(true);
  });

  it("the smuggled malformed policy BRICKS the next gate run (CORR-GATE-01 at base)", async () => {
    const r = makeMiniRepo(EXEMPT_YAML);
    r.write("forge.yaml", `${r.read("forge.yaml")}policy: "garbage"\n`);
    const base2 = r.commit("adopt malformed policy");
    r.commit("innocent next session");
    const out = await miniGate(r, base2);
    expect(
      out.result.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error"),
    ).toBe(true);
    expect(out.result.status).toBe("fail");
  });

  it("control: WELL-FORMED policy adopted at HEAD on exempt → pass (opt-in adoption, judged)", async () => {
    const r = makeMiniRepo(EXEMPT_YAML);
    r.write(
      "forge.yaml",
      `${r.read("forge.yaml")}policy:\n  mutable: [project]\n  additive: []\n  freezeFiles: []\n`,
    );
    r.commit("adopt policy");
    const out = await miniGate(r, r.base);
    // Adoption is opt-in — nothing was frozen at this base, so the judged
    // policy diff is empty and the contour reports `pass` (not `exempt`):
    // the newly declared surface WAS judged — a malformed block would fail
    // (CX-30), a well-formed one passes.
    expect(out.result.status).toBe("pass");
    expect(out.result.weakenings).toEqual([]);
  });

  it("control: an unreadable scalar forge.yaml at HEAD on exempt → CORR-GATE-01", async () => {
    const r = makeMiniRepo(EXEMPT_YAML);
    r.write("forge.yaml", "42\n");
    r.commit("break forge.yaml");
    const out = await miniGate(r, r.base);
    expect(
      out.result.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error"),
      `status=${out.result.status} violations=${JSON.stringify(out.result.violations)}`,
    ).toBe(true);
    expect(out.result.status).toBe("fail");
  });

  it("OBS: an unreadable forge.yaml AT BASE is tolerated on the exempt contour", async () => {
    const r = makeMiniRepo("42\n");
    r.write("forge.yaml", EXEMPT_YAML);
    r.commit("adopt exempt");
    const out = await miniGate(r, r.base);
    console.log(
      "OBS garbage-base-exempt:",
      JSON.stringify({ status: out.result.status, violations: out.result.violations }),
    );
  });

  it("OBS: --policy-only on exempt+no-policy returns exempt, not the AC-7 note", async () => {
    const r = makeMiniRepo(EXEMPT_YAML);
    r.commit("noop");
    const out = await miniGate(r, r.base, { policyOnly: true });
    console.log(
      "OBS policyOnly-exempt-note:",
      JSON.stringify({ status: out.result.status, violations: out.result.violations }),
    );
  });
});

// ===========================================================================
// CX-31 candidate: worktree/commit MODE desync on the exempt contour.
// validation.status derives from the WORKTREE (readCorrectnessSettings —
// loadForgeConfig(workspaceRoot)) while `now`/`frozen` are commit-derived.
// An uncommitted `mode: exempt` + unbound correctnessManifest on a committed
// enforce session makes exemptContour true → early return before ANY
// weakening is computed → committed frozen-binding weakening is masked.
// Doc p.45: "an uncommitted edit neither masks a committed weakening nor
// fabricates one."
// ===========================================================================

describe("CX-31?: uncommitted exempt flip masks a committed binding weakening", () => {
  it("committed checkRun weakening + dirty exempt worktree → must still judge", async () => {
    const r = makeMiniRepo(EXEMPT_YAML);
    // Session commits: enforce + manifest binding + WEAKENED checkRun.
    r.write(
      "forge.yaml",
      `schema: forge/config@1
project:
  name: probe
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "true"
  paths:
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: enforce
`,
    );
    r.write(
      "docs/correctness.yaml",
      "schema: forge/correctness-manifest@1\nentries: []\nsupport: []\nexemptions: []\n",
    );
    r.commit("enforce + weaken checkRun");
    // Uncommitted: flip back to exempt + drop the manifest binding.
    r.write(
      "forge.yaml",
      `schema: forge/config@1
project:
  name: probe
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "true"
  paths: {}
correctness:
  mode: exempt
`,
    );
    const out = await miniGate(r, r.base);
    // The committed session weakened bindings.commands.checkRun (frozen at
    // base: "node {file}" → "true") — the gate must NOT report exempt.
    expect(
      out.result.status !== "exempt" && out.result.weakenings.some((w) => w.kind === "binding"),
      `status=${out.result.status} weakenings=${JSON.stringify(out.result.weakenings)}`,
    ).toBe(true);
  });

  it("mirror direction: committed exempt + dirty ENFORCE worktree fabricates a failure", async () => {
    const r = makeMiniRepo(EXEMPT_YAML);
    r.commit("noop committed — clean exempt session");
    // Uncommitted: flip worktree to enforce (no manifest bound) → validation
    // errors → CORR-GATE-01 failure on an entirely committed-clean contour.
    r.write(
      "forge.yaml",
      (r.read("forge.yaml") as string).replace("mode: exempt", "mode: enforce"),
    );
    const out = await miniGate(r, r.base);
    console.log(
      "OBS dirty-enforce-fabrication:",
      JSON.stringify({ status: out.result.status, violations: out.result.violations }),
    );
    // Spec-consistent behavior would judge commits (exempt×exempt → exempt).
    // Observed: whatever the gate does — documented.
  });

  it("same desync on a DECLARED-policy base exempt repo — policy judgements survive (control)", async () => {
    const r = makeMiniRepo(EXEMPT_POLICY_YAML, {
      "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
    });
    // Committed: frozen-key weakening, still exempt.
    r.write(
      "forge.yaml",
      (r.read("forge.yaml") as string).replace("deny: [danger.cmd]", "deny: []"),
    );
    r.commit("weaken frozen key");
    // Uncommitted: still exempt but harmless edit.
    r.write("forge.yaml", (r.read("forge.yaml") as string).replace("name: probe", "name: probe2"));
    const out = await miniGate(r, r.base);
    expect(out.result.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
    expect(out.result.status).toBe("fail");
  });
});

// ===========================================================================
// structuredClone / strip-path edge cases (CX-27 follow-ups)
// ===========================================================================

describe("strip-path edge values", () => {
  it("empty-doc strip: forge.yaml carrying only policy:+correctness: stays isolated", async () => {
    const f = fx({});
    f.write(
      "forge.yaml",
      `schema: forge/config@1
project:
  name: gate-fixture
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
  paths:
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: enforce
  tier: standard
policy:
  mutable: [project, forge]
  additive: []
  freezeFiles: []
`,
    );
    const base2 = f.commit("policy base");
    // weakening: remove the whole correctness block + amend policy — only
    // self-frozen keys change → isolated.
    f.write(
      "forge.yaml",
      `schema: forge/config@1
project:
  name: gate-fixture
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
  paths:
    correctnessManifest: docs/correctness.yaml
policy:
  mutable: [project]
  additive: []
  freezeFiles: []
`,
    );
    f.commit("drop correctness + amend policy");
    const out = await runCorrectnessGate(f.root, {
      base: base2,
      bundleDir: `${f.root}/.bundles`,
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    if (!out.ok) throw new Error(out.usageError);
    expect(out.result.status).toBe("pass");
    expect(out.result.acceptedWeakening).toBe("operator approved");
  });

  it("BigInt leaf under an ADDITIVE key: add new int leaf → ok; change existing → policy-key", async () => {
    const base = sideFrom(
      `schema: forge/config@1
project: {name: p}
paths: {}
bindings:
  commands: {checkRun: "node {file}"}
loopMetrics: []
limits:
  cap: 9007199254740993
policy:
  mutable: [project]
  additive: [limits]
  freezeFiles: []
`,
      () => null,
    );
    const frozen: FrozenSet = {
      base,
      files: [],
      anchors: new Map(),
      baseRefs: new Set(),
      baseManifestUnreadable: false,
      supportGlobs: [],
      supportMalformed: false,
      anchorFiles: [],
      anchorCarriers: new Map(),
      baseFiles: [],
      baseFilesComplete: true,
      policyGlobs: [],
      policyFiles: [],
    };
    const added = sideFrom(
      `schema: forge/config@1
project: {name: p}
paths: {}
bindings:
  commands: {checkRun: "node {file}"}
loopMetrics: []
limits:
  cap: 9007199254740993
  extra: 5
policy:
  mutable: [project]
  additive: [limits]
  freezeFiles: []
`,
      () => null,
    );
    expect(policyWeakenings(frozen, added)).toEqual([]);
    const changed = sideFrom(
      `schema: forge/config@1
project: {name: p}
paths: {}
bindings:
  commands: {checkRun: "node {file}"}
loopMetrics: []
limits:
  cap: 9007199254740992
policy:
  mutable: [project]
  additive: [limits]
  freezeFiles: []
`,
      () => null,
    );
    expect(policyWeakenings(frozen, changed).some((w) => w.kind === "policy-key")).toBe(true);
  });

  it(".nan/.inf/-0.0 inside a MUTABLE key through the strip — equal values stay isolated", async () => {
    const f = fx({
      forgeYamlAppend: `moves:\n  m1: .nan\n  m2: .inf\n  m3: -0.0\n${POLICY_APPEND}`,
      extraFiles: POLICY_FILES,
    });
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 1\n");
    f.commit("touch hook only");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved");
  });

  it("OBS: a mutable-key edit poisons the isolated accept (foreign forge.yaml)", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("deny: [danger.cmd]", "deny: []")
        .replace("name: gate-fixture", "name: renamed"),
    );
    f.commit("weaken + mutable edit");
    const { result } = await gate(f, {
      policyOnly: true,
      acceptWeakening: "operator approved",
    });
    console.log(
      "OBS mutable-edit-in-accept:",
      JSON.stringify({ status: result.status, violations: result.violations }),
    );
    // Documented cx3 behavior — asserted to keep the semantics pinned.
    expect(result.status).toBe("fail");
  });
});

// ===========================================================================
// exempt+policy: deep isolation checks
// ===========================================================================

describe("exempt+policy: isolation and mixed-scope detail", () => {
  it("a mutable-key change on the exempt+policy contour makes the accept mixed", async () => {
    const r = makeMiniRepo(EXEMPT_POLICY_YAML, {
      "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
    });
    r.write(
      "forge.yaml",
      (r.read("forge.yaml") as string)
        .replace("deny: [danger.cmd]", "deny: []")
        .replace("name: probe", "name: renamed"),
    );
    r.commit("weaken + mutable edit");
    const out = await miniGate(r, r.base, { acceptWeakening: "operator approved" });
    expect(out.result.status).toBe("fail");
    expect(out.result.violations.some((v) => /mixed-weakening/.test(v.message))).toBe(true);
  });

  it("policy-file change ALONE on exempt+policy accepts", async () => {
    const r = makeMiniRepo(EXEMPT_POLICY_YAML, {
      "hooks/integration-gate.sh": "#!/bin/sh\nexit 0\n",
    });
    r.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 1\n");
    r.commit("touch hook");
    const out = await miniGate(r, r.base, { acceptWeakening: "operator approved" });
    expect(out.result.status).toBe("pass");
    expect(out.result.acceptedWeakening).toBe("operator approved");
  });

  it("exempt+policy: malformed policy AT BASE refuses CORR-GATE-01 (not exempt)", async () => {
    const r = makeMiniRepo(`${EXEMPT_YAML}policy: "garbage"\n`);
    r.commit("noop");
    const out = await miniGate(r, r.base);
    expect(
      out.result.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error"),
      `status=${out.result.status} violations=${JSON.stringify(out.result.violations)}`,
    ).toBe(true);
    expect(out.result.status).toBe("fail");
  });
});

// ===========================================================================
// Non-exempt probes
// ===========================================================================

describe("non-exempt contour regression probes", () => {
  it("mutable:[bindings] releases checkRun under --policy-only but NOT in full mode", async () => {
    const f = fx({
      forgeYamlAppend: `agentTools:\n  deny: [danger.cmd]\npolicy:\n  mutable: [project, forge, moves, bindings]\n  additive: []\n  freezeFiles: []\n`,
    });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "true"'),
    );
    f.commit("rebind checkRun under mutable bindings");
    // policy-only: documented release.
    const po = await runCorrectnessGate(f.root, {
      base: f.base,
      bundleDir: `${f.root}/.bundles`,
      policyOnly: true,
    });
    if (!po.ok) throw new Error(po.usageError);
    expect(po.result.weakenings.filter((w) => w.kind === "binding")).toEqual([]);
    // full gate: the dedicated binding rule wins over mutable (doc p.39).
    const full = await runCorrectnessGate(f.root, {
      base: f.base,
      bundleDir: `${f.root}/.bundles`,
    });
    if (!full.ok) throw new Error(full.usageError);
    expect(
      full.result.weakenings.some((w) => w.kind === "binding"),
      `weakenings: ${JSON.stringify(full.result.weakenings)}`,
    ).toBe(true);
  });

  it("duplicate top-level YAML key (policy: twice) → CORR-GATE-01, not a crash", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("forge.yaml", `${f.read("forge.yaml")}policy: {}\n`);
    f.commit("duplicate policy key");
    const { result } = await gate(f, { policyOnly: true });
    expect(
      result.violations.some((v) => v.rule === "CORR-GATE-01"),
      JSON.stringify(result.violations),
    ).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("OBS: policy.mutable LIST REORDER — semantically a set, canon order-sensitive", async () => {
    const f = fx({ forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("mutable: [project, forge, moves]", "mutable: [moves, forge, project]"),
    );
    f.commit("reorder mutable list only");
    const { result } = await gate(f, { policyOnly: true });
    console.log(
      "OBS mutable-list-reorder:",
      JSON.stringify({ status: result.status, weakenings: result.weakenings }),
    );
  });

  it("no-policy repo: RFC-1580 binding weakening accepts isolated (strip path, policy null)", async () => {
    const f = fx({});
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "true"'),
    );
    f.commit("rebind checkRun");
    const { result } = await gate(f, { acceptWeakening: "operator approved" });
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved");
  });

  it("OBS: mutable:[correctness] + --policy-only releases an enforce→exempt switch", async () => {
    const f = fx({
      forgeYamlAppend: `policy:\n  mutable: [project, forge, moves, correctness]\n  additive: []\n  freezeFiles: []\n`,
    });
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: enforce", "mode: exempt"));
    f.commit("exempt myself under mutable correctness");
    const { result } = await gate(f, { policyOnly: true });
    console.log(
      "OBS policyOnly-exempt-switch:",
      JSON.stringify({ status: result.status, weakenings: result.weakenings }),
    );
    // full gate must still catch it (dedicated mode rule wins over mutable)
    const full = await gate(f, {});
    expect(full.result.weakenings.some((w) => w.kind === "mode")).toBe(true);
    expect(full.result.status).toBe("fail");
  });

  it("OBS: freezeFiles: ['forge.yaml'] — every forge.yaml edit is policy-file", async () => {
    const f = fx({
      forgeYamlAppend: `agentTools:\n  deny: [danger.cmd]\npolicy:\n  mutable: [project, forge]\n  additive: []\n  freezeFiles: ["forge.yaml"]\n`,
    });
    f.write("forge.yaml", f.read("forge.yaml").replace("name: gate-fixture", "name: renamed"));
    f.commit("mutable-only edit with forge.yaml frozen");
    const { result } = await gate(f, { policyOnly: true });
    console.log(
      "OBS forge.yaml-in-freezeFiles:",
      JSON.stringify({ status: result.status, weakenings: result.weakenings }),
    );
  });
});
