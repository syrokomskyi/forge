/*
RFC-1615 acceptance verification — ROUND 7 (adversarial, independent).

Target of this round: the committed-side-verdict refactor (CX-30..34).
Every verdict input must be commit-derived; manifest content + oracle
execution deliberately stay worktree-flavored.

New counterexample classes probed here:

 CX-35  settingsFromForgeDoc drops schema-level configError — a committed
        forge.yaml that parses to a YAML map but fails forgeConfigSchema
        (missing project:, paths:, bindings.schema, scalar bindings, …)
        loses the CORR-01 "forge.yaml is not readable" violation the
        worktree-flavored readCorrectnessSettings produces → masked
        verdict under enforce.
 CX-36  forgeYamlOnlyFrozenKeys asymmetry — the null-policy strip keeps
        `policy:`, so a LEGAL policy adoption in a weakening session makes
        forge.yaml foreign → mixed-weakening, while an ILLEGAL policy-decl
        amendment (base declares policy) is stripped and accepts fine.
 CX-37  anchorWeakenings reads the WORKTREE — a committed anchor reword is
        masked by an uncommitted revert; an uncommitted reword fabricates
        CORR-GATE-02 on a clean committed diff. The last verdict input
        still worktree-flavored, contrary to the refactor's contract.
 CX-38  duplicate + contradictory "no policy surface declared" notes —
        the every-contour CX-34 note (run.ts:337) fires alongside the old
        policyScope note (run.ts:446): two identical notes on
        --policy-only, two CONTRADICTORY ones on exempt-adopt.
 CX-39  committed `oracleTimeoutMs: .inf` → timeoutMs=Infinity →
        setTimeout overflow → ~1ms kill → fabricated CORR-GATE-07 on
        every oracle.
 CX-41  exempt×exempt no-policy early-returns before the every-contour
        note — the one contour where the bundle NEVER discloses that the
        policy checks were inert.
 CX-46  scalar-string committed forge.yaml + declared base policy +
        --accept-weakening → forgeYamlOnlyFrozenKeys `delete` on a
        primitive string index → TypeError → the gate crashes instead of
        producing structured output.

Re-verifications (expected-pass behavior; failure = counterexample):
 CX-32/33 worktree flips (mode/tier/oracleTimeoutMs/manifestPath) neither
 mask committed weakenings nor fabricate failures; exemptContour cells;
 exempt×exempt policy judging; --policy-only refusal under warn.
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sideFrom } from "./frozen.ts";
import { runCorrectnessGate } from "./run.ts";
import { makeGateFixture, type GateFixture } from "./tests/gate-fixture.ts";
import { readCorrectnessSettings, settingsFromForgeDoc } from "../workspace.ts";

// ---------------------------------------------------------------------------
// E2E helpers
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
  root: string,
  base: string,
  opts: { policyOnly?: boolean; acceptWeakening?: string } = {},
) => {
  const out = await runCorrectnessGate(root, {
    base,
    bundleDir: `${root}/.bundles`,
    ...opts,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out;
};

const notes = (out: Awaited<ReturnType<typeof gate>>) =>
  out.result.violations.filter((v) => v.message.includes("no policy surface declared"));

const errs = (out: Awaited<ReturnType<typeof gate>>) =>
  out.result.violations.filter((v) => v.severity === "error");

/** A minimal repo whose commits carry a caller-supplied forge.yaml. */
function bareRepo(firstYaml: string): GateFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "forge-gate-bare-"));
  tmpdirs.push(root);
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (rel: string, body: string) => {
    const abs = path.join(root, rel);
    execFileSync("mkdir", ["-p", path.dirname(abs)]);
    writeFileSync(abs, body);
  };
  const commit = (message: string) => {
    git(["add", "-A"]);
    git(["commit", "-qm", message, "--allow-empty"]);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "-q", "-b", "develop"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  write("forge.yaml", firstYaml);
  commit("base");
  const base = git(["rev-parse", "HEAD"]);
  const f: GateFixture = {
    root,
    base,
    write,
    read: (rel) => execFileSync("cat", [path.join(root, rel)], { encoding: "utf8" }),
    git,
    commit,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return f;
}

const EXEMPT_BASE = `schema: forge/config@1
project: {name: probe}
paths: {}
correctness: {mode: exempt}
`;

const EXEMPT_WITH_POLICY = `schema: forge/config@1
project: {name: probe}
paths: {}
correctness: {mode: exempt}
agentTools:
  deny: [danger.cmd]
policy:
  mutable: [project, forge, moves]
  additive: [bindings, paths, loopMetrics]
  freezeFiles:
    - "hooks/**"
`;

// ===========================================================================
// CX-32/33 RE-VERIFICATION — worktree flips on committed verdict inputs
// ===========================================================================

describe("CX-32 re-verify: worktree mode flip on committed enforce", () => {
  it("worktree `mode: warn` does NOT downgrade committed-enforce errors", async () => {
    const f = fx({ mode: "enforce", review: false }); // self oracle → CORR-GATE-03/08
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: enforce", "mode: warn"));
    const out = await gate(f.root, f.base);
    expect(out.result.mode).toBe("enforce");
    expect(
      errs(out).some((v) => v.rule === "CORR-GATE-03" || v.rule === "CORR-GATE-08"),
      `expected committed-enforce gate errors, got ${JSON.stringify(out.result.violations)}`,
    ).toBe(true);
    expect(out.result.status).toBe("fail");
  });

  it("worktree `mode: exempt` does NOT exempt a committed-enforce contour", async () => {
    const f = fx({ mode: "enforce", review: false });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("mode: enforce", "mode: exempt"),
    );
    const out = await gate(f.root, f.base);
    expect(out.result.status).toBe("fail");
    expect(out.result.mode).toBe("enforce");
  });
});

describe("CX-32 re-verify: worktree enforce flip on committed warn", () => {
  it("does NOT fabricate errors — committed warn still downgrades", async () => {
    const f = fx({ mode: "warn", review: false }); // self oracle → 03/08 → warn
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: warn", "mode: enforce"));
    const out = await gate(f.root, f.base);
    expect(out.result.mode).toBe("warn");
    expect(out.result.status).toBe("pass");
  });
});

describe("CX-33 re-verify: worktree tier/oracleTimeoutMs/manifestPath flips", () => {
  it("committed tier high + review-only oracle: worktree `tier: standard` does not lift CORR-GATE-06", async () => {
    const f = fx({ mode: "enforce", tier: "high" });
    f.write("forge.yaml", f.read("forge.yaml").replace("tier: high", "tier: standard"));
    const out = await gate(f.root, f.base);
    expect(
      errs(out).some((v) => v.rule === "CORR-GATE-06"),
      `expected CORR-GATE-06 (committed high tier needs trailer origin), got ${JSON.stringify(
        out.result.violations,
      )}`,
    ).toBe(true);
    expect(out.result.status).toBe("fail");
    expect(out.bundle.tier).toBe("high");
  });

  it("committed oracleTimeoutMs 60000: worktree `oracleTimeoutMs: 1` does not time out", async () => {
    const f = fx({ mode: "enforce" });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("tier: standard", "tier: standard\n  oracleTimeoutMs: 60000"),
    );
    f.commit("committed generous timeout");
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("oracleTimeoutMs: 60000", "oracleTimeoutMs: 1"),
    );
    const out = await gate(f.root, f.base);
    expect(out.result.status).toBe("pass");
  });

  it("committed oracleTimeoutMs 80 + sleepy oracle: worktree `oracleTimeoutMs: 60000` does not rescue", async () => {
    const sleepy = `import { setTimeout } from "node:timers/promises";\nawait setTimeout(5000);\n`;
    const f = fx({ mode: "enforce", oracle: sleepy });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("tier: standard", "tier: standard\n  oracleTimeoutMs: 80"),
    );
    f.commit("committed tight timeout");
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("oracleTimeoutMs: 80", "oracleTimeoutMs: 60000"),
    );
    const out = await gate(f.root, f.base);
    expect(
      errs(out).some((v) => v.rule === "CORR-GATE-07" && v.message.includes("timed out")),
      `expected committed-timeout CORR-GATE-07, got ${JSON.stringify(out.result.violations)}`,
    ).toBe(true);
    expect(out.result.status).toBe("fail");
  });

  it("worktree manifestPath rebind is invisible — committed binding judged", async () => {
    const f = fx({ mode: "enforce" });
    f.write("docs/other.yaml", f.read("docs/correctness.yaml"));
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("correctnessManifest: docs/correctness.yaml", "correctnessManifest: docs/other.yaml"),
    );
    // Uncommitted rebind: committed manifestPath still docs/correctness.yaml.
    const out = await gate(f.root, f.base);
    expect(out.result.status).toBe("pass");
  });
});

// ===========================================================================
// exemptContour cells — committed legs only
// ===========================================================================

describe("exempt contour cells", () => {
  it("exempt×exempt no-policy → status exempt", async () => {
    const f = bareRepo(EXEMPT_BASE);
    f.commit("empty head");
    const out = await gate(f.root, f.base);
    expect(out.result.status).toBe("exempt");
    expect(out.result.mode).toBe("exempt");
  });

  it("base exempt → head warn is NOT exempt (full judging)", async () => {
    const f = bareRepo(EXEMPT_BASE);
    f.write(
      "forge.yaml",
      `schema: forge/config@1\nproject: {name: probe}\npaths: {}\ncorrectness: {mode: warn}\n`,
    );
    f.commit("un-exempt");
    const out = await gate(f.root, f.base);
    expect(out.result.status).not.toBe("exempt");
  });

  it("committed `mode: !!str exempt` counts as exempt (tagged scalar)", () => {
    const side = sideFrom(
      `schema: forge/config@1\ncorrectness:\n  mode: !!str exempt\n`,
      () => null,
    );
    expect(side.mode).toBe("exempt");
    expect(settingsFromForgeDoc(side.forgeDoc, side.forgeYamlUnreadable).mode).toBe("exempt");
  });

  it("committed `mode: [exempt]` is NOT exempt (invalid → CORR-02)", () => {
    const side = sideFrom(
      `schema: forge/config@1\ncorrectness:\n  mode: [exempt]\n`,
      () => null,
    );
    expect(side.mode).toBe("warn");
    const s = settingsFromForgeDoc(side.forgeDoc, side.forgeYamlUnreadable);
    expect(s.mode).toBe("warn");
    expect(s.invalid.some((i) => i.key === "mode")).toBe(true);
  });
});

describe("exempt × exempt contour with declared policy — policy judged only", () => {
  it("well-formed HEAD adoption → pass", async () => {
    const f = bareRepo(EXEMPT_BASE);
    f.write("forge.yaml", EXEMPT_WITH_POLICY);
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n");
    f.commit("adopt policy");
    const out = await gate(f.root, f.base);
    expect(out.result.status).toBe("pass");
    expect(
      out.result.weakenings.length,
      `expected no weakenings on fresh adoption, got ${JSON.stringify(out.result.weakenings)}`,
    ).toBe(0);
  });

  it("malformed HEAD adoption → CORR-GATE-01 refusal", async () => {
    const f = bareRepo(EXEMPT_BASE);
    f.write("forge.yaml", `${EXEMPT_BASE}policy: [a]\n`);
    f.commit("adopt malformed policy");
    const out = await gate(f.root, f.base);
    expect(out.result.status).toBe("fail");
    expect(
      errs(out).some((v) => v.rule === "CORR-GATE-01" && v.message.includes("malformed")),
    ).toBe(true);
  });

  it("declared policy at base + frozen-key weakening at head → CORR-GATE-02 on exempt contour", async () => {
    const f = bareRepo(EXEMPT_WITH_POLICY);
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n");
    f.commit("policy + hook");
    const base = f.git(["rev-parse", "HEAD"]);
    f.write("forge.yaml", EXEMPT_WITH_POLICY.replace("deny: [danger.cmd]", "deny: [safe.cmd]"));
    f.commit("weaken agentTools");
    const out = await gate(f.root, base);
    expect(out.result.status).toBe("fail");
    expect(out.result.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
    expect(errs(out).some((v) => v.rule === "CORR-GATE-02")).toBe(true);
  });

  it("declared policy + new freezeFiles glob match at head → policy-file weakening on exempt contour", async () => {
    const f = bareRepo(EXEMPT_WITH_POLICY);
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n");
    f.commit("policy + hook");
    const base = f.git(["rev-parse", "HEAD"]);
    f.write("hooks/new-hook.sh", "#!/bin/sh\nexit 1\n");
    f.commit("add hook");
    const out = await gate(f.root, base);
    expect(out.result.status).toBe("fail");
    expect(out.result.weakenings.some((w) => w.kind === "policy-file")).toBe(true);
  });
});

describe("--policy-only on committed enforce + worktree exempt flip", () => {
  it("committed policy-key weakening is still CORR-GATE-02", async () => {
    const f = fx({ mode: "enforce", forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: [safe.cmd]"));
    f.commit("weaken agentTools");
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("mode: enforce", "mode: exempt"), // uncommitted flip
    );
    const out = await gate(f.root, f.base, { policyOnly: true });
    expect(out.result.status).toBe("fail");
    expect(out.result.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
    expect(errs(out).some((v) => v.rule === "CORR-GATE-02")).toBe(true);
  });

  it("warn mode does NOT downgrade CORR-GATE-02 (AC-1)", async () => {
    const f = fx({ mode: "warn", forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: [safe.cmd]"));
    f.commit("weaken agentTools");
    const out = await gate(f.root, f.base, { policyOnly: true });
    expect(out.result.status).toBe("fail");
    expect(errs(out).some((v) => v.rule === "CORR-GATE-02")).toBe(true);
  });
});

// ===========================================================================
// CX-35: schema-invalid committed forge.yaml loses CORR-01 "unreadable"
// ===========================================================================

describe("CX-35: settingsFromForgeDoc drops schema-level configError", () => {
  const INVALID_YAMLS: Record<string, string> = {
    "missing project:": `schema: forge/config@1\npaths: {}\ncorrectness: {mode: enforce}\n`,
    "missing paths:": `schema: forge/config@1\nproject: {name: p}\ncorrectness: {mode: enforce}\n`,
    "missing schema literal": `project: {name: p}\npaths: {}\ncorrectness: {mode: enforce}\n`,
    "scalar bindings": `schema: forge/config@1\nproject: {name: p}\npaths: {}\nbindings: 5\ncorrectness: {mode: enforce}\n`,
    "non-map correctness": `schema: forge/config@1\nproject: {name: p}\npaths: {}\ncorrectness: 7\n`,
  };

  for (const [label, yaml] of Object.entries(INVALID_YAMLS)) {
    it(`parity check (${label}): readCorrectnessSettings.configError vs settingsFromForgeDoc`, () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-"));
      tmpdirs.push(dir);
      writeFileSync(path.join(dir, "forge.yaml"), yaml);
      const reference = readCorrectnessSettings(dir);
      const side = sideFrom(yaml, () => null);
      const committed = settingsFromForgeDoc(side.forgeDoc, side.forgeYamlUnreadable);
      expect(
        reference.configError !== null,
        `reference should flag ${label} as unreadable`,
      ).toBe(true);
      expect(
        committed.configError !== null,
        `committed replica must flag ${label} too (divergence masks CORR-01)`,
      ).toBe(true);
    });
  }

  it("e2e: committed schema-invalid enforce forge.yaml + clean contour — expected CORR-01 fail", async () => {
    const f = fx({ mode: "enforce" });
    // HEAD: a YAML-map forge.yaml that zod rejects (project: dropped).
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace(/project:\n  name: gate-fixture\n/, ""),
    );
    f.commit("schema-invalid forge.yaml");
    const out = await gate(f.root, f.base);
    // reference semantics: configError → CORR-01 error → fail.
    // committed flavor: configError null → nothing reported.
    const corr01 = errs(out).filter(
      (v) => v.rule === "CORR-GATE-01" && v.message.includes("not readable"),
    );
    expect(
      corr01.length > 0,
      `expected CORR-01 'forge.yaml is not readable' — a schema-invalid committed config must not pass; status=${out.result.status} violations=${JSON.stringify(
        out.result.violations,
      )}`,
    ).toBe(true);
    expect(out.result.status).toBe("fail");
  });
});

// ===========================================================================
// CX-36: legal policy adoption dead-ends --accept-weakening (mixed-weakening)
// ===========================================================================

describe("CX-36: policy adoption in a weakening session → mixed-weakening", () => {
  it("control: isolated weakening (tier lowered) accepts", async () => {
    const f = fx({ mode: "enforce", tier: "high" });
    f.write("forge.yaml", f.read("forge.yaml").replace("tier: high", "tier: standard"));
    f.commit("lower tier");
    const out = await gate(f.root, f.base, { acceptWeakening: "operator accepted" });
    expect(out.result.status).toBe("pass");
    expect(out.result.acceptedWeakening).toBe("operator accepted");
  });

  it("same weakening + LEGAL policy adoption → mixed-weakening false positive", async () => {
    const f = fx({ mode: "enforce", tier: "high" });
    f.write(
      "forge.yaml",
      `${f.read("forge.yaml").replace("tier: high", "tier: standard")}policy:\n  mutable: [project]\n`,
    );
    f.commit("lower tier + adopt policy");
    const out = await gate(f.root, f.base, { acceptWeakening: "operator accepted" });
    // Expected: adopted policy is not itself a weakening (AC-7) — the diff is
    // confined to the frozen weakening surface → accept proceeds.
    expect(
      out.result.violations.some((v) => v.message.includes("mixed-weakening")),
      `policy: adoption must not make forge.yaml foreign — got ${JSON.stringify(
        out.result.violations,
      )}`,
    ).toBe(false);
    expect(out.result.status).toBe("pass");
    expect(out.result.acceptedWeakening).toBe("operator accepted");
  });
});

// ===========================================================================
// CX-37: anchorWeakenings reads the WORKTREE (committed-side violation)
// ===========================================================================

describe("CX-37: anchorWeakenings is worktree-flavored", () => {
  const REWORD = (text: string) => text.replace("exactly once", "at most once");

  it("a COMMITTED anchor reword masked by an uncommitted revert → fail-open", async () => {
    const f = fx({ mode: "enforce" });
    const original = f.read("apps/api/src/dispatch.ts");
    f.write("apps/api/src/dispatch.ts", REWORD(original));
    f.commit("committed anchor reword — a real weakening");
    f.write("apps/api/src/dispatch.ts", original); // uncommitted revert
    const out = await gate(f.root, f.base);
    expect(
      out.result.weakenings.some((w) => w.kind === "anchor-reworded"),
      `committed anchor reword must judge from commits — worktree revert must not mask it; status=${out.result.status}`,
    ).toBe(true);
    expect(out.result.status).toBe("fail");
  });

  it("an UNCOMMITTED anchor reword on a clean committed diff fabricates CORR-GATE-02", async () => {
    const f = fx({ mode: "enforce" });
    f.commit("empty head — committed diff is clean");
    f.write(
      "apps/api/src/dispatch.ts",
      REWORD(f.read("apps/api/src/dispatch.ts")), // uncommitted only
    );
    const out = await gate(f.root, f.base);
    expect(
      out.result.weakenings.length,
      `an uncommitted reword must not fabricate a weakening — committed diff is clean; got ${JSON.stringify(
        out.result.weakenings,
      )}`,
    ).toBe(0);
    expect(out.result.status).toBe("pass");
  });
});

// ===========================================================================
// CX-38: duplicate / contradictory inert-policy notes (CX-34 regression)
// ===========================================================================

describe("CX-38: inert-policy note duplication", () => {
  it("--policy-only on a no-policy repo emits exactly ONE note", async () => {
    const f = fx({ mode: "enforce" });
    const out = await gate(f.root, f.base, { policyOnly: true });
    const n = notes(out);
    expect(
      n.length,
      `expected exactly one inert-policy note, got ${n.length}: ${JSON.stringify(n.map((v) => v.message))}`,
    ).toBe(1);
  });

  it("exempt×exempt + HEAD-adopted policy emits ONE coherent note", async () => {
    const f = bareRepo(EXEMPT_BASE);
    f.write("forge.yaml", EXEMPT_WITH_POLICY);
    f.write("hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n");
    f.commit("adopt policy");
    const out = await gate(f.root, f.base);
    const n = notes(out);
    expect(
      n.length,
      `expected exactly one note, got ${n.length}: ${JSON.stringify(n.map((v) => v.message))}`,
    ).toBe(1);
    // and it must not say "adopt policy:" when policy IS adopted
    expect(n[0]?.message ?? "").toContain("binds the next integration");
  });
});

// ===========================================================================
// CX-39: committed oracleTimeoutMs: .inf → fabricated timeouts
// ===========================================================================

describe("CX-39: oracleTimeoutMs Infinity overflow", () => {
  it("committed `oracleTimeoutMs: .inf` must not kill every oracle at ~1ms", async () => {
    const f = fx({ mode: "enforce" });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("tier: standard", "tier: standard\n  oracleTimeoutMs: .inf"),
    );
    f.commit("infinite timeout");
    const out = await gate(f.root, f.base);
    expect(
      out.result.violations.some((v) => v.rule === "CORR-GATE-07" && v.message.includes("timed out")),
      `an infinite timeout must not fabricate timeouts — got ${JSON.stringify(out.result.violations)}`,
    ).toBe(false);
    expect(out.result.status).toBe("pass");
  });

  it("control: committed `oracleTimeoutMs: 60000` passes", async () => {
    const f = fx({ mode: "enforce" });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("tier: standard", "tier: standard\n  oracleTimeoutMs: 60000"),
    );
    f.commit("generous timeout");
    const out = await gate(f.root, f.base);
    expect(out.result.status).toBe("pass");
  });
});

// ===========================================================================
// CX-41: the every-contour note is absent on the exempt early-return
// ===========================================================================

describe("CX-41: exempt×exempt no-policy bundle carries the inert-policy note", () => {
  it("note fires on the exempt contour too (contract: every contour)", async () => {
    const f = bareRepo(EXEMPT_BASE);
    f.commit("empty head");
    const out = await gate(f.root, f.base);
    expect(out.result.status).toBe("exempt");
    expect(
      notes(out).length,
      `the exempt contour must still disclose inert policy checks — got violations ${JSON.stringify(
        out.result.violations,
      )}`,
    ).toBeGreaterThan(0);
  });
});

// ===========================================================================
// CX-46: scalar forge.yaml + declared base policy + accept → TypeError crash
// ===========================================================================

describe("CX-46: scalar forge.yaml crashes the accept path", () => {
  it("declared policy at base + scalar forge.yaml at head + --accept-weakening → structured fail, not TypeError", async () => {
    const f = fx({ mode: "enforce", forgeYamlAppend: POLICY_APPEND, extraFiles: POLICY_FILES });
    f.write("forge.yaml", "just a scalar\n");
    f.commit("scalar forge.yaml");
    let out: Awaited<ReturnType<typeof gate>> | null = null;
    let threw: unknown = null;
    try {
      out = await gate(f.root, f.base, { acceptWeakening: "operator accepted" });
    } catch (e) {
      threw = e;
    }
    expect(
      threw === null,
      `gate must fail closed (CORR-GATE-01), not crash — threw: ${threw instanceof Error ? threw.stack ?? threw.message : String(threw)}`,
    ).toBe(true);
    expect(out?.result.status).toBe("fail");
    expect(
      out?.result.violations.some((v) => v.rule === "CORR-GATE-01"),
    ).toBe(true);
  });
});

// ===========================================================================
// CX-34 re-verification: note on a normal (non-policyOnly) contour — single
// ===========================================================================

describe("CX-34 re-verify: inert note on a normal contour", () => {
  it("no-policy repo on a full enforce gate → exactly one note", async () => {
    const f = fx({ mode: "enforce" });
    const out = await gate(f.root, f.base);
    expect(
      out.result.violations.filter((v) => v.message.includes("no policy surface declared")).length,
    ).toBe(1);
    expect(out.result.status).toBe("pass");
  });
});
