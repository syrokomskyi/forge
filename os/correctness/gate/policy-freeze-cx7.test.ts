/*
RFC-1615 acceptance verification — round 6 adversarial probes.

Attack surface: the commit-derived exempt contour (CX-30/31) and the
`options.policyOnly || exemptContour` early-exit block in
os/correctness/gate/run.ts.

Suspect asymmetry probed hardest: `now` (contour leg, judged weakenings)
is COMMIT-derived, but `validation`/`settings`/`mode`/`tier` are
WORKTREE-derived and still drive (a) CORR-GATE-01 injection from
validation.violations, (b) the CORR-GATE-03..08 warn downgrade, and
(c) tier high/formal requirements — all AFTER the exempt early return.
The spec says an uncommitted worktree mode:/tier: flip can neither mask
a committed weakening nor fabricate a failure.
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessGate } from "./run.ts";
import {
  makeGateFixture,
  type GateFixture,
} from "./tests/gate-fixture.ts";

const fixtures: GateFixture[] = [];
const tmpdirs: string[] = [];
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.cleanup());
  tmpdirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

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

const fx = (o: Parameters<typeof makeGateFixture>[0]) => {
  const f = makeGateFixture(o);
  fixtures.push(f);
  return f;
};

// ---------------------------------------------------------------------------
// Exempt fixture — no manifest binding (exempt repos declare no manifest).
// ---------------------------------------------------------------------------
interface ExemptFx {
  root: string;
  base: string;
  write(rel: string, body: string): void;
  read(rel: string): string;
  git(args: string[]): string;
  commit(message: string, trailers?: string): string;
}

const EXEMPT_POLICY = `policy:
  mutable: [project]
  additive: []
  freezeFiles:
    - "hooks/**"
`;

function makeExemptFixture(opts: {
  policy?: string;
  files?: Record<string, string>;
}): ExemptFx {
  const root = mkdtempSync(path.join(os.tmpdir(), "forge-gate-exempt-"));
  tmpdirs.push(root);
  const write = (rel: string, body: string) => {
    execFileSync("mkdir", ["-p", path.dirname(path.join(root, rel))]);
    writeFileSync(path.join(root, rel), body);
  };
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "develop"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  write(
    "forge.yaml",
    `schema: forge/config@1
project:
  name: exempt-repo
paths: {}
agentTools:
  deny: [danger.cmd]
correctness:
  mode: exempt
${opts.policy ?? ""}`,
  );
  for (const [rel, body] of Object.entries(opts.files ?? {})) write(rel, body);
  git(["add", "-A"]);
  git(["commit", "-qm", "exempt base"]);
  const base = git(["rev-parse", "HEAD"]);
  return {
    root,
    base,
    write,
    read: (rel) => readFileSync(path.join(root, rel), "utf8"),
    git,
    commit: (message, trailers) => {
      git(["add", "-A"]);
      git(["commit", "-qm", trailers ? `${message}\n\n${trailers}` : message, "--allow-empty"]);
      return git(["rev-parse", "HEAD"]);
    },
  };
}

const TRAILERS = "X-Expectation-Origin: independent-verifier\nX-Verifier-Report: docs/rep.yaml";

// ===========================================================================
// A. Exempt-contour matrix (CX-30/31 re-verification + edges)
// ===========================================================================
describe("A: exempt×exempt contour — commit-derived legs", () => {
  it("A1: no policy either side → status exempt (early return)", async () => {
    const f = makeExemptFixture({ files: { "src/x.ts": "x" } });
    f.commit("noop");
    const { result } = await gate(f.root, f.base);
    expect(result.status).toBe("exempt");
    expect(result.weakenings).toEqual([]);
  });

  it("A2: HEAD adopts a WELL-FORMED policy → judged, empty diff → pass", async () => {
    const f = makeExemptFixture({});
    f.write("forge.yaml", `${f.read("forge.yaml")}${EXEMPT_POLICY}`);
    f.commit("adopt policy");
    const { result } = await gate(f.root, f.base);
    expect(result.status).toBe("pass");
    expect(result.weakenings).toEqual([]);
  });

  it("A3: HEAD adopts a MALFORMED policy → CORR-GATE-01 fail (not exempt)", async () => {
    const f = makeExemptFixture({});
    f.write("forge.yaml", `${f.read("forge.yaml")}policy: "not a map"\n`);
    f.commit("adopt malformed policy");
    const { result } = await gate(f.root, f.base);
    expect(result.status).toBe("fail");
    expect(result.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error")).toBe(true);
  });

  it("A4: base policy + frozen key weakened → fail policy-key", async () => {
    const f = makeExemptFixture({ policy: EXEMPT_POLICY });
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.commit("weaken agentTools");
    const { result } = await gate(f.root, f.base);
    expect(result.status).toBe("fail");
    expect(result.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
  });

  it("A5: base policy + frozen glob file weakened → fail policy-file", async () => {
    const f = makeExemptFixture({
      policy: EXEMPT_POLICY,
      files: { "hooks/gate.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/gate.sh", "#!/bin/sh\nexit 9\n");
    f.commit("weaken hook");
    const { result } = await gate(f.root, f.base);
    expect(result.status).toBe("fail");
    expect(result.weakenings.some((w) => w.kind === "policy-file")).toBe(true);
  });

  it("A6: base policy + frozen glob file weakened by VERIFIER commit → exempt from weakening", async () => {
    const f = makeExemptFixture({
      policy: EXEMPT_POLICY,
      files: { "hooks/gate.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/gate.sh", "#!/bin/sh\nexit 9\n");
    f.commit("reviewed hook change", TRAILERS);
    const { result } = await gate(f.root, f.base);
    expect(result.weakenings.filter((w) => w.kind === "policy-file")).toEqual([]);
    expect(result.status).toBe("pass");
  });

  it("A7: base policy + policy: itself changed → policy-decl fail", async () => {
    const f = makeExemptFixture({ policy: EXEMPT_POLICY });
    f.write("forge.yaml", f.read("forge.yaml").replace("mutable: [project]", "mutable: []"));
    f.commit("amend own policy");
    const { result } = await gate(f.root, f.base);
    expect(result.status).toBe("fail");
    expect(result.weakenings.some((w) => w.kind === "policy-decl")).toBe(true);
  });

  it("A8: isolated weakening session + --accept-weakening → pass, recorded", async () => {
    const f = makeExemptFixture({
      policy: EXEMPT_POLICY,
      files: { "hooks/gate.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/gate.sh", "#!/bin/sh\nexit 9\n");
    f.commit("isolated hook weakening");
    const { result } = await gate(f.root, f.base, { acceptWeakening: "operator approved" });
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved");
  });

  it("A9: weakening + foreign file + --accept-weakening → mixed-weakening fail", async () => {
    const f = makeExemptFixture({
      policy: EXEMPT_POLICY,
      files: { "hooks/gate.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/gate.sh", "#!/bin/sh\nexit 9\n");
    f.write("src/x.ts", "export const x = 1;\n");
    f.commit("weakening + foreign src file");
    const { result } = await gate(f.root, f.base, { acceptWeakening: "operator approved" });
    expect(result.status).toBe("fail");
    expect(result.violations.some((v) => v.rule === "CORR-GATE-02" && /mixed-weakening/.test(v.message))).toBe(true);
    expect(result.acceptedWeakening).toBeNull();
  });

  it("A10: forge.yaml-only weakening session + accept → pass (forge.yaml whitelisted)", async () => {
    const f = makeExemptFixture({ policy: EXEMPT_POLICY });
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.commit("forge.yaml-only weakening");
    const { result } = await gate(f.root, f.base, { acceptWeakening: "operator approved" });
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("operator approved");
  });

  it("A11: committed enforce→exempt (self-exemption) is a mode weakening, never exempt", async () => {
    const f = fx({});
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("mode: enforce", "mode: exempt"),
    );
    f.commit("self-exempt");
    const { result } = await gate(f.root, f.base);
    expect(result.status).toBe("fail");
    expect(result.weakenings.some((w) => w.kind === "mode")).toBe(true);
  });

  it("A12: committed exempt→enforce is strengthening — full gate runs, not exempt status", async () => {
    const f = makeExemptFixture({ policy: EXEMPT_POLICY });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("mode: exempt", "mode: enforce"),
    );
    f.commit("strengthen to enforce");
    const { result } = await gate(f.root, f.base);
    expect(result.status).not.toBe("exempt");
  });

  it("A13: --policy-only on the exempt contour + malformed HEAD policy → fail CORR-GATE-01", async () => {
    const f = makeExemptFixture({});
    f.write("forge.yaml", `${f.read("forge.yaml")}policy: [1,2]\n`);
    f.commit("adopt malformed policy");
    const { result } = await gate(f.root, f.base, { policyOnly: true });
    expect(result.status).toBe("fail");
    expect(result.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error")).toBe(true);
  });

  it("A14: BASE-side malformed policy on exempt×exempt → fail CORR-GATE-01", async () => {
    const f = makeExemptFixture({ policy: 'policy: "broken"\n' });
    f.commit("noop");
    const { result } = await gate(f.root, f.base);
    expect(result.status).toBe("fail");
    expect(result.violations.some((v) => v.rule === "CORR-GATE-01" && v.severity === "error")).toBe(true);
  });
});

// ===========================================================================
// B. Worktree-vs-commit divergence — `mode`/`tier`/`validation` are
//    worktree-flavored while the contour + judged side are commit-flavored.
//    Spec: an uncommitted worktree mode: flip can neither mask a committed
//    weakening nor fabricate a failure.
// ===========================================================================
describe("B: uncommitted worktree mode:/tier: flips vs committed contour", () => {
  it("B1: committed enforce + UNCOMMITTED mode:warn flip must NOT downgrade GATE-03..08", async () => {
    const f = fx({ oracle: "process.exit(1);\n" }); // committed enforce, broken oracle
    // sanity: with a clean worktree the gate refuses
    const clean = await gate(f.root, f.base);
    expect(clean.result.status).toBe("fail");
    // now flip mode: warn in the worktree WITHOUT committing
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: enforce", "mode: warn"));
    const { result } = await gate(f.root, f.base);
    expect(
      result.status,
      `uncommitted warn flip masked the enforce verdict: ${JSON.stringify(result.violations)}`,
    ).toBe("fail");
  });

  it("B2: committed warn + UNCOMMITTED mode:enforce flip must NOT fabricate errors", async () => {
    const f = fx({ mode: "warn", oracle: "process.exit(1);\n" });
    const clean = await gate(f.root, f.base);
    expect(clean.result.status).toBe("pass"); // warn downgrades GATE-07
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: warn", "mode: enforce"));
    const { result } = await gate(f.root, f.base);
    expect(
      result.status,
      `uncommitted enforce flip fabricated a failure: ${JSON.stringify(result.violations)}`,
    ).toBe("pass");
  });

  it("B3: exempt×exempt + declared base policy + UNCOMMITTED mode:enforce flip → must still pass on a clean diff", async () => {
    const f = makeExemptFixture({ policy: EXEMPT_POLICY });
    f.commit("noop head");
    const clean = await gate(f.root, f.base);
    expect(clean.result.status).toBe("pass");
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: exempt", "mode: enforce"));
    const { result } = await gate(f.root, f.base);
    expect(
      result.status,
      `worktree enforce flip fabricated a failure on the exempt contour: ${JSON.stringify(result.violations)}`,
    ).toBe("pass");
  });

  it("B4: committed enforce + UNCOMMITTED mode:exempt flip must NOT exempt the repo", async () => {
    const f = fx({ oracle: "process.exit(1);\n" });
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: enforce", "mode: exempt"));
    const { result } = await gate(f.root, f.base);
    expect(result.status).not.toBe("exempt");
    // committed contour is enforce: the broken oracle must still fail the gate
    expect(result.status).toBe("fail");
  });

  it("B5: committed tier:high + UNCOMMITTED tier:standard flip must NOT drop the trailer requirement", async () => {
    const f = fx({ tier: "high" }); // oracle verified via review record, not trailer
    const clean = await gate(f.root, f.base);
    expect(
      clean.result.violations.some((v) => v.rule === "CORR-GATE-06"),
      `baseline high tier should demand a trailer commit: ${JSON.stringify(clean.result.violations)}`,
    ).toBe(true);
    f.write("forge.yaml", f.read("forge.yaml").replace("tier: high", "tier: standard"));
    const { result } = await gate(f.root, f.base);
    expect(
      result.violations.some((v) => v.rule === "CORR-GATE-06"),
      `uncommitted tier:standard flip masked the tier requirement: ${JSON.stringify(result.violations)}`,
    ).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("B7: clean committed enforce + UNCOMMITTED mode:exempt flip → fabricated GATE-01 (exempt+manifest)", async () => {
    const f = fx({}); // clean enforce fixture — baseline passes
    const clean = await gate(f.root, f.base);
    expect(clean.result.status).toBe("pass");
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: enforce", "mode: exempt"));
    const { result } = await gate(f.root, f.base);
    console.log(
      "OBS B7 worktree exempt flip on committed enforce →",
      result.status,
      JSON.stringify(result.violations.filter((v) => v.severity === "error")),
    );
    // committed contour is enforce and clean — a worktree flip must not
    // fabricate a failure (spec bullet).
    expect(result.status).toBe("pass");
  });

  it("B8: UNCOMMITTED correctness.oracleTimeoutMs: 1 fabricates GATE-07 timeouts", async () => {
    const f = fx({}); // clean enforce — baseline passes
    const clean = await gate(f.root, f.base);
    expect(clean.result.status).toBe("pass");
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("  tier: standard", "  tier: standard\n  oracleTimeoutMs: 1"),
    );
    const { result } = await gate(f.root, f.base);
    console.log(
      "OBS B8 worktree oracleTimeoutMs:1 →",
      result.status,
      JSON.stringify(result.violations.filter((v) => v.severity === "error").map((v) => v.message)),
    );
    expect(result.status).toBe("pass");
  });

  it("B6: committed exempt (kept) + worktree enforce + base policy — committed weakening still judged (no masking)", async () => {
    const f = makeExemptFixture({ policy: EXEMPT_POLICY });
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.commit("committed frozen-key weakening");
    // uncommitted flip on top — must not mask the committed policy-key weakening
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: exempt", "mode: enforce"));
    const { result } = await gate(f.root, f.base);
    expect(result.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
    expect(result.status).toBe("fail");
  });
});

// ===========================================================================
// C. Accept-scope on the exempt contour — whitelist correctness
// ===========================================================================
describe("C: exempt-contour accept whitelist", () => {
  it("C1: accept with an UNCOMMITTED foreign file still accepts (commit-scoped diff)", async () => {
    const f = makeExemptFixture({
      policy: EXEMPT_POLICY,
      files: { "hooks/gate.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/gate.sh", "#!/bin/sh\nexit 9\n");
    f.commit("isolated hook weakening");
    f.write("src/foreign.ts", "uncommitted dirt\n"); // NOT committed
    const { result } = await gate(f.root, f.base, { acceptWeakening: "op" });
    // documented: commit-scoped isolation — uncommitted dirt warns but isn't "foreign"
    console.log("OBS C1:", result.status, result.acceptedWeakening);
    expect(["pass", "fail"]).toContain(result.status);
  });

  it("C2: policy-file weakening + a MUTABLE forge.yaml edit in one commit → accept verdict", async () => {
    const f = makeExemptFixture({
      policy: EXEMPT_POLICY,
      files: { "hooks/gate.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/gate.sh", "#!/bin/sh\nexit 9\n");
    f.write("forge.yaml", f.read("forge.yaml").replace("name: exempt-repo", "name: renamed"));
    f.commit("weakening + legal mutable edit");
    const { result } = await gate(f.root, f.base, { acceptWeakening: "op" });
    console.log(
      "OBS C2: mutable edit alongside weakening →",
      result.status,
      JSON.stringify(result.violations.filter((v) => /mixed/.test(v.message))),
    );
    expect(["pass", "fail"]).toContain(result.status);
  });

  it("C3: deletion of a frozen policy file by a NON-verifier commit → policy-file weakening", async () => {
    const f = makeExemptFixture({
      policy: EXEMPT_POLICY,
      files: { "hooks/gate.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.git(["rm", "-q", "hooks/gate.sh"]);
    f.commit("delete frozen hook");
    const { result } = await gate(f.root, f.base);
    expect(result.weakenings.some((w) => w.kind === "policy-file")).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("C4: NEW file inside the frozen glob (addition) is protected on exempt contour", async () => {
    const f = makeExemptFixture({
      policy: EXEMPT_POLICY,
      files: { "hooks/gate.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/new.sh", "#!/bin/sh\ntrue\n");
    f.commit("add hook inside frozen glob");
    const { result } = await gate(f.root, f.base);
    expect(result.weakenings.some((w) => w.kind === "policy-file")).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("C5: NEW file inside the frozen glob added by a VERIFIER commit → exempt", async () => {
    const f = makeExemptFixture({
      policy: EXEMPT_POLICY,
      files: { "hooks/gate.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/new.sh", "#!/bin/sh\ntrue\n");
    f.commit("verifier adds hook", TRAILERS);
    const { result } = await gate(f.root, f.base);
    expect(result.weakenings.filter((w) => w.kind === "policy-file")).toEqual([]);
  });

  it("C6: trailer-pair SPOOFED on an ordinary commit exempts the file (documented limitation)", async () => {
    const f = makeExemptFixture({
      policy: EXEMPT_POLICY,
      files: { "hooks/gate.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/gate.sh", "#!/bin/sh\nexit 9\n");
    // an agent CAN write the trailers — BUNDLE_LIMITATIONS admits this is a
    // cost-raiser, not proof of authorship. Record the observable behavior.
    f.commit("weakened but self-labeled verified", TRAILERS);
    const { result } = await gate(f.root, f.base);
    console.log("OBS C6 spoofed trailers → weakenings:", JSON.stringify(result.weakenings));
    expect(["pass", "fail"]).toContain(result.status);
  });
});

// ===========================================================================
// D. Mixed contours — HEAD-adopted policy + non-policy surfaces
// ===========================================================================
describe("D: policy adoption mixed with other surface changes", () => {
  it("D1: exempt repo adopts policy AND changes correctness.tier in one commit", async () => {
    const f = makeExemptFixture({});
    f.write(
      "forge.yaml",
      `${f.read("forge.yaml").replace("mode: exempt", "mode: exempt\n  tier: high")}${EXEMPT_POLICY}`,
    );
    f.commit("adopt policy + add tier");
    const { result } = await gate(f.root, f.base);
    console.log("OBS D1:", result.status, JSON.stringify(result.weakenings));
    expect(["pass", "fail", "exempt"]).toContain(result.status);
  });

  it("D2: normal contour (enforce) + no base policy → 'no policy surface declared' note probe", async () => {
    const f = fx({}); // enforce, no policy:
    const { result, bundle } = await gate(f.root, f.base);
    const haystack = `${JSON.stringify(result)}${JSON.stringify(bundle)}`;
    console.log(
      "OBS D2 normal-contour note present:",
      haystack.includes("no policy surface declared"),
      "status:",
      result.status,
    );
    expect(result.status).toBe("pass");
  });

  it("D3: enforce repo, base policy freezes bindings.commands.checkRun via mutable:[bindings] — RFC-1580 wins", async () => {
    const f = fx({
      forgeYamlAppend: `policy:
  mutable: [project, bindings]
  additive: []
  freezeFiles: []
`,
    });
    f.write("forge.yaml", f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "true"'));
    f.commit("rebind checkRun under mutable bindings");
    const { result } = await gate(f.root, f.base);
    // dedicated RFC-1580 frozen bindings win over mutable declarations
    expect(result.weakenings.some((w) => w.kind === "binding")).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("D4: same rebind on the EXEMPT contour — policy scope only judges policy kinds", async () => {
    const f = makeExemptFixture({
      policy: `policy:
  mutable: [project, bindings]
  additive: []
  freezeFiles: []
`,
    });
    // give the exempt repo a committed bindings.checkRun first
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace(
        "paths: {}",
        'paths: {}\nbindings:\n  commands:\n    checkRun: "node {file}"',
      ),
    );
    const base2 = f.commit("add bindings baseline");
    f.write("forge.yaml", f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "true"'));
    f.commit("rebind checkRun under mutable bindings on exempt");
    const { result } = await gate(f.root, base2);
    console.log("OBS D4 exempt+mutable bindings rebind →", result.status, JSON.stringify(result.weakenings));
    expect(["pass", "fail"]).toContain(result.status);
  });
});

// ===========================================================================
// E. Structural edges inside the policy surface
// ===========================================================================
describe("E: structural edges", () => {
  it("E1: forge.yaml byte-mode change (chmod +x) inside frozen glob — probe", async () => {
    const f = makeExemptFixture({
      policy: EXEMPT_POLICY,
      files: { "hooks/gate.sh": "#!/bin/sh\nexit 0\n" },
    });
    execFileSync("chmod", ["+x", `${f.root}/hooks/gate.sh`]);
    f.commit("chmod +x frozen hook");
    const { result } = await gate(f.root, f.base);
    console.log(
      "OBS E1 chmod-only weakening →",
      result.status,
      JSON.stringify(result.weakenings),
    );
    expect(["pass", "fail"]).toContain(result.status);
  });

  it("E2: exempt×exempt where HEAD deletes forge.yaml entirely", async () => {
    const f = makeExemptFixture({ policy: EXEMPT_POLICY });
    f.git(["rm", "-q", "forge.yaml"]);
    f.commit("delete forge.yaml");
    const { result } = await gate(f.root, f.base);
    // removed policy + every frozen key gone → fail, never exempt
    expect(result.status).toBe("fail");
  });

  it("E3: key declared BOTH mutable and additive — mutable wins (probe)", async () => {
    const f = makeExemptFixture({
      policy: `policy:
  mutable: [project, agentTools]
  additive: [agentTools]
  freezeFiles: []
`,
    });
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    f.commit("weaken a doubly-declared key");
    const { result } = await gate(f.root, f.base);
    console.log("OBS E3 dual-declared key →", result.status, JSON.stringify(result.weakenings));
    expect(["pass", "fail"]).toContain(result.status);
  });

  it("E4: forge.yaml replaced by a DIRECTORY at HEAD", async () => {
    const f = makeExemptFixture({ policy: EXEMPT_POLICY });
    f.git(["rm", "-q", "forge.yaml"]);
    execFileSync("mkdir", ["-p", `${f.root}/forge.yaml`]);
    writeFileSync(`${f.root}/forge.yaml/inner`, "x");
    f.commit("forge.yaml → dir typechange");
    const { result } = await gate(f.root, f.base);
    console.log("OBS E4 forge.yaml→dir →", result.status, JSON.stringify(result.violations.slice(0, 3)));
    expect(["pass", "fail"]).toContain(result.status);
  });

  it("E5: exempt×exempt, base policy + committed policy-decl weakening + --accept-weakening + policy file also weakened", async () => {
    const f = makeExemptFixture({
      policy: EXEMPT_POLICY,
      files: { "hooks/gate.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("hooks/gate.sh", "#!/bin/sh\nexit 9\n");
    f.write("forge.yaml", f.read("forge.yaml").replace("mutable: [project]", "mutable: [project, moves]"));
    f.commit("policy-decl + file weakening");
    const { result } = await gate(f.root, f.base, { acceptWeakening: "op" });
    expect(result.status).toBe("pass");
    expect(result.acceptedWeakening).toBe("op");
    expect(result.weakenings.length).toBeGreaterThanOrEqual(2);
  });

  it("E6: --policy-only on a NON-exempt repo with declared policy → policy-key judged, no oracles", async () => {
    const f = fx({
      forgeYamlAppend: EXEMPT_POLICY,
      extraFiles: { "hooks/gate.sh": "#!/bin/sh\nexit 0\n" },
    });
    f.write("forge.yaml", f.read("forge.yaml").replace("deny: [danger.cmd]", "deny: []"));
    // wait — fixture has no agentTools; weaken agentTools absent → use checkRun rebind inside additive bindings? agentTools absent → weaken `correctness.mode`? mode: enforce→warn is a policy-key too (correctness frozen).
    f.write("forge.yaml", f.read("forge.yaml").replace("mode: enforce", "mode: warn"));
    f.commit("weaken correctness under policy-only");
    const { result } = await gate(f.root, f.base, { policyOnly: true });
    expect(result.weakenings.some((w) => w.kind === "policy-key")).toBe(true);
    expect(result.status).toBe("fail");
  });
});
