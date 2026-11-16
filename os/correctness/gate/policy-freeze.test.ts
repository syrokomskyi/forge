/*
<MODULE_CONTRACT>
<purpose>RFC-1615: the declared `policy:` surface is judged by
correctness.gate — policy-key/policy-decl/policy-file weakenings,
deny-by-default, additive leaf semantics, self-freezing, the isolated
accept path, inert without a base declaration, and --policy-only.</purpose>
<non-goals>
  <item>Not a contract source of truth — gate/run.ts owns behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1615: initial suite.</item>
  <item>RFC-1615: declare and freeze the policy surface at integration</item>
</CHANGE_SUMMARY>
*/

import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessGate } from "./run.ts";
import { makeGateFixture, type GateFixture } from "./tests/gate-fixture.ts";

const POLICY = `policy:
  mutable: [project]
  additive: [bindings, loopMetrics]
  freezeFiles:
    - "hooks/**"
`;

const fixtures: GateFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const fx = (o: Parameters<typeof makeGateFixture>[0] = {}) => {
  const f = makeGateFixture({
    extraFiles: { "hooks/pre-commit.sh": "#!/bin/sh\nexit 0\n" },
    ...o,
    forgeYamlAppend: `${o.forgeYamlAppend ?? ""}${POLICY}agentTools:\n  deny: [deploy]\n`,
  });
  fixtures.push(f);
  return f;
};
const gate = async (f: GateFixture, opts: { accept?: string; policyOnly?: boolean } = {}) => {
  const out = await runCorrectnessGate(f.root, {
    base: f.base,
    bundleDir: `${f.root}/.bundles`,
    acceptWeakening: opts.accept,
    policyOnly: opts.policyOnly,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
};
const kinds = (r: { weakenings: { kind: string }[] }) => r.weakenings.map((w) => w.kind);

const forgeYamlEdit = (f: GateFixture, find: string, replace: string) => {
  const doc = f.read("forge.yaml");
  if (!doc.includes(find)) throw new Error(`fixture forge.yaml lacks ${JSON.stringify(find)}`);
  f.write("forge.yaml", doc.replace(find, replace));
};

describe("policy freeze (RFC-1615)", () => {
  it("AC-1: an undeclared top-level key change is a policy-key weakening and refuses", async () => {
    const f = fx();
    forgeYamlEdit(f, "deny: [deploy]", "deny: []");
    f.commit("drop the deny list");
    const r = await gate(f);
    expect(kinds(r), "agentTools is undeclared — frozen by default").toContain("policy-key");
    expect(r.violations.some((v) => v.rule === "CORR-GATE-02" && v.severity === "error")).toBe(
      true,
    );
    expect(r.status).toBe("fail");
  });

  it("AC-2: new leaves under an additive key pass; changed or removed leaves refuse", async () => {
    const f = fx();
    forgeYamlEdit(
      f,
      'verify: "node scripts/verify.mjs"',
      'verify: "node scripts/verify.mjs"\n    extraCheck: "node scripts/extra.mjs"',
    );
    f.commit("add a binding leaf");
    expect(kinds(await gate(f))).not.toContain("policy-key");

    const g = fx();
    forgeYamlEdit(g, 'checkRun: "node {file}"', 'checkRun: "node --loose {file}"');
    g.commit("change a binding leaf");
    // bindings.commands.checkRun keeps its dedicated RFC-1580 `binding`
    // weakening; the additive leaf change is judged as policy-key too.
    const rg = await gate(g);
    expect(kinds(rg)).toContain("binding");
    expect(rg.status).toBe("fail");

    const h = fx();
    forgeYamlEdit(h, 'verify: "node scripts/verify.mjs"\n', "");
    h.commit("remove a binding leaf");
    const rh = await gate(h);
    expect(kinds(rh), "a removed leaf under an additive key is a weakening").toContain(
      "policy-key",
    );
    expect(rh.status).toBe("fail");
  });

  it("AC-3: editing the policy: declaration itself is a policy-decl weakening", async () => {
    const f = fx();
    forgeYamlEdit(f, "mutable: [project]", "mutable: [project, agentTools]");
    f.commit("expand my own permissions");
    const r = await gate(f);
    expect(kinds(r)).toContain("policy-decl");
    expect(r.status).toBe("fail");
  });

  it("AC-4: policy.freezeFiles byte changes, deletes, and glob additions refuse", async () => {
    const f = fx();
    f.write("hooks/pre-commit.sh", "#!/bin/sh\nexit 1\n");
    f.commit("edit a hook");
    const r = await gate(f);
    expect(kinds(r)).toContain("policy-file");
    expect(r.status).toBe("fail");

    const g = fx();
    g.git(["rm", "-q", "hooks/pre-commit.sh"]);
    g.commit("delete a hook");
    expect(kinds(await gate(g))).toContain("policy-file");

    const h = fx();
    h.write("hooks/new-gate.sh", "#!/bin/sh\nexit 0\n");
    h.commit("add a hook");
    expect(kinds(await gate(h))).toContain("policy-file");
  });

  it("AC-5: a new undeclared top-level key is a policy-key weakening", async () => {
    const f = fx();
    f.write("forge.yaml", `${f.read("forge.yaml")}experimental:\n  flag: true\n`);
    f.commit("add a top-level key");
    const r = await gate(f);
    expect(kinds(r)).toContain("policy-key");
    expect(r.weakenings.find((w) => w.kind === "policy-key")?.subject).toBe("experimental");
  });

  it("AC-6: mutable keys change freely and an isolated weakening session is accepted", async () => {
    const f = fx();
    forgeYamlEdit(f, "name: gate-fixture", "name: renamed-project");
    f.commit("rename the project");
    expect(kinds(await gate(f))).toHaveLength(0);

    const g = fx();
    forgeYamlEdit(g, "deny: [deploy]", "deny: []");
    g.commit("weaken the deny list");
    const accepted = await gate(g, { accept: "operator asked for a narrower deny list" });
    expect(accepted.acceptedWeakening).toBe("operator asked for a narrower deny list");
    expect(accepted.weakenings.every((w) => w.accepted)).toBe(true);

    const h = fx();
    forgeYamlEdit(h, "deny: [deploy]", "deny: []");
    h.write("src/feature.ts", "export const feature = 1;\n");
    h.commit("weaken and ship code");
    const mixed = await gate(h, { accept: "still must refuse" });
    expect(
      mixed.violations.some((v) => /mixed-weakening/.test(v.message)),
      "a weakening mixed with foreign paths is not isolated",
    ).toBe(true);
    expect(mixed.status).toBe("fail");
  });

  it("AC-7: an absent policy: leaves the policy checks inert; a malformed one denies", async () => {
    const noPolicy = makeGateFixture({
      extraFiles: { "hooks/pre-commit.sh": "#!/bin/sh\nexit 0\n" },
      forgeYamlAppend: "agentTools:\n  deny: [deploy]\n",
    });
    fixtures.push(noPolicy);
    forgeYamlEdit(noPolicy, "deny: [deploy]", "deny: []");
    noPolicy.commit("change an undeclared key");
    const inert = await gate(noPolicy);
    expect(kinds(inert), "no policy at base — no policy judgement").not.toContain("policy-key");
    expect(kinds(inert)).not.toContain("policy-decl");

    const malformed = makeGateFixture({
      forgeYamlAppend: 'policy: "not-a-map"\nagentTools:\n  deny: [deploy]\n',
    });
    fixtures.push(malformed);
    forgeYamlEdit(malformed, "deny: [deploy]", "deny: []");
    malformed.commit("change a key under a malformed policy");
    const denied = await gate(malformed);
    expect(
      kinds(denied),
      "a malformed policy declares nothing — everything stays frozen",
    ).toContain("policy-key");
  });

  it("AC-8: --policy-only judges only the policy surface", async () => {
    const f = fx();
    forgeYamlEdit(f, "deny: [deploy]", "deny: []");
    // A manifest weakening the full gate would catch — policy-only must ignore it.
    f.write(
      "docs/correctness.yaml",
      "schema: forge/correctness-manifest@1\nentries: []\nsupport: []\nexemptions: []\n",
    );
    f.commit("weaken policy and drop the manifest entry");
    const r = await gate(f, { policyOnly: true });
    expect(kinds(r)).toEqual(["policy-key"]);
    expect(r.status).toBe("fail");

    const clean = fx();
    forgeYamlEdit(clean, "name: gate-fixture", "name: renamed-project");
    clean.write("apps/api/src/dispatch.ts", "export function dispatch(): void {}\n");
    clean.commit("permitted change plus code");
    const pass = await gate(clean, { policyOnly: true });
    expect(kinds(pass)).toHaveLength(0);
    expect(pass.status).toBe("pass");
  });
});
