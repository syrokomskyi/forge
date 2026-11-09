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
  <item>RFC-1528: close review findings — manifest-union command inventory for regen/preflight</item>
  <item>RFC-1537: classify regenerable worktree dirt and journal integrate refusals cheapest-first</item>
  <item>RFC-1546: derive-and-repair recoverable state across flow surfaces (AC-1..AC-5)</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect } from "vitest";
import {
  classifyDirt,
  classifyLockfileDiff,
  classifyLockfileMaterialize,
  runIntegratePreflight,
} from "../preflight.ts";
import type {
  CommandRegistry,
  ForgeCommandDefinition,
  ForgeInvokeResult,
  ForgeRegisteredCommandInfo,
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
    listCommands: () =>
      [...known].map(
        (name) =>
          ({
            name,
            provider: "workspace",
            description: "",
            scope: "workspace",
            flags: {},
          }) as ForgeRegisteredCommandInfo,
      ),
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

  it("a prune-shaped dirty lockfile is tolerated regenerable dirt (RFC-1537)", async () => {
    const result = await runIntegratePreflight(
      baseOpts({ worktreeDirty: { entries: [" M pnpm-lock.yaml"], toleratedState: [] } }),
      stubDeps({ lockfileDiff: PRUNE_DIFF }),
    );
    expect(result.ok).toBe(true);
    expect(result.tolerated).toEqual([{ path: "pnpm-lock.yaml", class: "importer-prune" }]);
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
      stubDeps({
        primaryDirty: { entries: [" M docs/y.md"], toleratedState: [], vanished: false },
      }),
    );
    expect(result.refuse?.ruleId).toBe("FLOW-INT-03");
    expect(result.checked).toEqual(["worktree-dirty", "primary-dirty"]);
    expect(invokes).toEqual([]);
  });

  it("a stale manifest without a resolvable generator still refuses FLOW-INT-12 (RFC-1546: after the other checks establish sole-ness)", async () => {
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
    expect(invokes).toEqual(["ecosystem.manifest.validate", "friction.validate"]);
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
    expect(result.skipped).toEqual([
      { check: "open-mission", reason: "unresolvable" },
      { check: "ecosystem.manifest.validate", reason: "no-invoke" },
      { check: "friction.validate", reason: "no-invoke" },
    ]);
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
    expect(result.skipped).toEqual([
      { check: "open-mission", reason: "unresolvable" },
      { check: "ecosystem.manifest.validate", reason: "unresolvable" },
      { check: "friction.validate", reason: "unresolvable" },
    ]);
    expect(result.checked).toContain("rfc.validate:RFC-1528");
  });

  it("manifest-only inventory (werkstatt run host shape) still resolves validators", async () => {
    const commands = ALL_VALIDATORS.map(
      (name) =>
        ({
          name,
          provider: "workspace",
          description: "",
          scope: "workspace",
          flags: {},
        }) as ForgeRegisteredCommandInfo,
    );
    const invokes: string[] = [];
    const result = await runIntegratePreflight(
      baseOpts({
        commandRegistry: undefined,
        commands,
        invoke: async (name) => {
          invokes.push(name);
          return { ok: true, exitCode: 0 } as ForgeInvokeResult;
        },
      }),
      stubDeps({}),
    );
    expect(result.ok).toBe(true);
    expect(invokes).toEqual(["ecosystem.manifest.validate", "friction.validate"]);
    expect(result.skipped).toEqual([{ check: "open-mission", reason: "unresolvable" }]);
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
    expect(result.skipped).toEqual([{ check: "open-mission", reason: "unresolvable" }]);
  });
});

// ── RFC-1537: regenerable dirt classifier + cheap-first mission check ─────

const ioWith = (shape: {
  /** repo path → mission id → manifest body ("corrupt" = unreadable). */
  missionsByRepo?: Record<string, Record<string, string | "corrupt">>;
  files?: Record<string, string>;
  dirs?: string[];
}): WorkspaceIO =>
  ({
    glob: async (pattern: string, opts?: { cwd?: string }) => {
      if (pattern === "missions/*/mission.yaml") {
        return Object.keys(shape.missionsByRepo?.[opts?.cwd ?? ""] ?? {}).map(
          (id) => `missions/${id}/mission.yaml`,
        );
      }
      // `.agents/skills/<dir>/**` — enumerate the fake twin dir's files.
      const twin = /^\.agents\/skills\/([^/]+)\/\*\*$/.exec(pattern);
      if (twin) {
        const prefix = `${opts?.cwd ?? ""}/.agents/skills/${twin[1]}/`;
        return Object.keys(shape.files ?? {})
          .filter((p) => p.startsWith(prefix))
          .map((p) => p.slice((opts?.cwd ?? "").length + 1));
      }
      return [];
    },
    readFile: async (p: string) => {
      const m = /^(.+)\/missions\/([^/]+)\/mission\.yaml$/.exec(p);
      if (m) {
        const v = shape.missionsByRepo?.[m[1]]?.[m[2]];
        if (v === "corrupt") throw new Error("unparseable");
        if (v !== undefined) return v;
      }
      if (p in (shape.files ?? {})) return shape.files![p];
      throw new Error(`ENOENT ${p}`);
    },
    exists: async (p: string) =>
      p in (shape.files ?? {}) || (shape.dirs ?? []).includes(p),
    readFileBytes: async (p: string) => {
      if (p in (shape.files ?? {})) return new TextEncoder().encode(shape.files![p]);
      throw new Error(`ENOENT ${p}`);
    },
  }) as unknown as WorkspaceIO;

const MATERIALIZE_DIFF = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index abc..def 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -10,6 +10,8 @@ importers:
   packages/forge:
     dependencies: {}
+  missions/m000214/workpiece:
+    dependencies: {}
   packages/werkstatt-site:
`;

describe("classifyLockfileMaterialize (RFC-1537)", () => {
  it("labels an added missions/<id>/workpiece importer block", () => {
    expect(classifyLockfileMaterialize(MATERIALIZE_DIFF)).toEqual(["m000214"]);
  });

  it("any removed line is ambiguous — null", () => {
    expect(classifyLockfileMaterialize(PRUNE_DIFF)).toBeNull();
    expect(classifyLockfileMaterialize(MIXED_DIFF)).toBeNull();
  });

  it("additions outside the importer block are ambiguous — null", () => {
    const foreign = `@@ -10,6 +10,7 @@ importers:
+  other/pkg:
+    dependencies: {}
`;
    expect(classifyLockfileMaterialize(foreign)).toBeNull();
  });
});

describe("classifyDirt (RFC-1537 AC-1/AC-2/AC-5)", () => {
  it("importer add-block + open mission workpiece → importer-materialize", async () => {
    const io = ioWith({ missionsByRepo: { "/repo": { m000214: "state: open\n" } } });
    const verdict = await classifyDirt("/repo", io, [" M pnpm-lock.yaml"], {
      runGit: async () => ({ stdout: MATERIALIZE_DIFF, stderr: "", exitCode: 0 }),
    });
    expect(verdict.tolerated).toEqual([{ path: "pnpm-lock.yaml", class: "importer-materialize" }]);
    expect(verdict.unattributed).toEqual([]);
  });

  it("importer add-block without an open mission stays unattributed", async () => {
    const io = ioWith({ missionsByRepo: { "/repo": { m000214: "state: closed\n" } } });
    const verdict = await classifyDirt("/repo", io, [" M pnpm-lock.yaml"], {
      runGit: async () => ({ stdout: MATERIALIZE_DIFF, stderr: "", exitCode: 0 }),
    });
    expect(verdict.tolerated).toEqual([]);
    expect(verdict.unattributed).toEqual([" M pnpm-lock.yaml"]);
  });

  it("byte-identical skill twin → skill-twin-sync", async () => {
    const body = "# fo-x skill\n";
    const io = ioWith({
      files: {
        "/repo/.agents/skills/fo-x/SKILL.md": body,
        "/repo/packages/forge/skills/fo/fo-x/SKILL.md": body,
      },
      dirs: ["/repo/packages/forge/skills/fo/fo-x"],
    });
    const verdict = await classifyDirt("/repo", io, ["?? .agents/skills/fo-x/SKILL.md"]);
    expect(verdict.tolerated).toEqual([
      { path: ".agents/skills/fo-x/SKILL.md", class: "skill-twin-sync" },
    ]);
    expect(verdict.unattributed).toEqual([]);
  });

  it("an edited skill twin is unattributed — real work, never tolerated", async () => {
    const io = ioWith({
      files: {
        "/repo/.agents/skills/fo-x/SKILL.md": "# fo-x skill\n# EDITED\n",
        "/repo/packages/forge/skills/fo/fo-x/SKILL.md": "# fo-x skill\n",
      },
      dirs: ["/repo/packages/forge/skills/fo/fo-x"],
    });
    const verdict = await classifyDirt("/repo", io, ["?? .agents/skills/fo-x/SKILL.md"]);
    expect(verdict.tolerated).toEqual([]);
    expect(verdict.unattributed).toEqual(["?? .agents/skills/fo-x/SKILL.md"]);
  });

  it(".prettierignore twin-sync additions → skill-twin-sync", async () => {
    const io = ioWith({});
    const diff = `@@ -1,2 +1,4 @@\n node_modules/\n+.agents/skills/fo-x/\n+.agents/skills/fo-y/\n`;
    const verdict = await classifyDirt("/repo", io, [" M .prettierignore"], {
      runGit: async () => ({ stdout: diff, stderr: "", exitCode: 0 }),
    });
    expect(verdict.tolerated).toEqual([{ path: ".prettierignore", class: "skill-twin-sync" }]);
  });

  it("an untracked twin directory tolerates only when every file byte-matches (F-0118 shape)", async () => {
    const body = "# fo-x skill\n";
    const io = ioWith({
      files: {
        "/repo/.agents/skills/fo-x/SKILL.md": body,
        "/repo/.agents/skills/fo-x/.forge-managed": "",
        "/repo/packages/forge/skills/fo/fo-x/SKILL.md": body,
      },
      dirs: ["/repo/packages/forge/skills/fo/fo-x"],
    });
    const verdict = await classifyDirt("/repo", io, ["?? .agents/skills/fo-x/"]);
    expect(verdict.tolerated).toEqual([{ path: ".agents/skills/fo-x/", class: "skill-twin-sync" }]);
    expect(verdict.unattributed).toEqual([]);
  });

  it("a stray file inside an untracked twin dir keeps the whole entry unattributed", async () => {
    const io = ioWith({
      files: {
        "/repo/.agents/skills/fo-x/SKILL.md": "# fo-x skill\n",
        "/repo/.agents/skills/fo-x/notes.md": "mine\n",
        "/repo/packages/forge/skills/fo/fo-x/SKILL.md": "# fo-x skill\n",
      },
      dirs: ["/repo/packages/forge/skills/fo/fo-x"],
    });
    const verdict = await classifyDirt("/repo", io, ["?? .agents/skills/fo-x/"]);
    expect(verdict.tolerated).toEqual([]);
    expect(verdict.unattributed).toEqual(["?? .agents/skills/fo-x/"]);
  });

  it("unknown dirt stays unattributed", async () => {
    const verdict = await classifyDirt("/repo", ioWith({}), [" M src/x.ts", "?? stray/"]);
    expect(verdict.tolerated).toEqual([]);
    expect(verdict.unattributed).toEqual([" M src/x.ts", "?? stray/"]);
  });
});

describe("open-mission preflight ordering (RFC-1537 AC-3)", () => {
  it("an open mission in the integrating worktree refuses before validators spawn", async () => {
    const invokes: string[] = [];
    const result = await runIntegratePreflight(
      baseOpts({
        io: ioWith({ missionsByRepo: { "/wt": { m000214: "state: open\n" } } }),
        invoke: async (name) => {
          invokes.push(name);
          return { ok: true, exitCode: 0 } as ForgeInvokeResult;
        },
      }),
      stubDeps({}),
    );
    expect(result.ok).toBe(false);
    expect(result.refuse?.ruleId).toBe("WT-GATE-01");
    expect(result.checked).toEqual(["open-mission"]);
    expect(invokes).toEqual([]);
  });

  it("a corrupt mission manifest counts as open (DNA-106 parity)", async () => {
    const result = await runIntegratePreflight(
      baseOpts({ io: ioWith({ missionsByRepo: { "/wt": { m000214: "corrupt" } } }) }),
      stubDeps({}),
    );
    expect(result.refuse?.ruleId).toBe("WT-GATE-01");
  });

  it("no open missions → the check runs clean and ordering continues", async () => {
    const result = await runIntegratePreflight(
      baseOpts({ io: ioWith({ missionsByRepo: { "/wt": { m000214: "state: closed\n" } } }) }),
      stubDeps({}),
    );
    expect(result.ok).toBe(true);
    expect(result.checked[0]).toBe("open-mission");
  });
});

describe("primary importer-materialize tolerance (RFC-1537 AC-2)", () => {
  it("a primary lockfile materialize for another session's open mission is tolerated", async () => {
    const io = ioWith({ missionsByRepo: { "/primary": { m000214: "state: open\n" } } });
    const result = await runIntegratePreflight(
      baseOpts({ io }),
      stubDeps({
        primaryDirty: { entries: [" M pnpm-lock.yaml"], toleratedState: [], vanished: false },
        lockfileDiff: MATERIALIZE_DIFF,
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.tolerated).toEqual([{ path: "pnpm-lock.yaml", class: "importer-materialize" }]);
  });
});
