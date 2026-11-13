/*
<MODULE_CONTRACT>
<purpose>RFC-1580 review REVIEW-CODE-2026-11-13-05 regressions — every frozen
item has a weakening test (captures, unreadable base manifest, source and
statement, mode, allow-list, tier, deferred exemptions, new support files);
L3 on data seams needs an attestation; anchor events must be verified on the
attested handle; isolated sessions may touch anchor files but not unrelated
forge.yaml keys; a dirty worktree warns.</purpose>
<non-goals>
  <item>Not a contract source of truth — gate/run.ts owns behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: review regressions.</item>
  <item>RFC-1580: close review REVIEW-CODE-2026-11-13-05 findings

N1 bootstrap degrade only while the base has not adopted the contour (a forge downgrade refuses); N2 L3 on data/lifecycle counts at its attested level; N3 anchor events bound to the attested handle; N4 new support-glob files are frozen additions; N5/N6 isolated sessions may touch anchor files and only frozen forge.yaml keys; N7 RFC body amended; N8 regression tests; N9 run root in finally and grandchildren reaped; N10 every declared capture loaded. DEV-7 recorded; DEV-5 narrowed pending operator confirmation.</item>
</CHANGE_SUMMARY>
*/

import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessGate } from "./run.ts";
import {
  HELPERS,
  L1_ORACLE,
  ORACLE_PATH,
  makeGateFixture,
  manifestYaml,
  reviewYaml,
  verifierCommit,
  type GateFixture,
} from "./tests/gate-fixture.ts";

const fixtures: GateFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const fx = (o: Parameters<typeof makeGateFixture>[0] = {}) => {
  const f = makeGateFixture(o);
  fixtures.push(f);
  return f;
};
const gate = async (f: GateFixture, base = f.base, acceptWeakening?: string) => {
  const out = await runCorrectnessGate(f.root, {
    base,
    bundleDir: `${f.root}/.bundles`,
    acceptWeakening,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
};
const weak = (r: { violations: { rule: string; message: string }[] }) =>
  r.violations.filter((v) => v.rule === "CORR-GATE-02").map((v) => v.message);
const head = (f: GateFixture) => f.git(["rev-parse", "HEAD"]);

describe("frozen-set coverage", () => {
  it("each frozen config item is a weakening when weakened", async () => {
    const f = fx({ mode: "enforce", tier: "high" });
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("mode: enforce", "mode: warn")
        .replace("tier: high", "tier: standard") +
        "  audit:\n    allow:\n      - check: ledger.orphans\n        subject: events\n        reason: x\n",
    );
    f.write(
      "docs/correctness.yaml",
      manifestYaml({})
        .replace("source: req\n    ref: REQ-01", 'source: domain\n    statement: "x"')
        .replace(
          "exemptions: []",
          'exemptions:\n  - ref: REQ-01\n    kind: deferred\n    task: "verbund:T-1"',
        ),
    );
    f.commit("weaken many things");
    const m = weak(await gate(f));
    for (const re of [
      /mode changed from enforce to warn/,
      /tier lowered from high to standard/,
      /allow\[\] gained/,
      /source changed from req to domain/,
      /ref changed/,
      /deferred exemption added for REQ-01/,
    ]) {
      expect(
        m.some((x) => re.test(x)),
        `missing ${re}`,
      ).toBe(true);
    }
  });

  it("a dropped capture is a weakening", async () => {
    const cap = "test/captures/a.json";
    const g = fx({ review: false });
    g.write(cap, "{}");
    g.write(
      `${cap}.capture.yaml`,
      `schema: forge/correctness-capture@1\nrecordedAt: ${new Date().toISOString()}\nprovider: p\nmodel: m\nttlDays: 30\norigin: o\n`,
    );
    g.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("substrate: L1", `substrate: L1\n        captures: [${cap}]`),
    );
    g.commit("with capture");
    const base = head(g);
    g.write("docs/correctness.yaml", manifestYaml({}));
    g.commit("drop capture");
    expect(weak(await gate(g, base)).some((x) => /dropped capture/.test(x))).toBe(true);
  });

  it("an unreadable base manifest refuses instead of freezing nothing", async () => {
    const f = fx();
    f.write("docs/correctness.yaml", "schema: forge/correctness-manifest@9\nentries: []\n");
    f.commit("break the manifest");
    const base = head(f);
    f.write("docs/correctness.yaml", manifestYaml({}));
    f.commit("repair");
    expect(weak(await gate(f, base)).some((x) => /does not parse/.test(x))).toBe(true);
  });

  it("a new file matching a frozen support glob is a weakening", async () => {
    const g = fx({ review: false });
    g.write("test/harness/setup.ts", "// harness\n");
    g.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("support: []", "support: [test/harness/**]"),
    );
    g.commit("support glob");
    const base = head(g);
    g.write("test/harness/extra.ts", "// passWithNoTests\n");
    g.commit("add harness file");
    expect(
      weak(await gate(g, base)).some((x) =>
        /new file test\/harness\/extra.ts matches a frozen support glob/.test(x),
      ),
    ).toBe(true);
  });

  it("a dirty worktree is a CORR-GATE-01 warning", async () => {
    const f = fx();
    f.write("apps/api/src/dispatch.ts", `${f.read("apps/api/src/dispatch.ts")}// local edit\n`);
    const r = await gate(f);
    expect(
      r.violations.some(
        (v) =>
          v.rule === "CORR-GATE-01" && v.severity === "warning" && /uncommitted/.test(v.message),
      ),
    ).toBe(true);
  });
});

describe("evidence binding", () => {
  it("L3 with honest captures on a data seam still needs a matching schema attestation", async () => {
    const cap = "test/captures/a.json";
    const oracle = `import { loadCapture } from ${JSON.stringify(HELPERS)};\nloadCapture(${JSON.stringify(cap)});\n`;
    const g = fx({ review: false, oracle });
    g.write(cap, "{}");
    g.write(
      `${cap}.capture.yaml`,
      `schema: forge/correctness-capture@1\nrecordedAt: ${new Date().toISOString()}\nprovider: p\nmodel: m\nttlDays: 30\norigin: o\n`,
    );
    g.write(
      "docs/correctness.yaml",
      manifestYaml({}).replace("substrate: L1", `substrate: L3\n        captures: [${cap}]`),
    );
    g.commit("declare L3 with a capture");
    const rel = "docs/correctness/reviews/r.yaml";
    g.write(rel, reviewYaml([{ check: `test:${ORACLE_PATH}`, content: oracle }]));
    verifierCommit(g.git, rel);
    const r = await gate(g, head(g));
    expect(
      r.violations.some(
        (v) => v.rule === "CORR-GATE-04" && /declares L3 on a data seam/.test(v.message),
      ),
      JSON.stringify(r.violations),
    ).toBe(true);
    expect(r.violations.map((v) => v.rule)).toContain("CORR-GATE-08");
  });

  it("anchor events verified against a second database do not count", async () => {
    const oracle = `import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { attestSubstrate, verifyAnchorEvents } from ${JSON.stringify(HELPERS)};
const real = new DatabaseSync(":memory:");
real.exec(readFileSync("apps/api/migrations/0001_init.sql", "utf8"));
attestSubstrate(real, { level: "L2", engine: "node:sqlite" });
const seeded = new DatabaseSync(":memory:");
seeded.exec("CREATE TABLE candidates (id TEXT PRIMARY KEY, state TEXT NOT NULL, extra TEXT)");
seeded.prepare("INSERT INTO candidates (id, state) VALUES (?, ?)").run("c_1", "queued");
verifyAnchorEvents([JSON.stringify({ "forge.anchor": "INV-dispatch-01", ref: { table: "candidates", key: { id: "c_1" }, column: "state", value: "queued" } })], seeded);
`;
    const r = await gate(fx({ seam: "lifecycle", substrate: "L2", oracle }));
    expect(
      r.violations.some(
        (v) => v.rule === "CORR-GATE-05" && /other than the attested handle/.test(v.message),
      ),
    ).toBe(true);
  });
});

describe("isolated weakening sessions", () => {
  it("an anchor rewording alone can be accepted; an unrelated forge.yaml key makes it mixed", async () => {
    const f = fx();
    f.write(
      "apps/api/src/dispatch.ts",
      f.read("apps/api/src/dispatch.ts").replace("exactly once", "once per target"),
    );
    f.commit("reword the anchor");
    const ok = await gate(f, f.base, "operator: requirement rephrased");
    expect(ok.acceptedWeakening).toBe("operator: requirement rephrased");
    f.write("forge.yaml", f.read("forge.yaml").replace("name: gate-fixture", "name: renamed"));
    f.commit("rename project");
    const mixed = await gate(f, f.base, "operator: requirement rephrased");
    expect(weak(mixed).some((x) => /mixed-weakening/.test(x))).toBe(true);
  });
});

void L1_ORACLE;
