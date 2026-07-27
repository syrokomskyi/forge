/*
<MODULE_CONTRACT>
<purpose>forge.port.scaffold — generates a skeleton for a new skill or command in forge.</purpose>
<non-goals>
  <item>Do not validate the scaffolded content — that is forge.port.validate's job.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial forge.port.scaffold handler.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { FORGE_SKILLS } from "../registry.ts";
import { resolveForgeRoot } from "../config/forge-config.ts";

interface ScaffoldResult {
  command: string;
  status: "pass" | "fail";
  created: string[];
  errors: string[];
}

export function runScaffold(
  input: { flags: { name?: string; type?: string; category?: string } },
  context: unknown,
): ScaffoldResult {
  const ctx = context as { workspaceRoot?: string };
  const workspaceRoot = ctx?.workspaceRoot ?? process.cwd();
  let forgeRoot: string;
  try {
    forgeRoot = resolveForgeRoot(workspaceRoot);
  } catch {
    forgeRoot = path.join(workspaceRoot, "packages", "forge");
  }

  const name = input.flags?.name;
  const type = input.flags?.type ?? "skill";
  const category = input.flags?.category ?? "shared";

  const errors: string[] = [];
  const created: string[] = [];

  if (!name) {
    errors.push("--name flag is required");
    return { command: "forge.port.scaffold", status: "fail", created, errors };
  }

  // Check for existing skill with same name
  if (FORGE_SKILLS.some((s) => s.name === name)) {
    errors.push(`Skill "${name}" already exists in the forge registry`);
    return { command: "forge.port.scaffold", status: "fail", created, errors };
  }

  if (type === "skill") {
    const skillDir = path.join(forgeRoot, "skills", category, name);
    const skillPath = path.join(skillDir, "SKILL.md");

    if (fs.existsSync(skillPath)) {
      errors.push(`SKILL.md already exists at ${path.relative(workspaceRoot, skillPath)}`);
      return { command: "forge.port.scaffold", status: "fail", created, errors };
    }

    fs.mkdirSync(skillDir, { recursive: true });

    const content = `---
name: ${name}
description: TODO — one-line description (max 200 chars)
invocation: user
category: ${category}
concerns: document-only
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
---

# ${name}

Before starting, read \`PREFERENCES.md\` at the repository root. If the file is missing or \`aiLanguage\` is unset, ask the operator once and create the file using the \`my-preferences\` skill semantics.

TODO: Write the skill's behavioral instructions here.
`;

    fs.writeFileSync(skillPath, content, "utf8");
    created.push(path.relative(workspaceRoot, skillPath));
  } else if (type === "command") {
    const cmdDir = path.join(forgeRoot, "os", name);
    const cmdPath = path.join(cmdDir, `${name}.module.ts`);

    if (fs.existsSync(cmdPath)) {
      errors.push(`Command module already exists at ${path.relative(workspaceRoot, cmdPath)}`);
      return { command: "forge.port.scaffold", status: "fail", created, errors };
    }

    fs.mkdirSync(cmdDir, { recursive: true });

    const content = `/*
<MODULE_CONTRACT>
<purpose>TODO — purpose of the ${name} command module.</purpose>
<non-goals>
  <item>Do not import from @gogol/site-kernel.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial ${name} command module.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule, ForgeCommandDefinition } from "../../src/forge-module.ts";

export const forge${capitalize(name)}Module: ForgeModule = {
  name: "forge-${name}",
  version: "0.1.0",
  register(registry) {
    registry.registerCommand({
      name: "${name}",
      description: "TODO — one-line description",
      scope: "workspace",
      execute() {
        // TODO: implement
      },
    } satisfies ForgeCommandDefinition);
  },
};
`;

    fs.writeFileSync(cmdPath, content, "utf8");
    created.push(path.relative(workspaceRoot, cmdPath));
  } else {
    errors.push(`--type must be "skill" or "command", got "${type}"`);
  }

  return {
    command: "forge.port.scaffold",
    status: errors.length === 0 ? "pass" : "fail",
    created,
    errors,
  };
}

function capitalize(s: string): string {
  return s.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}
