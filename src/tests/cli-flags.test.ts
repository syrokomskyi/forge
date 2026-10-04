/*
<MODULE_CONTRACT>
<purpose>Unit tests for src/cli-flags.ts — schema-driven argv-to-flags
resolution for the standalone forge CLI (strict KERNEL-FLAG-01/02/03 and
KERNEL-ARG-01 diagnostics, legacy heuristic path for schema-less commands).</purpose>
<non-goals>
  <item>Do not test bin/cli.ts dispatch — these tests cover pure functions only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial cli-flags resolution tests — covers the `forge rfc.validate --id` crash regression (value-less declared string flag must produce KERNEL-FLAG-02, not a boolean).</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, test } from "vitest";
import { parseCliArgs, resolveCliFlags } from "../cli-flags.ts";
import type { ForgeCommandDefinition, ForgeFlagSpec } from "../types.ts";

function command(flags?: Record<string, ForgeFlagSpec>): ForgeCommandDefinition {
  return {
    name: "test.command",
    description: "test command",
    scope: "workspace",
    flags,
    execute: () => {},
  };
}

const errorRuleIds = (diagnostics: { ruleId: string; severity: string }[]) =>
  diagnostics.filter((d) => d.severity === "error").map((d) => d.ruleId);

describe("resolveCliFlags — strict (schema-carrying) path", () => {
  const rfcValidate = command({
    id: { kind: "string", description: "Target a single RFC by id." },
  });

  test("value-less declared string flag errors with KERNEL-FLAG-02 instead of becoming `true`", () => {
    const { flags, diagnostics } = resolveCliFlags(["--id"], rfcValidate);
    expect(flags["id"]).toBeUndefined();
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-FLAG-02"]);
    expect(diagnostics[0]!.message).toContain('Flag "--id"');
    expect(diagnostics[0]!.message).toContain('"test.command"');
  });

  test("value-less declared string flag before another flag still errors", () => {
    const { flags, diagnostics } = resolveCliFlags(["--id", "--json"], rfcValidate);
    expect(flags["id"]).toBeUndefined();
    expect(flags["json"]).toBe(true);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-FLAG-02"]);
  });

  test("--id <value> and --id=<value> resolve to the string", () => {
    for (const argv of [["--id", "RFC-0609"], ["--id=RFC-0609"]]) {
      const { flags, diagnostics } = resolveCliFlags(argv, rfcValidate);
      expect(flags["id"]).toBe("RFC-0609");
      expect(errorRuleIds(diagnostics)).toEqual([]);
    }
  });

  test("inline value containing = is preserved verbatim", () => {
    const { flags, diagnostics } = resolveCliFlags(["--id=RFC=0609"], rfcValidate);
    expect(flags["id"]).toBe("RFC=0609");
    expect(errorRuleIds(diagnostics)).toEqual([]);
  });

  test("repeated single-value string flag errors instead of promoting to an array", () => {
    const { flags, diagnostics } = resolveCliFlags(["--id", "RFC-1", "--id", "RFC-2"], rfcValidate);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-FLAG-02"]);
    expect(diagnostics[0]!.message).toContain("single value");
    expect(flags["id"]).toEqual(["RFC-1", "RFC-2"]);
  });

  test("unknown flag errors with KERNEL-FLAG-01 listing valid flags", () => {
    const { diagnostics } = resolveCliFlags(["--idd"], rfcValidate);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-FLAG-01"]);
    expect(diagnostics[0]!.message).toContain("id");
  });

  test("unknown flag followed by a bare token also flags the token as positional", () => {
    const { diagnostics } = resolveCliFlags(["--idd", "RFC-1"], rfcValidate);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-FLAG-01", "KERNEL-ARG-01"]);
  });

  test("required flag missing errors with KERNEL-FLAG-03", () => {
    const cmd = command({
      name: { kind: "string", required: true, description: "Required name." },
    });
    const { diagnostics } = resolveCliFlags([], cmd);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-FLAG-03"]);
  });

  test("declared default applies when flag absent", () => {
    const cmd = command({
      mode: { kind: "string", default: "all", description: "Mode." },
    });
    const { flags, diagnostics } = resolveCliFlags([], cmd);
    expect(flags["mode"]).toBe("all");
    expect(errorRuleIds(diagnostics)).toEqual([]);
  });

  test("positional token errors with KERNEL-ARG-01", () => {
    const { diagnostics } = resolveCliFlags(["RFC-0609"], rfcValidate);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-ARG-01"]);
  });

  test("tokens after -- are positional errors", () => {
    const { diagnostics } = resolveCliFlags(["--id", "RFC-1", "--", "extra"], rfcValidate);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-ARG-01"]);
  });

  test("universal flags accepted on commands with empty schema", () => {
    const { flags, diagnostics } = resolveCliFlags(
      ["--json", "--dry-run", "--help", "--site", "x"],
      command({}),
    );
    expect(flags["json"]).toBe(true);
    expect(flags["dry-run"]).toBe(true);
    expect(flags["help"]).toBe(true);
    expect(flags["site"]).toBe("x");
    expect(errorRuleIds(diagnostics)).toEqual([]);
  });

  test("universal boolean does not swallow the next flag's token", () => {
    const cmd = command({ fix: { kind: "boolean", description: "Fix." } });
    const { flags, diagnostics } = resolveCliFlags(["--json", "--fix"], cmd);
    expect(flags["json"]).toBe(true);
    expect(flags["fix"]).toBe(true);
    expect(errorRuleIds(diagnostics)).toEqual([]);
  });

  test("--flag=false on a declared boolean resolves to false", () => {
    const cmd = command({ fix: { kind: "boolean", description: "Fix." } });
    const { flags, diagnostics } = resolveCliFlags(["--fix=false"], cmd);
    expect(flags["fix"]).toBe(false);
    expect(errorRuleIds(diagnostics)).toEqual([]);
  });

  test("string[] flag collects repeated values", () => {
    const cmd = command({
      files: { kind: "string[]", description: "Files." },
    });
    const { flags, diagnostics } = resolveCliFlags(["--files", "a", "--files", "b"], cmd);
    expect(flags["files"]).toEqual(["a", "b"]);
    expect(errorRuleIds(diagnostics)).toEqual([]);
  });
});

describe("resolveCliFlags — legacy (schema-less) path", () => {
  const schemaLess = command(undefined);

  test("unknown flags still parse heuristically", () => {
    const { flags, diagnostics } = resolveCliFlags(["--anything", "v"], schemaLess);
    expect(flags["anything"]).toBe("v");
    expect(errorRuleIds(diagnostics)).toEqual([]);
  });

  test("known boolean switches do not consume the next token", () => {
    const { flags } = resolveCliFlags(["--json", "v"], schemaLess);
    expect(flags["json"]).toBe(true);
  });

  test("positional token errors with KERNEL-ARG-01", () => {
    const { diagnostics } = resolveCliFlags(["positional"], schemaLess);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-ARG-01"]);
  });
});

describe("parseCliArgs", () => {
  test("--key=value and --key value forms both resolve", () => {
    const { flags } = parseCliArgs(["--a=1", "--b", "2", "--json"]);
    expect(flags["a"]).toBe("1");
    expect(flags["b"]).toBe("2");
    expect(flags["json"]).toBe(true);
  });
});
