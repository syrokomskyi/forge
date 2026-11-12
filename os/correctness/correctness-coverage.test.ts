/*
<MODULE_CONTRACT>
<purpose>RFC-1578 AC-3: CORR-08 requirement/DNA coverage — a silent requirement id is an error in enforce and a warning in warn; anchored and exempted ids count separately.</purpose>
<non-goals>
  <item>Not a contract source of truth — the handler owns behaviour; fixtures are minimal.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1578: initial suite.</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
</CHANGE_SUMMARY>
*/

import { afterEach, describe, expect, it } from "vitest";

import { validateCorrectnessManifest } from "./handlers/validate.ts";
import { BASE_MANIFEST, makeWorkspace } from "./tests/fixture-workspace.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const ws = (opts: Parameters<typeof makeWorkspace>[0]) => {
  const w = makeWorkspace(opts);
  cleanups.push(w.cleanup);
  return w.root;
};

describe("CORR-08 coverage", () => {
  it("AC-3: enforce mode reports a silent requirement id as a CORR-08 error", async () => {
    const root = ws({ mode: "enforce", requirements: ["REQ-01", "REQ-05"] });
    const res = await validateCorrectnessManifest(root);
    const v = res.violations.find((x) => x.rule === "CORR-08" && x.ref === "REQ-05");
    expect(v, "REQ-05 has no entry and no exemption — CORR-08 must name it").toBeDefined();
    expect(v!.severity).toBe("error");
    expect(res.status).toBe("fail");
    expect(res.coverage.req).toEqual({ total: 2, anchored: 1, exempt: 0, silent: 1 });
  });

  it("warn mode reports the same silence as a warning and passes", async () => {
    const root = ws({ mode: "warn", requirements: ["REQ-01", "REQ-05"] });
    const res = await validateCorrectnessManifest(root);
    expect(res.violations.find((x) => x.ref === "REQ-05")!.severity).toBe("warning");
    expect(res.status).toBe("pass");
  });

  it("exemptions cover requirement and DNA ids", async () => {
    const manifest = `${BASE_MANIFEST.replace("exemptions: []\n", "")}exemptions:
  - ref: REQ-05
    kind: deferred
    task: "verbund:T-0001"
  - ref: DNA-3
    kind: unverifiable
    reason: "platform-side"
`;
    const root = ws({ mode: "enforce", requirements: ["REQ-01", "REQ-05"], dna: [3], manifest });
    const res = await validateCorrectnessManifest(root);
    expect(res.violations.filter((x) => x.rule === "CORR-08")).toEqual([]);
    expect(res.coverage.req.exempt).toBe(1);
    expect(res.coverage.dna).toEqual({ total: 1, anchored: 0, exempt: 1, silent: 0 });
  });

  it("a missing requirements document reports req.total 0 and a CORR-08 warning", async () => {
    const root = ws({ mode: "enforce", files: { "docs/requirements.xml": "<other/>\n" } });
    const res = await validateCorrectnessManifest(root);
    expect(res.coverage.req.total).toBe(0);
    const v = res.violations.find(
      (x) => x.rule === "CORR-08" && /requirements document/.test(x.message),
    );
    expect(v?.severity).toBe("warning");
  });

  it("CORR-09: malformed exemptions are errors", async () => {
    const manifest = `${BASE_MANIFEST.replace("exemptions: []\n", "")}exemptions:
  - ref: REQ-01
    kind: deferred
  - ref: NOPE-1
    kind: unverifiable
`;
    const res = await validateCorrectnessManifest(ws({ manifest }));
    const rules = res.violations.filter((x) => x.rule === "CORR-09").map((x) => x.message);
    expect(rules.some((m) => /deferred needs a task/.test(m))).toBe(true);
    expect(rules.some((m) => /unverifiable needs a reason/.test(m))).toBe(true);
    expect(rules.some((m) => /NOPE-1 resolves to no/.test(m))).toBe(true);
  });
});
