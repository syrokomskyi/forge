/*
<MODULE_CONTRACT>
<purpose>Unit tests for the RFC-1528 flow.integrate preflight — the strict
importer-prune-only lockfile classifier and the bounded ordered check list
(worktree/primary dirt → manifest → scoped RFCs → friction) with injectable
git/status/invoke seams.</purpose>
<non-goals>
  <item>No real git, io or registry — deps are stubbed; integrateInner wiring is covered by the handler-level tests.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1528: initial — classifier shapes, refusal ordering, resolvability skips, FLOW-INT-12/13/14.</item>
  <item>RFC-1528: flow.integrate bounded preflight before rebase and gate

Classified lockfile diffs on FLOW-INT-01/03, early primary check, and resolvable validators (ecosystem.manifest.validate, scoped rfc.validate, friction.validate) refusing as FLOW-INT-12/13/14.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect } from "vitest";
import { classifyLockfileDiff, runIntegratePreflight } from "../preflight.ts";
import type {
  CommandRegistry,
  ForgeCommandDefinition,
  ForgeInvokeResult,
  WorkspaceIO,
} from "../../../src/types.ts";

const PRUNE_DIFF = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index abc..def 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -10,7 +10,6 @@ importers:
   packages/forge:
     dependencies: {}
-  missions/m000214/workpiece:
-    dependencies:
-      vite: 5.0.0
   packages/werkstatt-site:
`;

const MIXED_DIFF = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index abc..def 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -10,7 +10,6 @@ importers:
-  missions/m000214/workpiece:
-    dependencies: {}
-  packages/werkstatt-site:
-    dependencies: {}
`;

const ADDED_DIFF = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index abc..def 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -10,6 +10,7 @@ importers:
-  missions/m000214/workpiece:
+  missions/m000215/workpiece:
+    dependencies: {}
`;

describe("classifyLockfileDiff (RFC-1528)", () => {
  it("labels the vanished mission-importer prune shape", () => {
    expect(classifyLockfileDiff(PRUNE_DIFF)).toBe("importer-prune-only");
  });

  it("removals outside the workpiece importer block stay ordinary refusals", () => {
    expect(classifyLockfileDiff(MIXED_DIFF)).toBe("other");
  });

  it("any added line is not a prune", () => {
    expect(classifyLockfileDiff(ADDED_DIFF)).toBe("other");
  });

  it("nested removals without the workpiece key are ambiguous — other", () => {
    const nestedOnly = `@@ -1,4 +1,3 @@
-    dependencies:
-      vite: 5.0.0
 packages/forge:
`;
    expect(classifyLockfileDiff(nestedOnly)).toBe("other");
  });

  it("no removals at all is not a prune", () => {
    expect(classifyLockfileDiff("@@ -1 +1 @@\n+  foo: bar\n")).toBe("other");
    expect(classifyLockfileDiff("")).toBe("other");
  });
});

// ── runIntegratePreflight — ordering + refusal mapping ────────────────────

const io = {} as WorkspaceIO;

function registryWith(commands: string[]): CommandRegistry {
  const known = new Set(commands);
  return {
    listCommandNames: () => [...known],
    listCommands: () => [],
    getCommand: (name: string) =>
      known.has(name) ? ({ name } as ForgeCommandDefinition) : undefined,
  };
}

const ALL_VALIDATORS = ["ecosystem.manifest.validate", "rfc.validate", "friction.validate"];

function cleanDirty() {
  return { entries: [] as string[], toleratedState: [] as string[], vanished: false };
}

function stubDeps(overrides: {
  gitStdout?: string;
  primaryDirty?: { entries: string[]; toleratedState: string[]; vanished: boolean };
  primaryBranch?: string | null;
  lockfileDiff?: string;
}) {
  return {
    runGit: async (_cwd: string, _io: WorkspaceIO, args: string[]) => {
      if (args[0] === "diff" && args.includes("pnpm-lock.yaml")) {
        return { stdout: overrides.lockfileDiff ?? "", stderr: "", exitCode: 0 };
      }
      return { stdout: overrides.gitStdout ?? "", stderr: "", exitCode: 0 };
    },
    runStatusTracked: async () => overrides.primaryDirty ?? cleanDirty(),
    runCurrentBranch: async () =>
      overrides.primaryBranch === undefined ? "develop" : overrides.primaryBranch,
  };
}

function baseOpts(overrides: Partial<Parameters<typeof runIntegratePreflight>[0]> = {}) {
  return {
    primary: "/primary",
    branchWorktree: "/wt",
    branch: "auto/session-260107-01-x",
    io,
    worktreeDirty: cleanDirty(),
    commandRegistry: registryWith(ALL_VALIDATORS),
    ...overrides,
  };
}

describe("runIntegratePreflight (RFC-1528 AC-2/AC-4)", () => {
  it("a dirty worktree refuses FLOW-INT-01 before any validator runs", async () => {
    const invokes: string[] = [];
    const result = await runIntegratePreflight(
      baseOpts({
        worktreeDirty: { entries: [" M docs/x.md"], toleratedState: [] },
        invoke: async (name) => {
          invokes.push(name);
          return { ok: true, exitCode: 0 } as ForgeInvokeResult;
        },
      }),
      stubDeps({}),
    );
    expect(result.ok).toBe(false);
    expect(result.refuse?.ruleId).toBe("FLOW-INT-01");
    expect(result.checked).toEqual(["worktree-dirty"]);
    expect(invokes).toEqual([]);
  });

  it("a prune-shaped dirty lockfile is classified in the FLOW-INT-01 refusal", async () => {
    const result = await runIntegratePreflight(
      baseOpts({ worktreeDirty: { entries: [" M pnpm-lock.yaml"], toleratedState: [] } }),
      stubDeps({ lockfileDiff: PRUNE_DIFF }),
    );
    expect(result.refuse?.ruleId).toBe("FLOW-INT-01");
    expect(result.refuse?.data?.["lockfileClassification"]).toBe("importer-prune-only");
    expect(result.refuse?.message).toContain("importer prune");
  });

  it("primary tracked dirt refuses FLOW-INT-03 before validators", async () => {
    const invokes: string[] = [];
    const result = await runIntegratePreflight(
      baseOpts({
        invoke: async (name) => {
          invokes.push(name);
          return { ok: true, exitCode: 0 } as ForgeInvokeResult;
        },
      }),
      stubDeps({ primaryDirty: { entries: [" M docs/y.md"], toleratedState: [], vanished: false } }),
    );
    expect(result.refuse?.ruleId).toBe("FLOW-INT-03");
    expect(result.checked).toEqual(["worktree-dirty", "primary-dirty"]);
    expect(invokes).toEqual([]);
  });

  it("a stale manifest refuses FLOW-INT-12 before RFC/friction checks", async () => {
    const invokes: string[] = [];
    const result = await runIntegratePreflight(
      baseOpts({
        invoke: async (name) => {
          invokes.push(name);
          return name === "ecosystem.manifest.validate"
            ? ({ ok: false, exitCode: 1, summary: "manifest drift" } as ForgeInvokeResult)
            : ({ ok: true, exitCode: 0 } as ForgeInvokeResult);
        },
      }),
      stubDeps({}),
    );
    expect(result.refuse?.ruleId).toBe("FLOW-INT-12");
    expect(invokes).toEqual(["ecosystem.manifest.validate"]);
  });

  it("rfc.validate is scoped to RFC files changed on develop...branch", async () => {
    const invokes: string[] = [];
    const result = await runIntegratePreflight(
      baseOpts({
        invoke: async (name, flags) => {
          invokes.push(`${name} ${JSON.stringify(flags ?? {})}`);
          return { ok: true, exitCode: 0 } as ForgeInvokeResult;
        },
      }),
      stubDeps({
        gitStdout:
          "docs/rfcs/rfc-1528-x.md\ndocs/rfcs/archive/implemented/rfc-1505-y.md\ndocs/adrs/adr-0120.md\n",
      }),
    );
    expect(result.ok).toBe(true);
    expect(invokes).toEqual([
      "ecosystem.manifest.validate {}",
      'rfc.validate {"id":"RFC-1528"}',
      'rfc.validate {"id":"RFC-1505"}',
      "friction.validate {}",
    ]);
  });

  it("an invalid changed RFC refuses FLOW-INT-13", async () => {
    const result = await runIntegratePreflight(
      baseOpts({
        invoke: async (name) =>
          name === "rfc.validate"
            ? ({ ok: false, exitCode: 1, summary: "RFC-006 bad frontmatter" } as ForgeInvokeResult)
            : ({ ok: true, exitCode: 0 } as ForgeInvokeResult),
      }),
      stubDeps({ gitStdout: "docs/rfcs/rfc-1528-x.md\n" }),
    );
    expect(result.refuse?.ruleId).toBe("FLOW-INT-13");
  });

  it("a broken friction registry refuses FLOW-INT-14", async () => {
    const result = await runIntegratePreflight(
      baseOpts({
        invoke: async (name) =>
          name === "friction.validate"
            ? ({ ok: false, exitCode: 1, summary: "duplicate id F-0100" } as ForgeInvokeResult)
            : ({ ok: true, exitCode: 0 } as ForgeInvokeResult),
      }),
      stubDeps({}),
    );
    expect(result.refuse?.ruleId).toBe("FLOW-INT-14");
  });

  it("absent invoke skips validators with notes — dirty checks still run", async () => {
    const result = await runIntegratePreflight(baseOpts({ invoke: undefined }), stubDeps({}));
    expect(result.ok).toBe(true);
    expect(result.checked).toEqual(["worktree-dirty", "primary-dirty"]);
    expect(result.skipped).toEqual(["ecosystem.manifest.validate", "friction.validate"]);
  });

  it("an unresolvable validator is skipped, not fatal", async () => {
    const result = await runIntegratePreflight(
      baseOpts({
        commandRegistry: registryWith(["rfc.validate"]),
        invoke: async () => ({ ok: true, exitCode: 0 }) as ForgeInvokeResult,
      }),
      stubDeps({ gitStdout: "docs/rfcs/rfc-1528-x.md\n" }),
    );
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual(["ecosystem.manifest.validate", "friction.validate"]);
    expect(result.checked).toContain("rfc.validate:RFC-1528");
  });

  it("all-clean run reports the full bounded check list", async () => {
    const result = await runIntegratePreflight(
      baseOpts({ invoke: async () => ({ ok: true, exitCode: 0 }) as ForgeInvokeResult }),
      stubDeps({ gitStdout: "docs/rfcs/rfc-1528-x.md\n" }),
    );
    expect(result.ok).toBe(true);
    expect(result.checked).toEqual([
      "worktree-dirty",
      "primary-dirty",
      "ecosystem.manifest.validate",
      "rfc.validate:RFC-1528",
      "friction.validate",
    ]);
    expect(result.skipped).toEqual([]);
  });
});
