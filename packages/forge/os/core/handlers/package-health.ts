/*
<MODULE_CONTRACT>
<purpose>forge.package.health — validate all published packages (private: false) for standalone extraction readiness. Checks engines.node, embedded CI workflow, extract.config.yaml, and devDependencies completeness (no hoisted tool deps).</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not modify files — read-only validation.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>PKG-HEALTH-05: reject any versionBump in extract.config.yaml — version in package.json is source of truth.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
  <item>RFC-1254: PKG-HEALTH-06 lint-surface probe — extractable packages run `pnpm --dir <projectDir> run lint` (eslint fallback), per-package pass/fail, error-severity violation</item>
  <item>RFC-1254: retune PKG-HEALTH-02 — repo-extract generates ci.yml from the config `ci:` provider block, so the check now flags only extractable packages whose exported repo would ship no CI (no ci: provider AND no in-package workflow)</item>
  <item>RFC-1255: PKG-HEALTH-07 generated-CI script contract (build/lint/typecheck/test), PKG-HEALTH-08 repository.url vs git.remote for provenance publish, PKG-HEALTH-09 files[] src-reachability coverage; "extractable": false opt-out suppresses all extract-dependent checks</item>
</CHANGE_SUMMARY>
*/

import * as fs from "../../../src/utils/sync-fs.ts";
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
  lintSurface: Record<string, "pass" | "fail">;
}

export interface LintProbeOutcome {
  ok: boolean;
  detail: string;
}

function defaultLintRunner(projectDir: string, hasLintScript: boolean): LintProbeOutcome {
  const args = hasLintScript
    ? ["--dir", projectDir, "run", "lint"]
    : ["--dir", projectDir, "exec", "eslint", "src/**/*.ts"];
  try {
    fs.execFileSync("pnpm", args, { stdio: "pipe" });
    return { ok: true, detail: "" };
  } catch (err) {
    const stderr =
      err instanceof Error && "stderr" in err ? String((err as { stderr?: unknown }).stderr) : "";
    return { ok: false, detail: (stderr || String(err)).slice(0, 400) };
  }
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

// Reads the `provider:` scalar out of the top-level `ci:` mapping block in an
// extract.config.yaml. Returns null when the block or the key is absent.
function extractCiProvider(raw: string): string | null {
  return extractYamlBlockScalar(raw, "ci", "provider");
}

// Reads a `<subKey>:` scalar nested under a top-level `<topKey>:` mapping block
// in extract.config.yaml. Returns null when the block or key is absent.
function extractYamlBlockScalar(raw: string, topKey: string, subKey: string): string | null {
  const blockMatch = raw.match(new RegExp(`^${topKey}:[ \\t]*$`, "m"));
  if (!blockMatch || blockMatch.index === undefined) return null;
  const after = raw.slice(blockMatch.index + blockMatch[0].length);
  for (const line of after.split("\n")) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break;
    const m = line.match(new RegExp(`^\\s+${subKey}:\\s*(\\S+)\\s*$`));
    if (m) return m[1];
  }
  return null;
}

// RFC-1255 CHECK 9: compute which src/ paths the package.json `files[]`
// whitelist ships. Returns { fullSrc } when `src`/`src/` ships wholesale, or
// the set of shipped dir prefixes + exact file paths otherwise.
function shippedSrcSet(files: string[]): {
  fullSrc: boolean;
  prefixes: string[];
  files: Set<string>;
} {
  const prefixes: string[] = [];
  const exact = new Set<string>();
  let fullSrc = false;
  for (const entry of files) {
    const e = entry.replace(/^\.\//, "");
    if (e === "src" || e === "src/") {
      fullSrc = true;
    } else if (e === "src/" || e.endsWith("/")) {
      if (e.startsWith("src/")) prefixes.push(e.endsWith("/") ? e : `${e}/`);
    } else if (e.startsWith("src/")) {
      exact.add(e);
    }
  }
  return { fullSrc, prefixes, files: exact };
}

const SRC_IMPORT_RE =
  /(?:import|export)[^'"]*from\s+["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']/g;

// RFC-1255 CHECK 9: walk the relative import graph from every shipped src file;
// report src/ files reachable but absent from the files[] whitelist.
function filesSrcGaps(
  pkgDir: string,
  shipped: { fullSrc: boolean; prefixes: string[]; files: Set<string> },
): string[] {
  if (shipped.fullSrc) return [];
  const isShipped = (p: string): boolean =>
    shipped.prefixes.some((pre) => p.startsWith(pre)) || shipped.files.has(p);

  const collect = (dir: string, acc: string[]): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const rel = path.relative(pkgDir, path.join(dir, e.name)).split(path.sep).join("/");
      if (e.isDirectory()) {
        collect(path.join(dir, e.name), acc);
      } else if (/\.tsx?$/.test(e.name) && isShipped(rel)) {
        acc.push(rel);
      }
    }
  };
  const seeds: string[] = [];
  collect(path.join(pkgDir, "src"), seeds);

  const gaps = new Set<string>();
  const visited = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const rel = queue.pop()!;
    if (visited.has(rel)) continue;
    visited.add(rel);
    let source: string;
    try {
      source = fs.readFileSync(path.join(pkgDir, rel), "utf8");
    } catch {
      continue;
    }
    for (const m of source.matchAll(SRC_IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        const disk = path.join(pkgDir, cand);
        if (!cand.startsWith("src/") || !fs.existsSync(disk)) continue;
        if (!isShipped(cand)) gaps.add(cand);
        else if (!visited.has(cand)) queue.push(cand);
        break;
      }
    }
  }
  return [...gaps];
}

// RFC-1255 CHECK 8: normalize a git remote (ssh or https) to "host/owner/repo".
function remoteSlug(remote: string): string | null {
  const m =
    remote.match(/^[a-z]+@([^:/]+):([^/]+)\/(.+?)(?:\.git)?$/) ??
    remote.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : null;
}

// RFC-1255 CHECK 8: extract "host/owner/repo" from a repository.url of the
// `git+https://host/owner/repo.git` (or plain https/ssh) form.
function repositorySlug(repo: unknown): string | null {
  const url =
    typeof repo === "string" ? repo : ((repo as { url?: unknown })?.url as string | undefined);
  if (typeof url !== "string") return null;
  const m =
    url.match(/^[a-z]+@([^:/]+):([^/]+)\/(.+?)(?:\.git)?$/) ??
    url.match(/^(?:git\+)?https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/) ??
    url.match(/^(?:git\+)?ssh:\/\/[^@]+@([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : null;
}

export async function runPackageHealth(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
  lintRunner: (projectDir: string, hasLintScript: boolean) => LintProbeOutcome = defaultLintRunner,
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
        lintSurface: {},
      },
      exitCode: 0,
      summary: "No packages/ directory found — nothing to check.",
    };
  }

  const rootPkg = readJsonFile(path.join(workspaceRoot, "package.json"));
  const rootEngines = rootPkg?.["engines"] as Record<string, string> | undefined;
  const rootNodeRange = rootEngines?.["node"];

  const violations: PackageHealthViolation[] = [];
  const lintSurface: Record<string, "pass" | "fail"> = {};
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

    // RFC-1255: "extractable": false declares a published package that is
    // deliberately NOT extractable (e.g. depends on a private workspace
    // package). Suppresses every extract-dependent check (02,03,05,06,07,08,09)
    // — the alternative, a config that can never succeed, is worse than none.
    const extractable = pkg["extractable"] !== false;
    if (!extractable) continue;

    // Read extract.config.yaml once — CHECK 2 (generated-vs-shipped CI),
    // CHECK 3 (config presence), CHECK 3b (versionBump), CHECK 5 (lint probe)
    // all consume it.
    const extractConfigPath = path.join(pkgDir, "extract.config.yaml");
    let extractConfigRaw: string | null = null;
    if (fs.existsSync(extractConfigPath)) {
      try {
        extractConfigRaw = fs.readFileSync(extractConfigPath, "utf8");
      } catch {
        extractConfigRaw = null;
      }
    }

    // CHECK 2: the extracted repo must carry CI. repo-extract generates
    // .github/workflows/ci.yml from the config `ci:` provider block, so an
    // in-package workflow is only required when no provider is declared.
    const ciProvider = extractConfigRaw === null ? null : extractCiProvider(extractConfigRaw);
    const hasGeneratedCi = ciProvider !== null && ciProvider !== "none";
    const hasInPackageCi = fs.existsSync(path.join(pkgDir, ".github", "workflows", "ci.yml"));
    if (extractConfigRaw !== null && !hasGeneratedCi && !hasInPackageCi) {
      violations.push({
        ruleId: "PKG-HEALTH-02",
        packageName,
        severity: "error",
        message:
          "Extracted repo will have no CI — extract.config.yaml declares no ci: provider and no .github/workflows/ci.yml ships in-package.",
        file: extractConfigPath,
        fixHint:
          'Add "ci:\\n  provider: github-actions" to extract.config.yaml (repo-extract generates the workflow), or commit .github/workflows/ci.yml inside the package directory.',
      });
    }

    // CHECK 3: extract.config.yaml exists
    if (extractConfigRaw === null) {
      violations.push({
        ruleId: "PKG-HEALTH-03",
        packageName,
        severity: "warning",
        message: "Missing extract.config.yaml — package cannot be extracted via repo-extract.",
        file: pkgDir,
        fixHint: "Create extract.config.yaml with git remote and extraction settings.",
      });
    } else {
      // CHECK 3b: versionBump must be absent — version in package.json is source of truth
      const versionBumpMatch = extractConfigRaw.match(/^versionBump:\s*(\S+)/m);
      if (versionBumpMatch) {
        violations.push({
          ruleId: "PKG-HEALTH-05",
          packageName,
          severity: "error",
          message: `extract.config.yaml has versionBump: ${versionBumpMatch[1]} — this auto-increments the version on every extract. The version in package.json is the source of truth.`,
          file: extractConfigPath,
          fixHint:
            "Remove the versionBump line. Manually bump package.json version to the target before extracting.",
        });
      }
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

    // CHECK 5: lint-surface — extractable packages must pass their own lint contract (RFC-1254)
    if (extractConfigRaw !== null) {
      const projectDirMatch = extractConfigRaw.match(/^projectDir:\s*(\S+)\s*$/m);
      const projectDir = projectDirMatch ? path.resolve(workspaceRoot, projectDirMatch[1]) : pkgDir;
      const hasLintScript = typeof scripts["lint"] === "string" && scripts["lint"].length > 0;
      const outcome = lintRunner(projectDir, hasLintScript);
      lintSurface[packageName] = outcome.ok ? "pass" : "fail";
      if (!outcome.ok) {
        violations.push({
          ruleId: "PKG-HEALTH-06",
          packageName,
          severity: "error",
          message: `Lint fails in ${path.relative(workspaceRoot, projectDir) || projectDir} — standalone extraction CI will fail.`,
          file: projectDir,
          fixHint: hasLintScript
            ? `Run "pnpm --dir ${projectDir} run lint" and drain the reported errors.`
            : `Run "pnpm --dir ${projectDir} exec eslint \"src/**/*.ts\"" and drain the reported errors.`,
        });
      }

      // RFC-1255 CHECK 7: generated CI runs build (unless ci.skipBuild),
      // lint, typecheck, test — every missing script is a guaranteed
      // first-run CI failure (ERR_PNPM_NO_SCRIPT). Fires only for the
      // generated contract; an in-package workflow's steps are authored
      // and unknowable here.
      if (hasGeneratedCi) {
        const skipBuild = extractYamlBlockScalar(extractConfigRaw, "ci", "skipBuild") === "true";
        const required = ["lint", "typecheck", "test", ...(skipBuild ? [] : ["build"])];
        const missing = required.filter((s) => typeof scripts[s] !== "string" || !scripts[s]);
        for (const s of missing) {
          violations.push({
            ruleId: "PKG-HEALTH-07",
            packageName,
            severity: "error",
            message: `Generated CI invokes "run ${s}" but package.json has no "${s}" script.`,
            file: pkgJsonPath,
            fixHint:
              s === "typecheck"
                ? 'Add "typecheck": "pnpm exec tsc -p tsconfig.json --noEmit" to scripts.'
                : `Add a "${s}" script to package.json.`,
          });
        }
      }

      // RFC-1255 CHECK 8: provenance verifies repository.url against the
      // Actions repo slug — a missing or mismatched field 422s at publish.
      const ciPublish = extractYamlBlockScalar(extractConfigRaw, "ci", "publish");
      const gitRemote = extractYamlBlockScalar(extractConfigRaw, "git", "remote");
      if (hasGeneratedCi && ciPublish !== "false" && gitRemote) {
        const expected = remoteSlug(gitRemote);
        const actual = repositorySlug(pkg["repository"]);
        if (expected && actual !== expected) {
          violations.push({
            ruleId: "PKG-HEALTH-08",
            packageName,
            severity: "error",
            message: actual
              ? `repository.url resolves to "${actual}" but git.remote is "${expected}" — npm publish --provenance will 422.`
              : `Missing repository.url — npm publish --provenance verifies it against the GitHub repo "${expected}".`,
            file: pkgJsonPath,
            fixHint: `Add "repository": { "type": "git", "url": "git+https://${expected}.git" } to package.json.`,
          });
        }
      }

      // RFC-1255 CHECK 9: a selective files[] whitelist must ship every src/
      // file reachable from the shipped src set — consumers follow shipped
      // sources and hit TS2307 on the gap.
      const filesField = pkg["files"];
      if (Array.isArray(filesField)) {
        const gaps = filesSrcGaps(pkgDir, shippedSrcSet(filesField as string[]));
        for (const gap of gaps) {
          violations.push({
            ruleId: "PKG-HEALTH-09",
            packageName,
            severity: "error",
            message: `"${gap}" is reachable from shipped src/ entries but missing from files[] — published consumers hit TS2307.`,
            file: pkgJsonPath,
            fixHint: `Add "${gap}" (or its parent directory) to the files[] array in package.json.`,
          });
        }
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
      lintSurface,
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
