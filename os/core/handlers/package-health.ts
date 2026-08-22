/*
<MODULE_CONTRACT>
<purpose>forge.package.health — validate all published packages (private: false) for standalone extraction readiness. Checks engines.node, embedded CI workflow, extract.config.yaml, and devDependencies completeness (no hoisted tool deps).</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not modify files — read-only validation.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial: forge.package.health validator — engines, CI workflow, extract config, devDeps completeness.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface PackageHealthViolation {
  ruleId: string;
  packageName: string;
  severity: "error" | "warning";
  message: string;
  file?: string;
  fixHint?: string;
}

export interface PackageHealthResult {
  command: "forge.package.health";
  packagesChecked: number;
  violations: PackageHealthViolation[];
  passed: boolean;
}

const KNOWN_SCRIPT_TOOLS: Record<string, string> = {
  eslint: "eslint",
  prettier: "prettier",
  vitest: "vitest",
  tsc: "typescript",
  tsx: "tsx",
  turbo: "turbo",
  biome: "@biomejs/biome",
};

function extractToolNames(scripts: Record<string, string>): Set<string> {
  const tools = new Set<string>();
  for (const scriptValue of Object.values(scripts)) {
    for (const [toolName, depName] of Object.entries(KNOWN_SCRIPT_TOOLS)) {
      if (scriptValue.includes(toolName) || scriptValue.includes(`pnpm exec ${toolName}`)) {
        tools.add(depName);
      }
    }
  }
  return tools;
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function runPackageHealth(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<PackageHealthResult>> {
  const { workspaceRoot, logger } = context;
  const packagesDir = path.join(workspaceRoot, "packages");

  if (!fs.existsSync(packagesDir)) {
    return {
      data: {
        command: "forge.package.health",
        packagesChecked: 0,
        violations: [],
        passed: true,
      },
      exitCode: 0,
      summary: "No packages/ directory found — nothing to check.",
    };
  }

  const rootPkg = readJsonFile(path.join(workspaceRoot, "package.json"));
  const rootEngines = rootPkg?.["engines"] as Record<string, string> | undefined;
  const rootNodeRange = rootEngines?.["node"];

  const violations: PackageHealthViolation[] = [];
  let packagesChecked = 0;

  const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    const pkgDir = path.join(packagesDir, entry.name);
    const pkgJsonPath = path.join(pkgDir, "package.json");
    const pkg = readJsonFile(pkgJsonPath);
    if (!pkg) continue;

    const isPrivate = pkg["private"] === true;
    if (isPrivate) continue;

    packagesChecked++;
    const packageName = String(pkg["name"] ?? entry.name);

    // CHECK 1: engines.node exists and matches root
    const pkgEngines = pkg["engines"] as Record<string, string> | undefined;
    const pkgNodeRange = pkgEngines?.["node"];
    if (!pkgNodeRange) {
      violations.push({
        ruleId: "PKG-HEALTH-01",
        packageName,
        severity: "error",
        message: `Missing engines.node in package.json. Root requires "${rootNodeRange ?? ">=24 <25"}".`,
        file: pkgJsonPath,
        fixHint: `Add "engines": { "node": "${rootNodeRange ?? ">=24 <25"}" } to package.json.`,
      });
    } else if (rootNodeRange && pkgNodeRange !== rootNodeRange) {
      violations.push({
        ruleId: "PKG-HEALTH-01",
        packageName,
        severity: "warning",
        message: `engines.node is "${pkgNodeRange}" but root is "${rootNodeRange}".`,
        file: pkgJsonPath,
        fixHint: `Align engines.node with root: "${rootNodeRange}".`,
      });
    }

    // CHECK 2: .github/workflows/ci.yml exists inside package
    const ciWorkflowPath = path.join(pkgDir, ".github", "workflows", "ci.yml");
    if (!fs.existsSync(ciWorkflowPath)) {
      violations.push({
        ruleId: "PKG-HEALTH-02",
        packageName,
        severity: "error",
        message: "Missing .github/workflows/ci.yml — standalone extraction repo will have no CI.",
        file: pkgDir,
        fixHint: "Create .github/workflows/ci.yml inside the package directory with Node 24 setup.",
      });
    }

    // CHECK 3: extract.config.yaml exists
    const extractConfigPath = path.join(pkgDir, "extract.config.yaml");
    if (!fs.existsSync(extractConfigPath)) {
      violations.push({
        ruleId: "PKG-HEALTH-03",
        packageName,
        severity: "warning",
        message: "Missing extract.config.yaml — package cannot be extracted via repo-extract.",
        file: pkgDir,
        fixHint: "Create extract.config.yaml with git remote and extraction settings.",
      });
    }

    // CHECK 4: devDependencies completeness — tools used in scripts must be declared
    const scripts = (pkg["scripts"] ?? {}) as Record<string, string>;
    const devDeps = (pkg["devDependencies"] ?? {}) as Record<string, string>;
    const deps = (pkg["dependencies"] ?? {}) as Record<string, string>;
    const allDeclared = { ...devDeps, ...deps };

    const usedTools = extractToolNames(scripts);
    for (const toolDep of usedTools) {
      if (!(toolDep in allDeclared)) {
        violations.push({
          ruleId: "PKG-HEALTH-04",
          packageName,
          severity: "error",
          message: `Script uses "${toolDep}" but it is not in devDependencies or dependencies. It relies on monorepo hoisting and will fail standalone.`,
          file: pkgJsonPath,
          fixHint: `Add "${toolDep}" to devDependencies in package.json.`,
        });
      }
    }
  }

  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warning");
  const passed = errors.length === 0;

  if (context.outputFormat === "pretty") {
    if (packagesChecked === 0) {
      logger.info("forge.package.health: no published packages found.");
    } else {
      for (const v of violations) {
        if (v.severity === "error") {
          logger.error(`  [${v.ruleId}] ${v.packageName}: ${v.message}`);
        } else {
          logger.warn(`  [${v.ruleId}] ${v.packageName}: ${v.message}`);
        }
      }
      if (passed && warnings.length === 0) {
        logger.success(
          `forge.package.health: all ${packagesChecked} published package(s) healthy.`,
        );
      } else if (passed) {
        logger.warn(
          `forge.package.health: ${packagesChecked} package(s) checked, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`,
        );
      } else {
        const parts: string[] = [];
        parts.push(`${errors.length} error${errors.length === 1 ? "" : "s"}`);
        if (warnings.length > 0)
          parts.push(`${warnings.length} warning${warnings.length === 1 ? "" : "s"}`);
        logger.error(
          `forge.package.health: ${parts.join(", ")} across ${packagesChecked} package(s).`,
        );
      }
    }
  }

  return {
    data: {
      command: "forge.package.health",
      packagesChecked,
      violations,
      passed,
    },
    exitCode: passed ? 0 : 1,
    summary: passed
      ? warnings.length > 0
        ? `All ${packagesChecked} package(s) passed with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`
        : `All ${packagesChecked} package(s) healthy.`
      : `${errors.length} error${errors.length === 1 ? "" : "s"} found across ${packagesChecked} package(s).`,
    nextSteps: errors.map((e) => ({
      action: e.fixHint ?? e.message,
      kind: "required" as const,
    })),
  };
}
