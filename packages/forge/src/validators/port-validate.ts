/*
<MODULE_CONTRACT>
<purpose>forge.port.validate — validates that a ported skill or command complies with forge contracts (frontmatter, registry, no project-specific dependencies).</purpose>
<non-goals>
  <item>Do not validate all skills — only the named skill or command.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial forge.port.validate handler.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { FORGE_SKILLS } from "../registry.ts";

interface PortValidateResult {
  command: string;
  status: "pass" | "fail";
  violations: string[];
}

const FORBIDDEN_IMPORTS = [
  "@warpgogol/site-kernel",
  "@warpgogol/site-kernel-checks",
  "@warpgogol/site-kernel-handoff",
  "@warpgogol/ui",
  "@warpgogol/share/page",
];

export function runPortValidate(
  input: { flags: { name?: string } },
  context: unknown,
): PortValidateResult {
  const ctx = context as { workspaceRoot?: string };
  const workspaceRoot = ctx?.workspaceRoot ?? process.cwd();
  const forgeRoot = path.join(workspaceRoot, "packages", "forge");
  const name = input.flags?.name;

  if (!name) {
    return {
      command: "forge.port.validate",
      status: "fail",
      violations: ["--name flag is required"],
    };
  }

  const violations: string[] = [];

  // Check if skill exists in registry
  const skillEntry = FORGE_SKILLS.find((s) => s.name === name);
  if (!skillEntry) {
    violations.push(`Skill "${name}" not found in forge registry`);
  }

  // Check for forbidden imports in TypeScript files under the skill/command directory
  const skillDir = path.join(forgeRoot, "skills");
  const searchDirs = [
    path.join(skillDir, "fo", name),
    path.join(skillDir, "shared", name),
    path.join(skillDir, "meta", name),
    path.join(forgeRoot, "os"),
  ];

  for (const dir of searchDirs) {
    if (fs.existsSync(dir)) {
      scanForForbiddenImports(dir, FORBIDDEN_IMPORTS, violations);
    }
  }

  return {
    command: "forge.port.validate",
    status: violations.length === 0 ? "pass" : "fail",
    violations,
  };
}

function scanForForbiddenImports(dir: string, forbidden: string[], violations: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanForForbiddenImports(fullPath, forbidden, violations);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) {
      const content = fs.readFileSync(fullPath, "utf8");
      for (const imp of forbidden) {
        if (content.includes(imp)) {
          violations.push(
            `Forbidden import "${imp}" found in ${path.relative(process.cwd(), fullPath)}`,
          );
        }
      }
    }
  }
}
