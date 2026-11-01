/*
<MODULE_CONTRACT>
<purpose>Register the yaml.scalars.validate command with the forge kernel registry (RFC-1478).</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/scalars-validate.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1478: initial module — yaml.scalars.validate flags unquoted
  colon-space traps in plain scalars (.yaml + .md frontmatter); staged
  findings surface through the ecosystem.commit EC-25 gate; F-0006.</item>
  <item>RFC-1478: yaml.scalars.validate + EC-25 colon-space staged lint (F-0006)</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeYamlModule(): Promise<ForgeModule> {
  const { runYamlScalarsValidate } = await import("./handlers/scalars-validate.ts");
  return {
    name: "forge-yaml",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "yaml.scalars.validate",
        description:
          "RFC-1478: lint authored YAML for plain scalars carrying colon-space " +
          "traps (F-0006). YAML-SCALAR-01 flags unquoted `: ` inside a value — " +
          "a loud parse error on one line, or a silent flat-to-nested-map " +
          "reinterpretation on a deeper-indented continuation line. .md files " +
          "scan the leading frontmatter block only; quoted scalars, block " +
          "scalars, comments, flow collections, and template files are excluded. " +
          "Scope with --files <list> (error-tier ad-hoc check) or --all " +
          "(workspace corpus; governance surfaces error, the rest warn). " +
          "Read-only.",
        scope: "workspace",
        acceptsAllFlag: true,
        contract: "yaml",
        rules: [{ id: "YAML-SCALAR-01", severity: "error" }],
        mutatesState: false,
        execOnReadOnly: true,
        reads: ["**/*.yaml", "**/*.yml", "**/*.md"],
        cacheable: false,
        flags: {
          files: {
            kind: "string",
            description: "Comma-separated repo-relative file list to lint (error tier).",
          },
          all: {
            kind: "boolean",
            description: "Scan the whole workspace corpus (governance surfaces error, others warn).",
          },
        },
        execute: runYamlScalarsValidate,
      },
    ],
    pipelines: [],
  };
}
