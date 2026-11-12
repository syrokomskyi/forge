/*
<MODULE_CONTRACT>
<purpose>RFC-1578 AC-7: the anchor chain — CORR-05 oracle must be named by an anchor's checked-by; CORR-04 anchors must exist and be bound; CORR-03 refs resolve; CORR-02 shape.</purpose>
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
import { BASE_MANIFEST, MARKER, makeWorkspace } from "./tests/fixture-workspace.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const run = async (opts: Parameters<typeof makeWorkspace>[0]) => {
  const w = makeWorkspace(opts);
  cleanups.push(w.cleanup);
  return validateCorrectnessManifest(w.root);
};

const RFC = `---
id: RFC-0005
status: accepted
---

# RFC-0005

## Fixed inputs

| ID | Value | Source | Checked by |
| --- | --- | --- | --- |
| FI-1 | \`x\` | grilling | AC-1 |

## Acceptance criteria

- [ ] AC-3: THE dispatch SHALL write send_ready (evidence: probe:AC-3)
`;

describe("anchor chain", () => {
  it("AC-7: an oracle absent from every anchor's checked-by is a CORR-05 error", async () => {
    const res = await run({
      manifest: BASE_MANIFEST.replace(
        "check: test:src/dispatch.schema.test.ts",
        "check: test:src/other.test.ts",
      ),
    });
    const v = res.violations.find((x) => x.rule === "CORR-05");
    expect(v, "the manifest must not name a check the invariant does not bind").toBeDefined();
    expect(v!.severity).toBe("error");
    expect(v!.message).toMatch(/src\/other.test.ts/);
  });

  it("path spellings normalize before comparison", async () => {
    const res = await run({
      manifest: BASE_MANIFEST.replace(
        "check: test:src/dispatch.schema.test.ts",
        "check: test:./src/dispatch.schema.test.ts",
      ),
    });
    expect(res.violations.filter((x) => x.rule === "CORR-05")).toEqual([]);
  });

  it("a check kind outside the RFC-1390 set fails CORR-05", async () => {
    const res = await run({
      manifest: BASE_MANIFEST.replace(
        "check: test:src/dispatch.schema.test.ts",
        "check: script:run.sh",
      ),
    });
    expect(res.violations.find((x) => x.rule === "CORR-05")?.message).toMatch(
      /not an RFC-1390 binding/,
    );
  });

  it("CORR-04: an undeclared anchor and an unbound anchor are errors", async () => {
    const undeclared = await run({
      manifest: BASE_MANIFEST.replace("anchors: [INV-dispatch-01]", "anchors: [INV-missing-01]"),
    });
    expect(undeclared.violations.find((x) => x.rule === "CORR-04")?.message).toMatch(
      /INV-missing-01 is declared by no/,
    );
    const unbound = await run({
      manifest: BASE_MANIFEST.replace("anchors: [INV-dispatch-01]", "anchors: [INV-dispatch-02]"),
      files: {
        "src/extra.ts": `// ${MARKER}[INV-dispatch-02]: dispatch never sends two openers to one target\nexport {};\n`,
      },
    });
    expect(unbound.violations.find((x) => x.rule === "CORR-04")?.message).toMatch(
      /no checked-by binding/,
    );
  });

  it("CORR-03: unresolved requirement, DNA, and RFC refs are errors; resolved ones pass", async () => {
    const bad = await run({ manifest: BASE_MANIFEST.replace("ref: REQ-01", "ref: REQ-99") });
    expect(bad.violations.find((x) => x.rule === "CORR-03")?.message).toMatch(
      /REQ-99 is not declared/,
    );
    const rfcAc = await run({
      manifest: BASE_MANIFEST.replace(
        "source: req\n    ref: REQ-01",
        "source: rfc-ac\n    ref: RFC-0005/AC-3",
      ),
      files: { "docs/rfcs/archive/rfc-0005-dispatch.md": RFC },
    });
    expect(rfcAc.violations.filter((x) => x.rule === "CORR-03")).toEqual([]);
    const fi = await run({
      manifest: BASE_MANIFEST.replace(
        "source: req\n    ref: REQ-01",
        "source: fixed-input\n    ref: RFC-0005/FI-2",
      ),
      files: { "docs/rfcs/rfc-0005-dispatch.md": RFC },
    });
    expect(fi.violations.find((x) => x.rule === "CORR-03")?.message).toMatch(/declares no FI-2/);
  });

  it("CORR-02: bad entry ids, duplicates, a domain entry without statement, and dead support globs", async () => {
    const manifest = BASE_MANIFEST.replace("id: CM-dispatch-01", "id: CORR-dispatch-1")
      .replace("source: req\n    ref: REQ-01", "source: domain")
      .replace("support: []", "support: [harness/**]");
    const res = await run({ manifest });
    const msgs = res.violations.filter((x) => x.rule === "CORR-02").map((x) => x.message);
    expect(msgs.some((m) => /does not match CM-/.test(m))).toBe(true);
    expect(msgs.some((m) => /domain entry needs a statement/.test(m))).toBe(true);
    expect(msgs.some((m) => /support glob "harness\/\*\*" matches no file/.test(m))).toBe(true);
  });

  it("an unparseable manifest is CORR-01; a schema violation is CORR-02", async () => {
    const yaml = await run({ mode: "enforce", manifest: "schema: [unclosed\n" });
    expect(yaml.violations.find((x) => x.rule === "CORR-01")?.severity).toBe("error");
    const schema = await run({ manifest: "schema: forge/correctness-manifest@2\nentries: []\n" });
    expect(schema.violations.some((x) => x.rule === "CORR-02")).toBe(true);
  });
});
