/**
<MODULE_CONTRACT>
<purpose>RFC-1539 spec source resolver — one answer to "where is spec X": vendored docs/specs/ directories (DNA-55) and published spec packages declared in forge.yaml specPackages[] and installed from the workspace root. spec.validate, spec.status and consumer code generators read through it.</purpose>
<non-goals>
  <item>Never writes into node_modules or docs/specs/.</item>
  <item>Never searches nested workspace packages — a spec package is a root dependency (SPEC-17).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1539: resolveSpecSource/listSpecSources + SPEC-15..18 declaration diagnostics</item>
  <item>RFC-1539: package-sourced specs and published consumer validators in Forge</item>
</CHANGE_SUMMARY>
*/

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { loadForgeConfig, type SpecPackageEntry } from "../config/forge-config.ts";

export type SpecSource =
  | { kind: "vendored"; specId: string; dir: string }
  | { kind: "package"; specId: string; dir: string; package: string; version: string };

export interface SpecSourceDiagnostic {
  rule: "SPEC-15" | "SPEC-16" | "SPEC-17" | "SPEC-18";
  severity: "error" | "warning";
  specId?: string;
  message: string;
}

export interface SpecSourceListing {
  sources: SpecSource[];
  diagnostics: SpecSourceDiagnostic[];
}

/** An exact semver pin: no range operators, wildcards, tags or protocols. */
const EXACT_PIN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function rootPin(workspaceRoot: string, pkg: string): string | undefined {
  const manifest = readJson(path.join(workspaceRoot, "package.json"));
  if (!manifest) return undefined;
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = manifest[field] as Record<string, string> | undefined;
    if (deps && typeof deps[pkg] === "string") return deps[pkg];
  }
  return undefined;
}

/** The installed package root and version, resolved from the workspace root only. */
function installedPackage(
  workspaceRoot: string,
  pkg: string,
): { dir: string; version: string } | null {
  try {
    const req = createRequire(path.join(workspaceRoot, "package.json"));
    const manifestPath = req.resolve(`${pkg}/package.json`);
    const manifest = readJson(manifestPath);
    if (!manifest || typeof manifest.version !== "string") return null;
    return { dir: path.dirname(manifestPath), version: manifest.version };
  } catch {
    return null;
  }
}

function specsDirOf(workspaceRoot: string): string {
  try {
    return loadForgeConfig(workspaceRoot).paths.specsDir;
  } catch {
    return "docs/specs";
  }
}

function declaredSpecPackages(workspaceRoot: string): SpecPackageEntry[] {
  try {
    return loadForgeConfig(workspaceRoot).specPackages ?? [];
  } catch {
    return [];
  }
}

/** Vendored spec dirs (those with forge-spec.yaml) plus every resolvable declared package. */
export function listSpecSources(
  workspaceRoot: string,
  declared: SpecPackageEntry[] = declaredSpecPackages(workspaceRoot),
): SpecSourceListing {
  const diagnostics: SpecSourceDiagnostic[] = [];
  const sources: SpecSource[] = [];

  const specsRoot = path.join(workspaceRoot, specsDirOf(workspaceRoot));
  const vendored = existsSync(specsRoot)
    ? readdirSync(specsRoot)
        .filter((name) => existsSync(path.join(specsRoot, name, "forge-spec.yaml")))
        .sort()
    : [];
  for (const name of vendored) {
    sources.push({ kind: "vendored", specId: name, dir: path.join(specsRoot, name) });
  }

  const seen = new Set<string>();
  for (const entry of declared) {
    if (seen.has(entry.id)) {
      diagnostics.push({
        rule: "SPEC-18",
        severity: "error",
        message: `specPackages[] declares id "${entry.id}" more than once`,
      });
      continue;
    }
    seen.add(entry.id);

    const pin = rootPin(workspaceRoot, entry.package);
    if (pin === undefined || !EXACT_PIN.test(pin)) {
      diagnostics.push({
        rule: "SPEC-17",
        severity: "error",
        message: `spec package ${entry.package} must be an exact-pinned dependency of the workspace root package.json (found ${pin === undefined ? "no entry" : `"${pin}"`})`,
      });
    }

    const installed = installedPackage(workspaceRoot, entry.package);
    if (!installed) {
      diagnostics.push({
        rule: "SPEC-16",
        severity: "error",
        message: `spec package ${entry.package} is declared in specPackages[] but not installed — run the package manager install`,
      });
      continue;
    }
    const specId = `${entry.id}-v${installed.version}`;
    sources.push({
      kind: "package",
      specId,
      dir: installed.dir,
      package: entry.package,
      version: installed.version,
    });

    for (const name of vendored) {
      if (name.startsWith(`${entry.id}-v`)) {
        diagnostics.push({
          rule: "SPEC-15",
          severity: "warning",
          specId: name,
          message: `vendored copy of a published spec — delete ${path.relative(workspaceRoot, path.join(specsRoot, name))} and rely on specPackages[] (${entry.package})`,
        });
      }
    }
  }

  return { sources, diagnostics };
}

/**
 * Resolve one spec by full spec id (`<id>-v<version>`) or by package-declared
 * id. A package source wins over a vendored dir of the same spec id; a spec id
 * whose version differs from the installed package throws with the installed
 * version — it never falls back to a vendored copy.
 */
export function resolveSpecSource(workspaceRoot: string, idOrSpecId: string): SpecSource {
  const { sources } = listSpecSources(workspaceRoot);
  const packages = sources.filter(
    (s): s is Extract<SpecSource, { kind: "package" }> => s.kind === "package",
  );
  for (const p of packages) {
    const baseId = p.specId.slice(0, -`-v${p.version}`.length);
    if (idOrSpecId === p.specId || idOrSpecId === baseId) return p;
    if (idOrSpecId.startsWith(`${baseId}-v`)) {
      throw new Error(
        `spec ${idOrSpecId} is package-sourced (${p.package}) but the installed version is ${p.specId} — bump the pin instead of reading a vendored copy`,
      );
    }
  }
  const vendored = sources.find((s) => s.kind === "vendored" && s.specId === idOrSpecId);
  if (vendored) return vendored;
  throw new Error(`spec ${idOrSpecId} not found (vendored or package)`);
}
