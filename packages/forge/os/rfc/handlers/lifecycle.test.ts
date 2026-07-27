import { test, expect, describe } from "vitest";
import { collectRfcCommandLifecycleViolations } from "./lifecycle.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";
import type { CommandRegistry } from "../../../src/types.ts";

function makeParsed(
  status: string,
  createdAt: string,
  commands: { added?: string[]; changed?: string[] },
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
    const preParsed = new Map([
      [
        "archive/implemented/rfc-9999-test.md",
        { fileName: "archive/implemented/rfc-9999-test.md", parsed },
      ],
    ]);
    const { violations } = await collectRfcCommandLifecycleViolations(
      "/tmp/test",
      ["archive/implemented/rfc-9999-test.md"],
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
    const preParsed = new Map([
      [
        "archive/implemented/rfc-9999-test.md",
        { fileName: "archive/implemented/rfc-9999-test.md", parsed },
      ],
    ]);
    const { violations } = await collectRfcCommandLifecycleViolations(
      "/tmp/test",
      ["archive/implemented/rfc-9999-test.md"],
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
    const preParsed = new Map([
      [
        "archive/implemented/rfc-9999-test.md",
        { fileName: "archive/implemented/rfc-9999-test.md", parsed },
      ],
    ]);
    const { violations } = await collectRfcCommandLifecycleViolations(
      "/tmp/test",
      ["archive/implemented/rfc-9999-test.md"],
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
    const preParsed = new Map([
      [
        "archive/implemented/rfc-9999-test.md",
        { fileName: "archive/implemented/rfc-9999-test.md", parsed },
      ],
    ]);
    const { violations } = await collectRfcCommandLifecycleViolations(
      "/tmp/test",
      ["archive/implemented/rfc-9999-test.md"],
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
    const preParsed = new Map([
      [
        "archive/implemented/rfc-9999-test.md",
        { fileName: "archive/implemented/rfc-9999-test.md", parsed },
      ],
    ]);
    const { violations } = await collectRfcCommandLifecycleViolations(
      "/tmp/test",
      ["archive/implemented/rfc-9999-test.md"],
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
    const preParsed = new Map([
      [
        "archive/implemented/rfc-9999-test.md",
        { fileName: "archive/implemented/rfc-9999-test.md", parsed },
      ],
    ]);
    const { violations } = await collectRfcCommandLifecycleViolations(
      "/tmp/test",
      ["archive/implemented/rfc-9999-test.md"],
      preParsed,
      mockRegistry([]),
    );
    const cmd02 = violations.filter((v) => v.rule === "RFC-CMD-02");
    expect(cmd02).toHaveLength(0);
  });
});
