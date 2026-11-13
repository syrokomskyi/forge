/*
<MODULE_CONTRACT>
<purpose>RFC-1580 review REVIEW-CODE-2026-11-13-04 regressions — rebinding an
oracle (the RFC-1571 AC-7 shape) is a weakening, a declared L3 without
captures never covers, a substrate raise is a weakening, a reworded or
duplicated anchor is caught, requirement origin needs an acceptance that
predates the base, and an oracle timeout is CORR-GATE-07.</purpose>
<non-goals>
  <item>Not a contract source of truth — gate/run.ts owns behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: review regressions.</item>
  <item>RFC-1580: close review REVIEW-CODE-2026-11-13-04 findings

F1 bootstrap degrade only on an exact unknown-command stderr line with no JSON; F2 review records count only from a verifier-trailer commit naming them; F3 any frozen substrate change or dropped capture is a weakening, declared L3 needs loaded captures; F4 requirement origin needs acceptance before --base; F5 anchor events only for L2+ runs; F6 proof oracles via proof.check only, non-self; F7 bundle naming; F8/F9 limitations; F10 every anchor copy; F11 base entry refs; F12 unreadable base manifest refuses; F13 dirty worktree warning; F14 source/statement diffs; F15 process-group kill; F16 run root cleanup; F20 review dir stripped, blob hashes. Regression tests for spoofing, plain-commit review, L3, requirement origin, rewording, timeout, formal tier, rebind, real-gate pass, accept-weakening. DEV-1..DEV-6 recorded in the RFC.</item>
</CHANGE_SUMMARY>
*/

import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessGate } from "./run.ts";
import {
  L1_ORACLE,
  ORACLE_PATH,
  makeGateFixture,
  manifestYaml,
  type GateFixture,
} from "./tests/gate-fixture.ts";

const fixtures: GateFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const fx = (o: Parameters<typeof makeGateFixture>[0] = {}) => {
  const f = makeGateFixture(o);
  fixtures.push(f);
  return f;
};
const gate = async (f: GateFixture) => {
  const out = await runCorrectnessGate(f.root, { base: f.base, bundleDir: `${f.root}/.bundles` });
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
};
const msgs = (r: { violations: { rule: string; message: string }[] }, rule: string) =>
  r.violations.filter((v) => v.rule === rule).map((v) => v.message);
const MARK = "@ai-" + "invariant";

describe("gate hardening", () => {
  it("rebinding a frozen oracle to an easier test is refused as a weakening (RFC-1571 AC-7 shape)", async () => {
    const f = fx();
    f.write("test/easier.oracle.ts", "// always green\n");
    f.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace(`check: test:${ORACLE_PATH}`, "check: test:test/easier.oracle.ts"),
    );
    f.write(
      "apps/api/src/dispatch.ts",
      f.read("apps/api/src/dispatch.ts").replace(ORACLE_PATH, "test/easier.oracle.ts"),
    );
    f.commit("rebind the oracle");
    const r = await gate(f);
    expect(msgs(r, "CORR-GATE-02").some((m) => /lost \(or rebound\) oracle/.test(m))).toBe(true);
    expect(r.status).toBe("fail");
  });

  it("raising a frozen oracle's substrate is a weakening", async () => {
    const f = fx();
    f.write(
      "docs/correctness.yaml",
      manifestYaml({ substrate: "L1" }).replace("substrate: L1", "substrate: L3"),
    );
    f.commit("over-declare");
    expect(
      msgs(await gate(f), "CORR-GATE-02").some((m) => /substrate changed from L1 to L3/.test(m)),
    ).toBe(true);
  });

  it("a declared L3 without captures never covers (counted as L0)", async () => {
    // The base already declares L3 — no weakening involved, only the claim.
    const g = fx({ oracle: "// asserts nothing on any handle\n" });
    g.write("docs/correctness.yaml", manifestYaml({}).replace("substrate: L1", "substrate: L3"));
    g.git(["add", "-A"]);
    g.git(["commit", "-qm", "declare L3"]);
    const out = await runCorrectnessGate(g.root, {
      base: g.git(["rev-parse", "HEAD"]),
      bundleDir: `${g.root}/.bundles`,
    });
    if (!out.ok) throw new Error(out.usageError);
    expect(
      msgs(out.result, "CORR-GATE-04").some((m) => /declares L3 without captures/.test(m)),
    ).toBe(true);
    expect(out.result.violations.map((v) => v.rule)).toContain("CORR-GATE-08");
  });

  it("a reworded anchor and a duplicate copy keeping the old text are both caught", async () => {
    const f = fx();
    const original = f.read("apps/api/src/dispatch.ts");
    f.write(
      "apps/api/src/dispatch.ts",
      original.replace("exactly once", "at least once") +
        `// ${MARK}[INV-dispatch-01]: dispatch moves an approved candidate to queued exactly once\n//   (checked-by: test:${ORACLE_PATH})\n`,
    );
    f.commit("reword the anchor, keep a decoy copy");
    expect(
      msgs(await gate(f), "CORR-GATE-02").some((m) => /INV-dispatch-01 statement changed/.test(m)),
    ).toBe(true);
  });

  it("requirement origin needs an RFC accepted before the integration base", async () => {
    const rfc = (status: string) =>
      `---\nid: RFC-0005\ntitle: "x"\nstatus: ${status}\n---\n\n# RFC-0005\n\n## Acceptance criteria\n\n- [ ] AC-3: THE dispatch SHALL queue (evidence: probe:AC-3)\n`;
    const entry = `  - id: CM-lifecycle-01\n    source: rfc-ac\n    ref: RFC-0005/AC-3\n    seam: data\n    anchors: [INV-dispatch-01]\n    oracles:\n      - check: test:test/req.oracle.ts\n        substrate: L1\n`;
    const anchorWith = (f: GateFixture) =>
      f.write(
        "apps/api/src/dispatch.ts",
        f
          .read("apps/api/src/dispatch.ts")
          .replace(
            `(checked-by: test:${ORACLE_PATH})`,
            `(checked-by: test:${ORACLE_PATH}, test:test/req.oracle.ts)`,
          ),
      );

    // Accepted on develop first, oracle written afterwards and unchanged since acceptance → requirement.
    const early = fx();
    early.write("docs/rfcs/rfc-0005-dispatch.md", rfc("draft"));
    early.git(["add", "-A"]);
    early.git(["commit", "-qm", "draft"]);
    early.write("test/req.oracle.ts", L1_ORACLE);
    early.write("docs/rfcs/rfc-0005-dispatch.md", rfc("accepted"));
    early.git(["add", "-A"]);
    early.git(["commit", "-qm", "accept with oracle"]);
    const base = early.git(["rev-parse", "HEAD"]);
    anchorWith(early);
    early.write("docs/correctness.yaml", manifestYaml({}, entry));
    early.commit("add the entry");
    const ok = await runCorrectnessGate(early.root, { base, bundleDir: `${early.root}/.bundles` });
    if (!ok.ok) throw new Error(ok.usageError);
    expect(ok.result.violations.filter((v) => v.rule === "CORR-GATE-03")).toEqual([]);

    // Accepted inside the session together with its test → self.
    const late = fx();
    late.write("test/req.oracle.ts", L1_ORACLE);
    late.write("docs/rfcs/rfc-0005-dispatch.md", rfc("accepted"));
    anchorWith(late);
    late.write("docs/correctness.yaml", manifestYaml({}, entry));
    late.commit("accept, test, and entry in one session");
    expect(
      (await gate(late)).violations.some(
        (v) => v.rule === "CORR-GATE-03" && v.entry === "CM-lifecycle-01",
      ),
    ).toBe(true);
  });

  it("an oracle that outlives its timeout is CORR-GATE-07 with the timeout class", async () => {
    const f = fx({ oracle: "setTimeout(() => {}, 60000);\n" });
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("  tier: standard\n", "  tier: standard\n  oracleTimeoutMs: 500\n"),
    );
    f.git(["add", "-A"]);
    f.git(["commit", "-qm", "short timeout"]);
    const out = await runCorrectnessGate(f.root, {
      base: f.git(["rev-parse", "HEAD"]),
      bundleDir: `${f.root}/.bundles`,
    });
    if (!out.ok) throw new Error(out.usageError);
    expect(
      msgs(out.result, "CORR-GATE-07").some((m) =>
        /timed out after 500ms \(timeout class\)/.test(m),
      ),
    ).toBe(true);
  }, 30_000);
});
