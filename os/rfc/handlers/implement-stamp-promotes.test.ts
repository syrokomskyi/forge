/*
<MODULE_CONTRACT>
<purpose>RFC-1578 AC-8: RFC-IMP-16 — a promoted criterion without a matching
`rfc-ac` manifest entry refuses the stamp in a project that binds a
correctness manifest, warns in a project that binds none; plus V-55 on
`promotes` entries that are not the RFC's own criteria.</purpose>
<non-goals>
  <item>Not a contract source of truth — the gate owns behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1578: initial suite.</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
</CHANGE_SUMMARY>
*/

import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { BASE_MANIFEST, makeWorkspace } from "../../correctness/tests/fixture-workspace.ts";
import { evaluatePromotesGate } from "./implement-stamp-promotes.ts";
import { validateSingleRfc, type AddViolationFn } from "./validate-rules.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const ws = (opts: Parameters<typeof makeWorkspace>[0]) => {
  const w = makeWorkspace(opts);
  cleanups.push(w.cleanup);
  return w.root;
};

const RFC_AC_ENTRY = `  - id: CM-lifecycle-01
    source: rfc-ac
    ref: RFC-0005/AC-3
    seam: lifecycle
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:src/dispatch.schema.test.ts
        substrate: L2
`;

describe("RFC-IMP-16 promotion gate", () => {
  it("AC-8: refuses when a promoted criterion has no rfc-ac manifest entry and a manifest is bound", () => {
    const root = ws({});
    const res = evaluatePromotesGate({
      targetId: "RFC-0005",
      frontmatter: { promotes: ["AC-3", "AC-4"] },
      workspaceRoot: root,
    });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.rule).toBe("RFC-IMP-16");
    expect(res.errors[0]!.message).toMatch(/AC-3, AC-4/);
  });

  it("passes once every promoted criterion has an entry", () => {
    const root = ws({
      manifest: BASE_MANIFEST.replace("support: []", `${RFC_AC_ENTRY}support: []`),
    });
    const res = evaluatePromotesGate({
      targetId: "RFC-0005",
      frontmatter: { promotes: ["AC-3"] },
      workspaceRoot: root,
    });
    expect(res.errors).toEqual([]);
  });

  it("warns, never refuses, in a project without a manifest binding", () => {
    const root = ws({ manifestBinding: null, manifest: null });
    const res = evaluatePromotesGate({
      targetId: "RFC-0005",
      frontmatter: { promotes: ["AC-3"] },
      workspaceRoot: root,
    });
    expect(res.errors).toEqual([]);
    expect(res.warnings[0]!.rule).toBe("RFC-IMP-16");
  });

  it("an unreadable bound manifest refuses", () => {
    const root = ws({ manifest: "schema: [" });
    const res = evaluatePromotesGate({
      targetId: "RFC-0005",
      frontmatter: { promotes: ["AC-3"] },
      workspaceRoot: root,
    });
    expect(res.errors[0]!.message).toMatch(/cannot be read/);
  });

  it("an RFC without promotes is untouched", () => {
    const res = evaluatePromotesGate({
      targetId: "RFC-0005",
      frontmatter: {},
      workspaceRoot: ws({}),
    });
    expect(res).toEqual({ errors: [], warnings: [] });
  });
});

// ─── V-55 (rfc.validate) ────────────────────────────────────────────────────

describe("V-55 promotes names only the RFC's own criteria", () => {
  const body =
    "# RFC-9999\n\n## Acceptance criteria\n\n- [ ] AC-1: THE x SHALL y (evidence: probe:AC-1)\n";
  const run = async (promotes: unknown) => {
    const seen: { rule: string; message?: string; severity?: string }[] = [];
    const add: AddViolationFn = (_id, _file, rule, message, severity) =>
      void seen.push({ rule, message, severity });
    await validateSingleRfc(
      "rfc-9999-test.md",
      {
        frontmatter: {
          id: "RFC-9999",
          title: "Test",
          status: "draft",
          kind: "policy",
          scope: "workspace",
          owners: ["architecture"],
          createdAt: "2026-11-12",
          updatedAt: "2026-11-12",
          promotes,
        },
        body,
      },
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      new Set(),
      tmpdir(),
      add,
    );
    return seen.filter((s) => s.rule === "V-55");
  };

  it("accepts a promoted criterion the RFC declares", async () => {
    expect(await run(["AC-1"])).toEqual([]);
  });

  it("rejects an undeclared criterion and a non-AC entry", async () => {
    const v = await run(["AC-2", "FI-1"]);
    expect(v.map((x) => x.severity)).toEqual(["error", "error"]);
    expect(v[0]!.message).toMatch(/AC-2/);
  });
});
