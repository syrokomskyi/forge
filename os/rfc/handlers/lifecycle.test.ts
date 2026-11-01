/*
<MODULE_CONTRACT>
<purpose>
Unit tests for lifecycle covering RFC-CMD-02/03 cutoff behavior. It also guards the documented public contract and regression-sensitive edge cases.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the lifecycle suite's contract for test-file scaffold coverage.</item>
  <item>RFC-1482: emit validation-compliant RFC skeletons and surface contract breaches at authoring time</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { collectRfcCommandLifecycleViolations } from "./lifecycle.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";
import type { CommandRegistry } from "../../../src/types.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testWorkspaceRoot = join(tmpdir(), "test");

function makeParsed(
  status: string,
  createdAt: string,
  commands: { added?: string[]; changed?: string[]; removed?: string[] },
): ParsedRfc {
  return {
    frontmatter: {
      id: "RFC-9999",
      title: "Test RFC",
      status,
      kind: "policy",
      scope: "workspace",
      owners: ["architecture"],
      createdAt,
      updatedAt: createdAt,
      commands,
    },
    body: "",
  };
}

function mockRegistry(commandNames: string[]): CommandRegistry {
  return {
    listCommands: () => commandNames.map((name) => ({ name, description: "" })),
  } as unknown as CommandRegistry;
}

describe("RFC-CMD-02/03 cutoff behavior", () => {
  test("pre-cutoff RFC with unregistered command.added → no violation", async () => {
    const parsed = makeParsed("implemented", "2026-01-01", {
      added: ["nonexistent.command"],
    });
    const preParsed = new Map([["rfc-9999-test.md", { fileName: "rfc-9999-test.md", parsed }]]);
    const { violations } = await collectRfcCommandLifecycleViolations(
      testWorkspaceRoot,
      ["rfc-9999-test.md"],
      preParsed,
      mockRegistry([]),
    );
    const cmd02 = violations.filter((v) => v.rule === "RFC-CMD-02");
    expect(cmd02).toHaveLength(0);
  });

  test("post-cutoff RFC with unregistered command.added → violation", async () => {
    const parsed = makeParsed("implemented", "2026-07-08", {
      added: ["nonexistent.command"],
    });
    const preParsed = new Map([["rfc-9999-test.md", { fileName: "rfc-9999-test.md", parsed }]]);
    const { violations } = await collectRfcCommandLifecycleViolations(
      testWorkspaceRoot,
      ["rfc-9999-test.md"],
      preParsed,
      mockRegistry([]),
    );
    const cmd02 = violations.filter((v) => v.rule === "RFC-CMD-02");
    expect(cmd02).toHaveLength(1);
  });

  test("pre-cutoff RFC with unregistered command.changed → no violation", async () => {
    const parsed = makeParsed("implemented", "2026-01-01", {
      changed: ["nonexistent.command"],
    });
    const preParsed = new Map([["rfc-9999-test.md", { fileName: "rfc-9999-test.md", parsed }]]);
    const { violations } = await collectRfcCommandLifecycleViolations(
      testWorkspaceRoot,
      ["rfc-9999-test.md"],
      preParsed,
      mockRegistry([]),
    );
    const cmd03 = violations.filter((v) => v.rule === "RFC-CMD-03");
    expect(cmd03).toHaveLength(0);
  });

  test("post-cutoff RFC with unregistered command.changed → violation", async () => {
    const parsed = makeParsed("implemented", "2026-07-08", {
      changed: ["nonexistent.command"],
    });
    const preParsed = new Map([["rfc-9999-test.md", { fileName: "rfc-9999-test.md", parsed }]]);
    const { violations } = await collectRfcCommandLifecycleViolations(
      testWorkspaceRoot,
      ["rfc-9999-test.md"],
      preParsed,
      mockRegistry([]),
    );
    const cmd03 = violations.filter((v) => v.rule === "RFC-CMD-03");
    expect(cmd03).toHaveLength(1);
  });

  test("exact cutoff date (2026-07-07) → violation (>= cutoff)", async () => {
    const parsed = makeParsed("implemented", "2026-07-07", {
      added: ["nonexistent.command"],
    });
    const preParsed = new Map([["rfc-9999-test.md", { fileName: "rfc-9999-test.md", parsed }]]);
    const { violations } = await collectRfcCommandLifecycleViolations(
      testWorkspaceRoot,
      ["rfc-9999-test.md"],
      preParsed,
      mockRegistry([]),
    );
    const cmd02 = violations.filter((v) => v.rule === "RFC-CMD-02");
    expect(cmd02).toHaveLength(1);
  });

  test("day before cutoff (2026-07-06) → no violation", async () => {
    const parsed = makeParsed("implemented", "2026-07-06", {
      added: ["nonexistent.command"],
    });
    const preParsed = new Map([["rfc-9999-test.md", { fileName: "rfc-9999-test.md", parsed }]]);
    const { violations } = await collectRfcCommandLifecycleViolations(
      testWorkspaceRoot,
      ["rfc-9999-test.md"],
      preParsed,
      mockRegistry([]),
    );
    const cmd02 = violations.filter((v) => v.rule === "RFC-CMD-02");
    expect(cmd02).toHaveLength(0);
  });
});

describe("RFC-1482 RFC-CMD-03 early warning on commands.changed", () => {
  async function collect(status: string, createdAt: string, commands: { changed?: string[]; removed?: string[] }, registry: string[] = []) {
    const parsed = makeParsed(status, createdAt, commands);
    const preParsed = new Map([["rfc-9999-test.md", { fileName: "rfc-9999-test.md", parsed }]]);
    const { violations } = await collectRfcCommandLifecycleViolations(
      testWorkspaceRoot,
      ["rfc-9999-test.md"],
      preParsed,
      mockRegistry(registry),
    );
    return violations.filter((v) => v.rule === "RFC-CMD-03");
  }

  test("draft + unregistered changed name → warning (surfaced early)", async () => {
    const cmd03 = await collect("draft", "2026-07-08", { changed: ["nonexistent.command"] });
    expect(cmd03).toHaveLength(1);
    expect(cmd03[0]?.severity).toBe("warning");
  });

  test("accepted + unregistered changed name → warning", async () => {
    const cmd03 = await collect("accepted", "2026-07-08", { changed: ["nonexistent.command"] });
    expect(cmd03).toHaveLength(1);
    expect(cmd03[0]?.severity).toBe("warning");
  });

  test("implemented + unregistered changed name → error (blocking gate preserved)", async () => {
    const cmd03 = await collect("implemented", "2026-07-08", { changed: ["nonexistent.command"] });
    expect(cmd03).toHaveLength(1);
    expect(cmd03[0]?.severity).toBe("error");
    expect(cmd03[0]?.message).toContain(
      'implemented RFC lists "nonexistent.command" under commands.changed, but no live command is registered',
    );
  });

  test("changed name present in commands.removed → no violation at any status", async () => {
    for (const status of ["draft", "accepted", "implemented"]) {
      const cmd03 = await collect(status, "2026-07-08", {
        changed: ["nonexistent.command"],
        removed: ["nonexistent.command"],
      });
      expect(cmd03, `status ${status}`).toHaveLength(0);
    }
  });

  test("registered changed name → no violation", async () => {
    for (const status of ["draft", "accepted", "implemented"]) {
      const cmd03 = await collect(status, "2026-07-08", { changed: ["live.command"] }, ["live.command"]);
      expect(cmd03, `status ${status}`).toHaveLength(0);
    }
  });

  test("pre-cutoff draft → no warning", async () => {
    const cmd03 = await collect("draft", "2026-01-01", { changed: ["nonexistent.command"] });
    expect(cmd03).toHaveLength(0);
  });
});
