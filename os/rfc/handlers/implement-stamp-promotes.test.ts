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
  <item>RFC-1578: close review REVIEW-CODE-2026-11-12-08 findings

F1 code-only anchor scan (markdown fences never declare anchors); F2 generated index as a re-verified hint, scan on any miss; F3 RFC-IMP-16 asserted through rfc.implement.stamp; F4 forge create patches only absent/null keys; F5 type: refs normalized; F6/F10/F11 capture existence via existsSync, future recordedAt and workspace-escaping paths are CORR-07; F7 V-55 reuses criteriaEval; F8 validator inventory regenerated; F9 binding-driven reads; F12 git listing, index hint, create patch tests; DEV-1 single sidecar spelling; DEV-2 output field dropped.</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BASE_MANIFEST, makeWorkspace } from "../../correctness/tests/fixture-workspace.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";
import { runRfcImplementStamp } from "./implement-stamp.ts";
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

describe("RFC-IMP-16 through rfc.implement.stamp", () => {
  it("AC-8: the stamp refuses with RFC-IMP-16 when a promoted criterion has no rfc-ac entry", async () => {
    const root = ws({});
    const rfc = [
      "---",
      "id: RFC-0100",
      'title: "Promotes"',
      "status: accepted",
      "kind: command",
      "scope: workspace",
      "owners:",
      "  - architecture",
      "reviewers:",
      "  - human:tester",
      "createdAt: 2026-10-01",
      "updatedAt: 2026-10-01",
      "promotes: [AC-1]",
      "---",
      "",
      "# RFC-0100",
      "",
      "## Acceptance criteria",
      "",
      "- [x] AC-1: THE dispatch SHALL write send_ready (evidence: test:src/dispatch.schema.test.ts)",
      "",
    ].join("\n");
    mkdirSync(path.join(root, "docs/rfcs"), { recursive: true });
    writeFileSync(path.join(root, "docs/rfcs/rfc-0100-promotes.md"), rfc);
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "implement: RFC-0100 dispatch\n\nX-RFC: RFC-0100"]);
    const sha = git(["rev-parse", "HEAD"]);
    const context = {
      workspaceRoot: root,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        section: () => {},
        success: () => {},
      },
      outputFormat: "json",
      dryRun: false,
    } as unknown as ForgeRuntimeContext;
    const result = await runRfcImplementStamp(
      {
        argv: [],
        flags: { id: "RFC-0100", "implementation-commit": sha, "no-repair": true },
      } as unknown as ForgeCommandInput,
      context,
    );
    const rules = (result.data?.violations ?? []).map((v) => v.rule);
    expect(rules, "the stamp path must surface the promotion gate").toContain("RFC-IMP-16");
    expect(result.exitCode).not.toBe(0);
  });
});
