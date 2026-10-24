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
  <item>RFC-1389: m message alias and honest positional fix hints in the forge CLI parser</item>
  <item>RFC-1389: add kernel-parity pins for non-alias tokens and argv-end -m</item>
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
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

  test("string[] flag consumes consecutive bare tokens as a value list", () => {
    const cmd = command({
      files: { kind: "string[]", description: "Files." },
      id: { kind: "string", description: "Id." },
    });
    const { flags, diagnostics } = resolveCliFlags(["--files", "a", "b", "c", "--id", "x"], cmd);
    expect(flags["files"]).toEqual(["a", "b", "c"]);
    expect(flags["id"]).toBe("x");
    expect(errorRuleIds(diagnostics)).toEqual([]);
  });

  test("string[] flag with no value still emits KERNEL-FLAG-02", () => {
    const cmd = command({
      files: { kind: "string[]", description: "Files." },
      json2: { kind: "boolean", description: "Switch." },
    });
    const { diagnostics } = resolveCliFlags(["--files", "--json2"], cmd);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-FLAG-02"]);
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

describe("resolveCliFlags — RFC-1389 -m alias and honest hints", () => {
  const withMessage = command({
    message: { kind: "string", required: true, description: "Commit message." },
  });

  // -- AC-2: -m ⇔ --message only where the schema declares message -----------

  test("-m resolves to --message when the schema declares it (parity with --message)", () => {
    const viaAlias = resolveCliFlags(["-m", "msg"], withMessage);
    const viaLong = resolveCliFlags(["--message", "msg"], withMessage);
    expect(viaAlias.flags).toEqual(viaLong.flags);
    expect(viaAlias.flags["message"]).toBe("msg");
    expect(errorRuleIds(viaAlias.diagnostics)).toEqual([]);
  });

  test("-m=value is not alias-rewritten — stays a positional error", () => {
    const { diagnostics } = resolveCliFlags(["-m=msg"], withMessage);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-ARG-01", "KERNEL-FLAG-03"]);
  });

  test("-m stays a KERNEL-ARG-01 positional when message is not declared", () => {
    const { diagnostics } = resolveCliFlags(["-m", "msg"], command({}));
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-ARG-01", "KERNEL-ARG-01"]);
    expect(diagnostics[0]!.fixHint).toContain("--help");
    expect(diagnostics[0]!.fixHint).not.toContain("--message");
  });

  test("post-`--` -m on a command without message falls back to --help", () => {
    const { diagnostics } = resolveCliFlags(["--", "-m"], command({}));
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-ARG-01"]);
    expect(diagnostics[0]!.fixHint).toContain("--help");
    expect(diagnostics[0]!.fixHint).not.toContain("--message");
  });

  test("a non-alias dash letter never fabricates the single required flag", () => {
    const { diagnostics } = resolveCliFlags(["-x"], withMessage);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-ARG-01", "KERNEL-FLAG-03"]);
    expect(diagnostics[0]!.fixHint).toBe(
      'Unexpected argument "-x" — see --help for declared flags.',
    );
    expect(diagnostics[0]!.fixHint).not.toContain("--message");
  });

  test("non-letter dash tokens and multi-char -mx stay positional", () => {
    for (const token of ["-", "-5", "-mx", "-mm"]) {
      const { diagnostics } = resolveCliFlags([token], command({}));
      expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-ARG-01"]);
      expect(diagnostics[0]!.fixHint).toContain("--help");
    }
  });

  test("bare -m at argv end rewrites to --message then reports the missing value", () => {
    const { diagnostics } = resolveCliFlags(["-m"], withMessage);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-FLAG-02", "KERNEL-FLAG-03"]);
    expect(diagnostics[0]!.message).toContain('"--message"');
  });

  // -- AC-1: honest positional hints ----------------------------------------

  test("post-`--` -m on a message-declaring command hints at the real alias", () => {
    const { diagnostics } = resolveCliFlags(["--message", "m", "--", "-m"], withMessage);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-ARG-01"]);
    expect(diagnostics[0]!.fixHint).toBe('Convert "-m" to a flag, e.g. --message <value>.');
  });

  test("positional on a command with one unsatisfied required flag names that flag", () => {
    const { diagnostics } = resolveCliFlags(["positional"], withMessage);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-ARG-01", "KERNEL-FLAG-03"]);
    expect(diagnostics[0]!.fixHint).toBe(
      'Convert "positional" to a flag, e.g. --message "positional".',
    );
  });

  test("positional on a command whose only candidate flag is not required falls back to --help", () => {
    const noId = command({ id: { kind: "string", description: "Optional id." } });
    const { diagnostics } = resolveCliFlags(["RFC-0609"], noId);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-ARG-01"]);
    expect(diagnostics[0]!.fixHint).toBe(
      'Unexpected argument "RFC-0609" — see --help for declared flags.',
    );
    expect(diagnostics[0]!.fixHint).not.toContain("--id ");
  });

  test("a satisfied required flag is not offered as the hint", () => {
    const cmd = command({
      message: { kind: "string", required: true, description: "Msg." },
      id: { kind: "string", description: "Optional." },
    });
    const { diagnostics } = resolveCliFlags(["--message", "m", "stray"], cmd);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-ARG-01"]);
    expect(diagnostics[0]!.fixHint).toContain("--help");
    expect(diagnostics[0]!.fixHint).not.toContain("--message");
  });

  test("a required boolean is never a hint candidate", () => {
    const cmd = command({
      confirm: { kind: "boolean", required: true, description: "Confirm." },
    });
    const { diagnostics } = resolveCliFlags(["stray"], cmd);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-ARG-01", "KERNEL-FLAG-03"]);
    expect(diagnostics[0]!.fixHint).toContain("--help");
    expect(diagnostics[0]!.fixHint).not.toContain("--confirm");
  });

  test("two unsatisfied required flags fall back to --help (no arbitrary pick)", () => {
    const cmd = command({
      a: { kind: "string", required: true, description: "A." },
      b: { kind: "string", required: true, description: "B." },
    });
    const { diagnostics } = resolveCliFlags(["stray"], cmd);
    expect(errorRuleIds(diagnostics)).toEqual([
      "KERNEL-ARG-01",
      "KERNEL-FLAG-03",
      "KERNEL-FLAG-03",
    ]);
    expect(diagnostics[0]!.fixHint).toContain("--help");
  });

  // -- AC-3: alias-shaped tokens are never values; -- boundary; autonomy -----

  test("-m is not consumed as a string flag's value — missing value is reported", () => {
    const cmd = command({
      id: { kind: "string", description: "Id." },
      message: { kind: "string", description: "Msg." },
    });
    const { flags, diagnostics } = resolveCliFlags(["--id", "-m", "v"], cmd);
    expect(flags["id"]).toBeUndefined();
    expect(flags["message"]).toBe("v");
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-FLAG-02"]);
    expect(diagnostics[0]!.message).toContain('"--id"');
  });

  test("string[] flag does not consume a following -m token", () => {
    const cmd = command({
      files: { kind: "string[]", description: "Files." },
      message: { kind: "string", description: "Msg." },
    });
    const { flags, diagnostics } = resolveCliFlags(["--files", "a", "-m", "v"], cmd);
    expect(flags["files"]).toBe("a");
    expect(flags["message"]).toBe("v");
    expect(errorRuleIds(diagnostics)).toEqual([]);
  });

  test("-m -m reports KERNEL-FLAG-02 instead of recording message=-m", () => {
    const { flags, diagnostics } = resolveCliFlags(["-m", "-m"], withMessage);
    expect(flags["message"]).toBeUndefined();
    expect(errorRuleIds(diagnostics)).toEqual([
      "KERNEL-FLAG-02",
      "KERNEL-FLAG-02",
      "KERNEL-FLAG-03",
    ]);
  });

  test("schema-less parseCliArgs keeps -m positional with the --help fallback", () => {
    const { diagnostics } = parseCliArgs(["-m", "x"]);
    expect(errorRuleIds(diagnostics)).toEqual(["KERNEL-ARG-01", "KERNEL-ARG-01"]);
    expect(diagnostics[0]!.fixHint).toContain("--help");
    expect(diagnostics[0]!.fixHint).not.toContain("--id");
    expect(diagnostics[0]!.fixHint).not.toContain("--message");
  });

  test("cli-flags.ts carries no @warpgogol/* runtime import (FORGE-AUTONOMY-01)", () => {
    const source = readFileSync(new URL("../cli-flags.ts", import.meta.url), "utf8");
    const runtimeImports =
      source.match(/import\s+(?!type\b)[\s\S]*?from\s+["']@warpgogol\/[^"']*["']/g) ?? [];
    const dynamicImports = source.match(/import\s*\(\s*["']@warpgogol\//g) ?? [];
    expect([...runtimeImports, ...dynamicImports]).toEqual([]);
  });
});
