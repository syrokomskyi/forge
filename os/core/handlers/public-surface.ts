/*
<MODULE_CONTRACT>
<purpose>forge.public-surface.validate — check consistency between README.md, package.json, and docs/ structure. Enforces SURFACE-01..05 rules from RFC-1080.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not modify files — read-only validation.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1080: initial public-surface consistency validator — README length, Node version match, .tgz absence, docs/ structure, required root files.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface SurfaceCheck {
  rule: string;
  message: string;
  status: "pass" | "warn" | "fail";
}

export interface PublicSurfaceResult {
  command: "forge.public-surface.validate";
  status: "pass" | "fail";
  checks: SurfaceCheck[];
}

const REQUIRED_DOCS_FILES = [
  "docs/getting-started.md",
  "docs/concepts/why-forge.md",
  "docs/reference/cli.md",
];

const REQUIRED_ROOT_FILES = [
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
];

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractNodeMajorVersion(range: string): number | null {
  const match = range.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export async function runPublicSurfaceValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<PublicSurfaceResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const checks: SurfaceCheck[] = [];

  const readmePath = path.join(workspaceRoot, "README.md");
  const packageJsonPath = path.join(workspaceRoot, "package.json");

  const readmeContent = fs.existsSync(readmePath)
    ? fs.readFileSync(readmePath, "utf8")
    : "";
  const readmeLines = readmeContent.split("\n").length;

  const pkg = readJsonFile(packageJsonPath);

  // SURFACE-01: README length (warning)
  checks.push({
    rule: "SURFACE-01",
    message: `README.md is ${readmeLines} lines (${readmeLines <= 300 ? "under 300" : "over 300"})`,
    status: readmeLines <= 300 ? "pass" : "warn",
  });

  // SURFACE-02: Node version consistency (error)
  if (pkg) {
    const engines = pkg["engines"] as Record<string, string> | undefined;
    const nodeRange = engines?.["node"];
    const pkgMajor = nodeRange ? extractNodeMajorVersion(nodeRange) : null;

    if (pkgMajor !== null) {
      const readmeNodeMatch = readmeContent.match(/Node(?:\.js)?\s+v?(\d+)/gi);
      const readmeNodeVersions = readmeNodeMatch
        ? readmeNodeMatch.map((m) => parseInt(m.match(/(\d+)/)![1], 10))
        : [];

      const mismatched = readmeNodeVersions.filter((v) => v !== pkgMajor);
      checks.push({
        rule: "SURFACE-02",
        message:
          mismatched.length === 0
            ? `Node version consistent: ${nodeRange}`
            : `README references Node ${mismatched.join(", ")} but package.json requires ${nodeRange}`,
        status: mismatched.length === 0 ? "pass" : "fail",
      });
    } else {
      checks.push({
        rule: "SURFACE-02",
        message: "package.json missing engines.node",
        status: "fail",
      });
    }
  } else {
    checks.push({
      rule: "SURFACE-02",
      message: "package.json not found",
      status: "fail",
    });
  }

  // SURFACE-03: No .tgz files in root (error)
  const tgzFiles = fs
    .readdirSync(workspaceRoot)
    .filter((f) => f.endsWith(".tgz"));
  checks.push({
    rule: "SURFACE-03",
    message:
      tgzFiles.length === 0
        ? "No .tgz files in root"
        : `Found ${tgzFiles.length} .tgz file(s): ${tgzFiles.join(", ")}`,
    status: tgzFiles.length === 0 ? "pass" : "fail",
  });

  // SURFACE-04: docs/ directory with required files (error)
  const missingDocs = REQUIRED_DOCS_FILES.filter(
    (f) => !fs.existsSync(path.join(workspaceRoot, f)),
  );
  checks.push({
    rule: "SURFACE-04",
    message:
      missingDocs.length === 0
        ? "docs/ directory exists with required files"
        : `Missing docs files: ${missingDocs.join(", ")}`,
    status: missingDocs.length === 0 ? "pass" : "fail",
  });

  // SURFACE-05: Required root files (warning)
  const missingRoot = REQUIRED_ROOT_FILES.filter(
    (f) => !fs.existsSync(path.join(workspaceRoot, f)),
  );
  checks.push({
    rule: "SURFACE-05",
    message:
      missingRoot.length === 0
        ? "Required root files present (CONTRIBUTING.md, SECURITY.md, CHANGELOG.md)"
        : `Missing root files: ${missingRoot.join(", ")}`,
    status: missingRoot.length === 0 ? "pass" : "warn",
  });

  const hasFails = checks.some((c) => c.status === "fail");
  const status: "pass" | "fail" = hasFails ? "fail" : "pass";

  if (outputFormat === "pretty") {
    logger.section("Forge Public Surface Validate");
    for (const check of checks) {
      const icon =
        check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✖";
      const fn =
        check.status === "pass"
          ? logger.success
          : check.status === "warn"
            ? logger.warn
            : logger.error;
      fn(`${icon} [${check.rule}] ${check.message}`);
    }
    if (status === "pass") {
      logger.success("All public surface checks passed.");
    } else {
      logger.error("Some public surface checks failed.");
    }
  }

  return {
    data: {
      command: "forge.public-surface.validate",
      status,
      checks,
    },
    exitCode: hasFails ? 1 : 0,
    summary:
      status === "pass"
        ? "forge.public-surface.validate: all checks passed"
        : `forge.public-surface.validate: ${checks.filter((c) => c.status === "fail").length} fail(s), ${checks.filter((c) => c.status === "warn").length} warn(s)`,
  };
}
