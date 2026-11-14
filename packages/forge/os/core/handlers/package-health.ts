/*
<MODULE_CONTRACT>
<purpose>forge.package.health — validate all published packages (private: false) for standalone extraction readiness. Checks engines.node, embedded CI workflow, extract.config.yaml, and devDependencies completeness (no hoisted tool deps).</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not modify files — read-only validation.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>parseHealthScanConfig + isShippedEntry mirror repo-extract's copy filter through the SAME decision inputs it consumes — real YAML parse (comment-bearing lists survive), isKeyMaterial default excludePathSegments (.input/signing-key, .input/batches) when the key is absent, isDbFile default .db excludeExtensions, copyFiltered's BASE_IGNORE_DIRS/IGNORE_FILES for non-standalone exports, and statSync symlink-following like cp's filter — a hand-maintained list or partial parser drifts from what the extract actually ships (F-0064's whole premise).</item>
  <item>scanFixturePathEscapes judges each candidate via one shared literal core (literalEscapesInLine: TS-family quoted mode, raw `../` chain mode elsewhere, same-line pkg-health-10: suppression) while doc files (prose links are never resolved) and binary/generated files (UTF-8 noise, .map sources) are exempt wholesale; pkgHealth10Suppressions in extract.config.yaml covers files that cannot carry an in-source comment such as JSON (RFC-1517 r1).</item>
  <item>loadCommandInventory unions context.commandRegistry.listCommands() with docs/command-manifest.generated.yaml — the getLiveCommands merge precedent from os/rfc/handlers/lifecycle.ts — because `werkstatt run` injects no commandRegistry and lazy-loaded modules are invisible to it; a registry-only read would silently disable the docs gate on the primary dispatch path (RFC-1518 r1, deviation D-001).</item>
  <item>scanDocsSurface resolves dead-reference candidates through two mechanical disambiguators: first-segment namespace membership (property paths like context.site and config keys like bindings.commands are never command refs) and registered-or-TLD-tail resolution (registered forge.dev/context.index.build count for coverage while unregistered warpgogol.com/context.io are domains, not commands) — without them the gate produced ~230 false positives on the real workspace (RFC-1518 r1, deviation D-002).</item>
  <item>The docs gate runs before the private/extractable skips so PKG-HEALTH-12 dead references judge every package's docs (dead refs are package-local), while PKG-HEALTH-11 coverage stays scoped to published packages — private packages (werkstatt-site's ~500-command surface) document commands in site-facing docs outside DOCS_SURFACE, and the manifest merge preserves manifest module provenance when registry entries omit module (RFC-1518 r1, deviation D-003).</item>
  <item>Module attribution is provider-aware: deriveModulePackageMap returns separate workshop/site maps because module names collide across buckets (deploy is engine() AND sitePlugin()), and each command resolves through the map matching its manifest siteScope — a flat last-write-wins map silently misattributed the engine deploy.* family to the private site package (RFC-1518 r2, deviation D-004).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1518: attribution merge, private-package docs gate, suppression journal</item>
  <item>RFC-1518: key decision for private-package docs-gate scope</item>
  <item>RFC-1518: provider-aware module attribution, per-rule markers, tld-tail scoping</item>
  <item>RFC-1518: key decision for provider-aware attribution</item>
  <item>ADR-0131: pkg-health-10 suppression on the line above the literal

literalEscapesInLine accepts a // pkg-health-10: comment directly above the literal (one-line reach); the publish at-ref scan fetches that line via git show only for candidate lines; bin/cli.ts drops its prettier-ignore lines.</item>
  <history>PKG-HEALTH-05, RFC-1097, RFC-1254, RFC-1255, RFC-1517, RFC-1518</history>
</CHANGE_SUMMARY>
*/

import * as fs from "../../../src/utils/sync-fs.ts";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { collectSkillDocFiles, lintSkillDocFiles } from "../../../src/validators/skill-doc-sync.ts";
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
  /** RFC-1518: journaled docs-gate suppressions (file:line + reason). */
  suppressions?: DocsSuppression[];
}

export interface LintProbeOutcome {
  ok: boolean;
  detail: string;
}

// RFC-1517: one `../` chain literal escaping the package root — the F-0064
// defect class that only surfaced post-extract as ENOENT.
export interface FixtureEscape {
  /** Shipped file, relative to the scanned package root (as passed in). */
  file: string;
  line: number;
  /** The offending `../` chain literal as written. */
  literal: string;
  /** Absolute resolution showing the escape. */
  resolvedTo: string;
}

/**
 * The shipped-set + suppression view of one extract.config.yaml. Mirrors
 * repo-extract's copy filter exactly: `isKeyMaterial` defaults
 * `excludePathSegments` to the signing-key guards when the key is ABSENT, and
 * `isDbFile` defaults `excludeExtensions` to `[".db"]`. `monorepoMode`
 * distinguishes copyFiltered (non-standalone exports additionally drop
 * BASE_IGNORE_DIRS/IGNORE_FILES) from copyStandalonePackage — the same
 * `standalone || projectDir startsWith "packages/"` predicate extract.js
 * applies.
 */
export interface HealthScanConfig {
  ignoreDirs: Set<string>;
  excludeSegments: string[];
  excludeExtensions: string[];
  /** `pkgHealth10Suppressions:` — package-relative paths skipped by the scan. */
  suppressions: Set<string>;
  /** False for standalone exports — copyFiltered's extra ignore sets apply. */
  monorepoMode: boolean;
}

const DEFAULT_KEY_SEGMENTS = [".input/signing-key", ".input/batches"];
const BASE_IGNORE_DIRS = new Set([
  "node_modules",
  ".turbo",
  "dist",
  ".env",
  ".DS_Store",
  "Thumbs.db",
]);
const IGNORE_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "changelog.config.yaml",
]);

/** Parse the scan-relevant keys of one extract.config.yaml (real YAML — comments and flow style included). */
export function parseHealthScanConfig(configRaw: string | null): HealthScanConfig {
  let parsed: Record<string, unknown> = {};
  if (configRaw !== null) {
    try {
      const doc = parseYaml(configRaw) as unknown;
      if (doc !== null && typeof doc === "object") parsed = doc as Record<string, unknown>;
    } catch {
      // An unparseable config fails repo-extract itself — scan with defaults.
      parsed = {};
    }
  }
  const strList = (key: string): string[] | undefined => {
    const v = parsed[key];
    return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : undefined;
  };
  const projectDir = typeof parsed["projectDir"] === "string" ? parsed["projectDir"] : "";
  const standalone = parsed["standalone"] === true || projectDir.startsWith("packages/");
  return {
    ignoreDirs: new Set([
      ...(standalone ? ["node_modules", ".turbo"] : [...BASE_IGNORE_DIRS]),
      ...(strList("ignoreDirs") ?? []),
    ]),
    excludeSegments: strList("excludePathSegments") ?? DEFAULT_KEY_SEGMENTS,
    excludeExtensions: strList("excludeExtensions") ?? [".db"],
    suppressions: new Set(strList("pkgHealth10Suppressions") ?? []),
    monorepoMode: !standalone,
  };
}

// String-literal-aware mode for TS-family sources; other extensions get the
// raw `../` chain scan (bounded by root-escape resolution, escaped by the
// same-line `pkg-health-10:` suppression comment).
const TS_FAMILY_RE = /\.(?:ts|mts|tsx|cts)$/;
// Doc files carry `../` only as prose links — never resolved, always noise.
const DOC_FILE_RE = /\.(?:md|markdown|mdx|txt|adoc|rst)$/i;
// Binary/generated bytes produce UTF-8 noise (and .map sources arrays) —
// skipped like git grep -I's binary exclusion.
const BINARY_FILE_RE =
  /\.(?:png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|wasm|pdf|mp[34]|webm|mov|map|db|sqlite)$/i;
const QUOTED_PARENT_RE = /["'`]([^"'`\n]*(?:\.\.\/)+[^"'`\n]*)["'`]/g;
const RAW_PARENT_RE = /(?:\.\.\/)+[^\s"'`)\],;:}]*/g;
const SUPPRESS_RE = /pkg-health-10:/;
/** ADR-0131: a line comment directly above the literal carrying the token. */
const PREV_LINE_SUPPRESS_RE = new RegExp("^\\s*//.*pkg-health-10:");

/** File extensions the fixture scan judges (docs and binaries are excluded). */
export function fixtureScanSkipped(file: string): boolean {
  return DOC_FILE_RE.test(file) || BINARY_FILE_RE.test(file);
}

/**
 * The single `../` literal matcher shared by the working-tree scan and the
 * publish at-ref scan — apply the per-extension mode to one source line and
 * report every literal resolving outside `rootAbs`. A `pkg-health-10:`
 * suppression on the literal's own line, or (ADR-0131) in a `//` line comment
 * directly above it — the placement prettier keeps stable — silences the
 * line; reach is exactly one line. JSON and fixture templates cannot carry
 * comments — those go through the config suppressions list instead.
 */
export function literalEscapesInLine(
  file: string,
  text: string,
  lineNo: number,
  fileDirAbs: string,
  rootAbs: string,
  prevLine?: string,
): FixtureEscape[] {
  if (SUPPRESS_RE.test(text)) return [];
  if (prevLine !== undefined && PREV_LINE_SUPPRESS_RE.test(prevLine)) return [];
  const re = TS_FAMILY_RE.test(file) ? QUOTED_PARENT_RE : RAW_PARENT_RE;
  const out: FixtureEscape[] = [];
  for (const m of text.matchAll(re)) {
    const literal = m[1] ?? m[0];
    if (!literal.includes("../")) continue;
    const resolvedTo = path.resolve(fileDirAbs, literal);
    if (resolvedTo !== rootAbs && !resolvedTo.startsWith(rootAbs + path.sep)) {
      out.push({ file, line: lineNo, literal, resolvedTo });
    }
  }
  return out;
}

/**
 * Scan shipped files for `../` path literals that resolve outside
 * `packageRoot` — the fixture-path defect class that passed monorepo suites
 * and ENOENT'd only inside the standalone extract (F-0064). `shippedFiles`
 * are package-root-relative paths on disk; `suppressions` (from
 * `pkgHealth10Suppressions` in extract.config.yaml) skips files that cannot
 * carry an in-source comment. Shared by PKG-HEALTH-10 and the publish
 * `preflight-extract-gates` step so both report the same escapes.
 */
export function scanFixturePathEscapes(
  packageRoot: string,
  shippedFiles: string[],
  suppressions?: ReadonlySet<string>,
): FixtureEscape[] {
  const root = path.resolve(packageRoot);
  const escapes: FixtureEscape[] = [];
  for (const file of shippedFiles) {
    if (suppressions?.has(file) || fixtureScanSkipped(file)) continue;
    const abs = path.join(root, file);
    let source: string;
    try {
      source = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      escapes.push(
        ...literalEscapesInLine(file, lines[i]!, i + 1, path.dirname(abs), root, lines[i - 1]),
      );
    }
  }
  return escapes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// RFC-1518 CHECKS 11/12: the package's declared docs surface diffed against
// the live command inventory — PKG-HEALTH-11 covers registered-but-undocumented
// commands, PKG-HEALTH-12 covers doc tokens resolving to no registered command
// (the REMEDIATION-04 dead-token class applied to authored reference docs).
export const DOCS_SURFACE = ["docs/**/*.md", "README.md", "AGENTS.md"] as const;
export const DOCS_SURFACE_EXCLUDES = [
  "docs/audits/archive/**",
  "**/CHANGELOG.md",
  "**/*.generated.md",
] as const;
const DOCS_SURFACE_EXCLUDE_RES = [
  /(^|\/)docs\/audits\/archive\//,
  /(^|\/)CHANGELOG\.md$/,
  /\.generated\.md$/,
];

// A command token is x.y-shaped with every segment starting with a letter —
// numeric segments (versions like 9.1.0) and uppercase names (AGENTS.md)
// never qualify. Tokens ending in a file extension or common TLD are config
// paths or domains, not command mentions (known non-command dotted paths).
const DOC_TOKEN_RE = /\b([a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+)\b/g;
// File-extension tails — applied unconditionally (a command never ends in one).
const DOC_REF_EXT_RE =
  /\.(?:ts|mts|cts|js|mjs|cjs|jsx|tsx|json|ya?ml|toml|md|mdx|markdown|astro|css|scss|less|html|xml|svg|png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|wasm|pdf|mp[34]|webm|mov|map|db|sqlite3?|lock|sh|bash|zsh|fish|py|rb|go|rs|java|kt|cs|php|pl|lua|sql|csv|tsv|txt|log|env|ini|cfg|conf|d.ts|editorconfig|gitignore|npmrc|dockerfile|jsonl|hex|pem)$/i;
// TLD-shaped tails (domains, not commands) — fallback heuristic only when no
// live inventory is available; registered namespaces can end in one
// (forge.dev, forge.build would otherwise be filtered out).
const DOC_TLD_TAIL_RE =
  /\.(?:com|org|net|io|dev|ai|app|de|uk|eu|co|me|cloud|site|xyz|build|systems|watch|pro|info|gg|wtf|zone|land|run)$/i;
const DOC_SUPPRESS_11_RE = /pkg-health-11(?:\s*\|\s*pkg-health-12)?:\s*([^\n]*?)\s*(?:-->\s*)?$/;
const DOC_SUPPRESS_12_RE = /(?:pkg-health-11\s*\|\s*)?pkg-health-12:\s*([^\n]*?)\s*(?:-->\s*)?$/;

export interface DocsSuppression {
  ruleId: "PKG-HEALTH-11" | "PKG-HEALTH-12";
  /** Owning package name — suppressions aggregate across the whole workspace. */
  packageName?: string;
  file: string;
  line: number;
  token: string;
  reason: string;
}

interface DocsSurfaceScan {
  /** All command-shaped tokens on unsuppressed surface lines. */
  documented: Set<string>;
  /** Tokens exempted from coverage by a same-line pkg-health-11 marker. */
  suppressed11: Map<string, DocsSuppression>;
  /** Dead-reference candidates: token → first file:line sighting. */
  refs: Map<string, { file: string; line: number }>;
  suppressions: DocsSuppression[];
}

/** Collect the package's DOCS_SURFACE files — docs trees, README, AGENTS — minus the fixed excludes. */
export function collectDocsSurfaceFiles(pkgDir: string): string[] {
  const files: string[] = [];
  const docsDir = path.join(pkgDir, "docs");
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name.endsWith(".md")) files.push(abs);
    }
  };
  if (fs.existsSync(docsDir)) walk(docsDir);
  for (const top of ["README.md", "AGENTS.md"]) {
    const abs = path.join(pkgDir, top);
    if (fs.existsSync(abs)) files.push(abs);
  }
  return files
    .filter((f) => {
      const rel = path.relative(pkgDir, f).split(path.sep).join("/");
      return !DOCS_SURFACE_EXCLUDE_RES.some((re) => re.test(rel));
    })
    .sort();
}

/**
 * Scan one package's docs surface: build the documented-token set, the
 * pkg-health-11 exemption set, and the dead-reference candidates (tokens on
 * unsuppressed lines). pkg-health-12 markers exempt their whole line.
 */
export function scanDocsSurface(
  pkgDir: string,
  files: string[],
  commandNamespaces?: ReadonlySet<string>,
  registeredCommands?: ReadonlySet<string>,
): DocsSurfaceScan {
  const documented = new Set<string>();
  const suppressed11 = new Map<string, DocsSuppression>();
  const refs = new Map<string, { file: string; line: number }>();
  const suppressions: DocsSuppression[] = [];
  for (const abs of files) {
    const rel = path.relative(pkgDir, abs).split(path.sep).join("/");
    let source: string;
    try {
      source = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const tokens = [...line.matchAll(DOC_TOKEN_RE)]
        .map((m) => m[1]!)
        .filter((t) => !DOC_REF_EXT_RE.test(t))
        .filter((t) => {
          if (!commandNamespaces) return !DOC_TLD_TAIL_RE.test(t);
          // A token whose first segment is no registered command namespace is
          // a property path (import.meta.url), config key (bindings.commands),
          // or prose — never a command reference.
          return commandNamespaces.has(t.split(".", 1)[0]!);
        })
        // Registered commands always count (forge.dev, context.index.build).
        // Unregistered tokens ending in a TLD tail are domains (warpgogol.com)
        // or TLD-shaped property paths (context.io) — never command refs.
        // Registered commands always count (forge.dev, context.index.build).
        // Unregistered TWO-segment tokens ending in a TLD tail are domains
        // (warpgogol.com) or TLD-shaped property paths (context.io); a 3+
        // segment token under a registered namespace (deploy.smoke.run after
        // removal) stays a dead-reference candidate — never TLD-exempt.
        .filter(
          (t) =>
            !registeredCommands ||
            registeredCommands.has(t) ||
            t.split(".").length > 2 ||
            !DOC_TLD_TAIL_RE.test(t),
        );
      const s11 = line.match(DOC_SUPPRESS_11_RE);
      const s12 = line.match(DOC_SUPPRESS_12_RE);
      // A marker with an empty reason does not suppress — an exemption needs
      // a justification. Both markers are evaluated: a line may carry an 11
      // and a 12 marker (or the combined pkg-health-11|pkg-health-12 form).
      const reason = (m: RegExpMatchArray | null) => (m?.[1] ?? "").replace(/-->\s*$/, "").trim();
      const m11 = s11 ? reason(s11) || null : null;
      const m12 = s12 ? reason(s12) || null : null;
      for (const token of tokens) {
        if (m11) {
          const entry = {
            ruleId: "PKG-HEALTH-11" as const,
            file: rel,
            line: i + 1,
            token,
            reason: m11,
          };
          suppressed11.set(token, entry);
          suppressions.push(entry);
        } else {
          documented.add(token);
        }
        if (m12) {
          suppressions.push({
            ruleId: "PKG-HEALTH-12",
            file: rel,
            line: i + 1,
            token,
            reason: m12,
          });
          documented.add(token);
        } else if (!refs.has(token)) {
          refs.set(token, { file: rel, line: i + 1 });
        }
      }
    }
  }
  return { documented, suppressed11, refs, suppressions };
}

/**
 * Map kernel module names → owning package dir — the same module enumeration
 * the workspace registry (and command.manifest.generate) was built from:
 * tools/kernel.config.ts inline loaders plus the WORKSHOP_MODULE_MAP buckets
 * in werkstatt-engine's module-map.ts. Never a hand-maintained list.
 * Returns separate workshop/site maps — module names can collide across
 * buckets (deploy is both engine() and sitePlugin()) and commands attribute
 * through the map matching their siteScope.
 */
export function deriveModulePackageMap(workspaceRoot: string): {
  workshop: Map<string, string>;
  site: Map<string, string>;
} {
  const out = new Map<string, string>();
  const site = new Map<string, string>();
  const mmPath = path.join(
    workspaceRoot,
    "packages",
    "werkstatt-engine",
    "src",
    "kernel",
    "module-map.ts",
  );
  try {
    const mm = fs.readFileSync(mmPath, "utf8");
    const bucketToConst: Record<string, string> = {
      engine: "ENGINE",
      sitePlugin: "SITE",
      forge: "FORGE",
    };
    const constToSpec: Record<string, string> = {};
    for (const m of mm.matchAll(/const (\w+) = "(@warpgogol\/[^"]+)"/g)) constToSpec[m[1]!] = m[2]!;
    for (const m of mm.matchAll(/["']?([\w-]+)["']?:\s*(engine|sitePlugin|forge)\(/g)) {
      const spec = constToSpec[bucketToConst[m[2]!]!];
      // Module names can collide across buckets (deploy: engine + sitePlugin) —
      // keep the maps separate so siteScope commands resolve via SITE only.
      if (spec) (m[2] === "sitePlugin" ? site : out).set(m[1]!, `packages/${spec.split("/")[1]}`);
    }
  } catch {
    // module-map absent — inline loaders still map
  }
  const kcPath = path.join(workspaceRoot, "tools", "kernel.config.ts");
  try {
    const kc = fs.readFileSync(kcPath, "utf8");
    for (const m of kc.matchAll(
      /["']?(\w[\w-]*)["']?:\s*async[^=]*=>[^;]*?import\("(@warpgogol\/[^"]+)"/g,
    )) {
      out.set(m[1]!, `packages/${m[2]!.split("/")[1]}`);
    }
  } catch {
    // no kernel config — inventory attribution is empty
  }
  return { workshop: out, site };
}

/**
 * The live command inventory: context.commandRegistry (the same enumeration
 * command.manifest.generate consumes) UNION docs/command-manifest.generated.yaml
 * — the getLiveCommands merge pattern from os/rfc/handlers/lifecycle.ts.
 * Registry entries win on collision; the manifest covers commands whose modules
 * are not loaded in the current dispatch (werkstatt run injects no registry;
 * site-scope modules live outside the forge registry).
 */
export function loadCommandInventory(
  workspaceRoot: string,
  commandRegistry?: {
    listCommands(): Array<{ name: string; module?: string; siteScope?: boolean }>;
  },
): Array<{ name: string; module?: string; siteScope?: boolean }> {
  const byName = new Map<string, { name: string; module?: string; siteScope?: boolean }>();
  const manifestPath = path.join(workspaceRoot, "docs", "command-manifest.generated.yaml");
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = parseYaml(raw) as {
      commands?: Array<{
        name?: unknown;
        module?: unknown;
        siteScope?: unknown;
        providers?: unknown;
      }>;
    } | null;
    for (const c of parsed?.commands ?? []) {
      if (typeof c.name === "string" && c.name.length > 0) {
        byName.set(c.name, {
          name: c.name,
          module: typeof c.module === "string" ? c.module : undefined,
          siteScope:
            typeof c.siteScope === "boolean"
              ? c.siteScope
              : Array.isArray(c.providers) && c.providers.includes("site-module")
                ? true
                : undefined,
        });
      }
    }
  } catch {
    // manifest absent or unparsable — registry-only inventory
  }
  for (const c of commandRegistry?.listCommands() ?? []) {
    // Merge, don't overwrite: ForgeCliRegistry entries carry no `module`, so a
    // bare set() would erase the manifest's provenance under the standalone CLI.
    const prev = byName.get(c.name);
    byName.set(c.name, {
      name: c.name,
      module: c.module ?? prev?.module,
      siteScope: c.siteScope ?? prev?.siteScope,
    });
  }
  return [...byName.values()];
}

/**
 * Whether repo-extract's copy filter would ship one entry — shared by the
 * working-tree walk (PKG-HEALTH-10) and the at-ref enumeration (publish
 * preflight) so both judge the same set. `rel` is package-root-relative.
 */
export function isShippedEntry(
  rel: string,
  name: string,
  isDir: boolean,
  cfg: HealthScanConfig,
): boolean {
  if (cfg.ignoreDirs.has(name)) return false;
  if (isDir) return !cfg.excludeSegments.some((seg) => rel.includes(seg));
  if (name.endsWith(".tsbuildinfo")) return false;
  if (cfg.monorepoMode && IGNORE_FILES.has(name)) return false;
  if (cfg.excludeSegments.some((seg) => rel.includes(seg))) return false;
  if (cfg.excludeExtensions.some((ext) => name.endsWith(ext))) return false;
  return true;
}

/**
 * Derive the file set repo-extract will ship for a package — a walk of
 * `projectRoot` honoring the same config keys the copy filters consume (see
 * parseHealthScanConfig). Symlinks are followed through statSync like
 * repo-extract's `cp` filter; a realpath-set bounds link cycles. Never a
 * hand-maintained file list.
 */
export function deriveShippedFiles(projectRoot: string, extractConfigRaw: string | null): string[] {
  const cfg = parseHealthScanConfig(extractConfigRaw);
  const root = path.resolve(projectRoot);
  const shipped: string[] = [];
  const visited = new Set<string>();
  const collect = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      // Dirent.isFile()/isDirectory() are false for symlinks — repo-extract's
      // cp stats through links, so the scan must as well.
      let stats: fs.Stats | null = null;
      if (e.isSymbolicLink()) {
        try {
          stats = fs.statSync(abs);
        } catch {
          stats = null;
        }
      }
      const isDir = stats ? stats.isDirectory() : e.isDirectory();
      const isFile = stats ? stats.isFile() : e.isFile();
      if (!isShippedEntry(rel, e.name, isDir, cfg)) continue;
      if (isDir) {
        let real = abs;
        try {
          real = fs.realpathSync(abs);
        } catch {
          // keep the syntactic path
        }
        if (visited.has(real)) continue;
        visited.add(real);
        collect(abs);
      } else if (isFile) {
        shipped.push(rel);
      }
    }
  };
  collect(root);
  return shipped.sort();
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
  const suppressions: DocsSuppression[] = [];
  let packagesChecked = 0;

  // RFC-1518 CHECKS 11/12 inputs — the live command inventory (registry
  // union generated manifest, the getLiveCommands merge), attributed to
  // owning packages through the kernel module enumeration.
  const commandInfos = loadCommandInventory(workspaceRoot, context.commandRegistry);
  const allCommands = new Set(commandInfos.map((c) => c.name));
  const allNamespaces = new Set(commandInfos.map((c) => c.name.split(".", 1)[0]!));
  const moduleToPkg = deriveModulePackageMap(workspaceRoot);
  const pkgCommands = new Map<string, string[]>();
  let attributed = 0;
  for (const c of commandInfos) {
    // Provider-aware attribution: a module name can exist in both the workshop
    // and site buckets (deploy does), so siteScope commands resolve via the
    // site map only — a last-write-wins flat map silently misattributes.
    const map = c.siteScope === true ? moduleToPkg.site : moduleToPkg.workshop;
    const pkg = c.module !== undefined ? map.get(c.module) : undefined;
    if (pkg === undefined) continue;
    attributed++;
    (pkgCommands.get(pkg) ?? pkgCommands.set(pkg, []).get(pkg)!).push(c.name);
  }

  const entries = fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    const pkgDir = path.join(packagesDir, entry.name);
    const pkgJsonPath = path.join(pkgDir, "package.json");
    const pkg = readJsonFile(pkgJsonPath);
    if (!pkg) continue;

    const isPrivate = pkg["private"] === true;
    const packageName = String(pkg["name"] ?? entry.name);

    // RFC-1518 CHECKS 11/12: the package's declared docs surface diffed
    // against the live command inventory (F-0073). Coverage counts a token
    // documented anywhere on the surface; dead refs flag at doc:line. Runs
    // for EVERY package with a package.json — docs drift is orthogonal to
    // publishability, so private/extractable:false packages are scanned too.
    if (commandInfos.length > 0) {
      const rel = path.relative(workspaceRoot, pkgDir).split(path.sep).join("/");
      const surfaceFiles = collectDocsSurfaceFiles(pkgDir);
      const scan = scanDocsSurface(pkgDir, surfaceFiles, allNamespaces, allCommands);
      suppressions.push(...scan.suppressions.map((s) => ({ ...s, packageName })));
      const expectedDoc = fs.existsSync(path.join(pkgDir, "docs", "reference", "cli.md"))
        ? "docs/reference/cli.md"
        : "README.md";
      // Coverage applies to published packages — the command's stated contract.
      // Private packages (site plugin, lifecycle core) document their command
      // surfaces in site-facing docs outside this audit; their dead refs still
      // flag via PKG-HEALTH-12 (deviation D-003).
      for (const cmd of isPrivate ? [] : (pkgCommands.get(rel) ?? [])) {
        if (!scan.documented.has(cmd) && !scan.suppressed11.has(cmd)) {
          violations.push({
            ruleId: "PKG-HEALTH-11",
            packageName,
            severity: "error",
            message: `registered command "${cmd}" appears in no docs-surface file — document it in ${expectedDoc}`,
            file: pkgDir,
            fixHint: `Add a "${cmd}" reference to ${expectedDoc}, or journal a same-line "<!-- pkg-health-11: <reason> -->" exemption.`,
          });
        }
      }
      for (const [token, at] of [...scan.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (!allCommands.has(token)) {
          violations.push({
            ruleId: "PKG-HEALTH-12",
            packageName,
            severity: "error",
            message: `${at.file}:${at.line} references "${token}" — no such registered command`,
            file: path.join(pkgDir, at.file),
            fixHint: `Fix the reference to a registered command, or journal a same-line "<!-- pkg-health-12: <reason> -->" exemption.`,
          });
        }
      }

      // RFC-1585 CHECK 13 — skill-count claims and <!-- forge:skills-* -->
      // marked regions drifted from FORGE_SKILLS. The doc-sync surface is a
      // superset of DOCS_SURFACE (adds README variants, drops record trees).
      const docSync = await lintSkillDocFiles(pkgDir, collectSkillDocFiles(pkgDir));
      for (const d of docSync.drift) {
        violations.push({
          ruleId: "PKG-HEALTH-13",
          packageName,
          severity: "error",
          message: `${d.file}:${d.line} ${d.kind} — found "${d.found}", registry renders "${d.expected}"`,
          file: path.join(pkgDir, d.file),
          fixHint: `Run "forge skill.doc-sync --write" to re-render marked regions; for intentional pack-specific claims journal a same-line "<!-- forge-skill-count:ok: <reason> -->" exemption.`,
        });
      }
    }

    if (isPrivate) continue;

    packagesChecked++;

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

      // RFC-1517 CHECK 10: a `../` literal in a shipped file that resolves
      // outside the package root passes the monorepo suite and ENOENTs only
      // inside the standalone extract (F-0064). Same scan the publish
      // preflight runs — the defect surfaces here on routine health runs.
      const healthProjectDir = projectDirMatch
        ? path.resolve(workspaceRoot, projectDirMatch[1])
        : pkgDir;
      const healthScanCfg = parseHealthScanConfig(extractConfigRaw);
      for (const esc of scanFixturePathEscapes(
        healthProjectDir,
        deriveShippedFiles(healthProjectDir, extractConfigRaw),
        healthScanCfg.suppressions,
      )) {
        violations.push({
          ruleId: "PKG-HEALTH-10",
          packageName,
          severity: "error",
          message: `${esc.file}:${esc.line} path literal "${esc.literal}" resolves outside the package root (${esc.resolvedTo}) — the standalone extract will ENOENT.`,
          file: path.join(healthProjectDir, esc.file),
          fixHint:
            'Rebind the reference to a path inside the package root, mark a justified non-path use with a same-line "// pkg-health-10: <reason>" comment, or list the file in pkgHealth10Suppressions in extract.config.yaml.',
        });
      }
    }
  }

  suppressions.sort(
    (a, b) =>
      (a.packageName ?? "").localeCompare(b.packageName ?? "") ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  if (packagesChecked > 0 && commandInfos.length === 0) {
    violations.push({
      ruleId: "PKG-HEALTH-12",
      packageName: "(workspace)",
      severity: "warning",
      message:
        "no command inventory available — docs-drift gate skipped (context.commandRegistry unset and docs/command-manifest.generated.yaml absent or unparsable)",
      file: workspaceRoot,
      fixHint:
        "Run `werkstatt run command.manifest.generate`, or dispatch through a host that injects commandRegistry.",
    });
  } else if (packagesChecked > 0 && commandInfos.length > 0 && attributed === 0) {
    // Inventory exists but no command resolved to a package — module→package
    // attribution is unavailable (e.g. a consumer workshop without the
    // werkstatt-engine module-map) and PKG-HEALTH-11 would silently inert.
    violations.push({
      ruleId: "PKG-HEALTH-12",
      packageName: "(workspace)",
      severity: "warning",
      message: `${commandInfos.length} inventoried command(s) resolved to no package — module attribution unavailable, PKG-HEALTH-11 coverage skipped`,
      file: workspaceRoot,
      fixHint:
        "Check that packages/werkstatt-engine/src/kernel/module-map.ts or tools/kernel.config.ts declares the command modules.",
    });
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
      if (suppressions.length > 0) {
        logger.info(
          `forge.package.health: ${suppressions.length} docs-gate suppression(s) journaled (see data.suppressions for file:line + reason).`,
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
      suppressions,
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
