/*
<MODULE_CONTRACT>
<purpose>
RFC-1334: lexical reachability for the `reachable` acceptance probe — symbol mode
proves an exported symbol is value-imported by a non-test module (optionally
inside the import graph of a root file); command mode reads the generated command
manifest's `reachableVia` edges.
</purpose>
<non-goals>
  <item>No TypeScript semantic resolution — import declarations are scanned lexically.</item>
  <item>No @warpgogol/* imports — command reachability comes from the generated manifest.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The scan set is the workspace's tracked files (git ls-files) — no hardcoded directory layout.</item>
  <item>Type-only imports and re-exports alone never count as usage.</item>
  <item>Barrel re-exports are followed to depth 5; bare specifiers resolve through workspace package.json exports.</item>
  <item>The tracked-file scan is memoized per workspace so several probes in one run share it.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1334: initial implementation.</item>
  <item>RFC-1334: step 4 — reachable acceptance probe (symbol and command modes) and V-45</item>
</CHANGE_SUMMARY>
*/

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { parse as yamlParse } from "yaml";

import { execFile } from "../../src/utils/sync-fs.ts";
import { gitEnvForCwd } from "./verification-origin.ts";

const SOURCE_EXT_RE = /\.(ts|tsx|mts|astro)$/;
const EXCLUDED_RE =
  /(?:\.(?:test|spec)\.|\.pbt\.test\.|(?:^|\/)(?:tests|__tests__|fixtures|test-fixtures|dist|node_modules|\.stryker-tmp|\.coverage)\/|\.d\.ts$)/;
const MAX_REEXPORT_DEPTH = 5;

const toPosix = (p: string): string => p.split(sep).join("/");

interface ImportRecord {
  /** Resolved repo-relative target, or null when unresolved. */
  target: string | null;
  /** Value-imported names (local alias irrelevant); "*" marks a namespace import. */
  names: Set<string>;
  /** Namespace alias, when `import * as ns`. */
  namespace?: string;
}

interface FileInfo {
  imports: ImportRecord[];
  /** `export { a } from "x"` → a; `export * from "x"` → "*". */
  reexports: Array<{ target: string | null; names: Set<string> }>;
  text: string;
}

interface ScanIndex {
  files: Map<string, FileInfo>;
  packages: Map<string, { dir: string; exports: unknown }>;
}

const indexCache = new Map<string, Promise<ScanIndex>>();

function gitLsFiles(workspaceRoot: string): Promise<string[]> {
  return new Promise((done) => {
    execFile(
      "git",
      ["ls-files", "-z"],
      { cwd: workspaceRoot, maxBuffer: 256 * 1024 * 1024, env: gitEnvForCwd() },
      (err, stdout) => done(err ? [] : String(stdout).split("\0").filter(Boolean)),
    );
  });
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function astroFrontmatter(src: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  return m ? m[1]! : "";
}

function resolveExportsEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const rec = entry as Record<string, unknown>;
    for (const key of ["import", "default", "node"]) {
      const v = resolveExportsEntry(rec[key]);
      if (v) return v;
    }
  }
  return null;
}

function resolveFile(rel: string, tracked: Set<string>): string | null {
  const base = toPosix(normalize(rel));
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.mjs$/, ".mts"),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
  ];
  return candidates.find((c) => tracked.has(c)) ?? null;
}

function resolveSpecifier(
  importer: string,
  spec: string,
  tracked: Set<string>,
  packages: ScanIndex["packages"],
): string | null {
  if (spec.startsWith(".")) return resolveFile(join(dirname(importer), spec), tracked);
  const parts = spec.split("/");
  const nameParts = spec.startsWith("@") ? 2 : 1;
  const pkgName = parts.slice(0, nameParts).join("/");
  const sub = parts.slice(nameParts).join("/");
  const pkg = packages.get(pkgName);
  if (!pkg) return null;
  const key = sub ? `./${sub}` : ".";
  const exportsMap = pkg.exports;
  let target: string | null = null;
  if (typeof exportsMap === "string" && key === ".") target = exportsMap;
  else if (exportsMap && typeof exportsMap === "object") {
    target = resolveExportsEntry((exportsMap as Record<string, unknown>)[key]);
  }
  if (!target) return sub ? resolveFile(join(pkg.dir, sub), tracked) : null;
  return resolveFile(join(pkg.dir, target), tracked);
}

const IMPORT_RE = /\bimport\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
const DYNAMIC_RE = /\{([^}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g;
const REEXPORT_RE = /\bexport\s+(type\s+)?(\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g;

function namedList(braced: string): Set<string> {
  const names = new Set<string>();
  for (const raw of braced.replace(/[{}]/g, "").split(",")) {
    const part = raw.trim();
    if (!part || part.startsWith("type ")) continue;
    names.add(part.split(/\s+as\s+/)[0]!.trim());
  }
  return names;
}

async function buildIndex(workspaceRoot: string): Promise<ScanIndex> {
  const all = await gitLsFiles(workspaceRoot);
  const tracked = new Set(all);
  const packages: ScanIndex["packages"] = new Map();
  for (const f of all.filter((f) => f.endsWith("package.json") && !f.includes("node_modules/"))) {
    try {
      const pj = JSON.parse(readFileSync(join(workspaceRoot, f), "utf8")) as {
        name?: string;
        exports?: unknown;
      };
      if (pj.name) packages.set(pj.name, { dir: dirname(f), exports: pj.exports ?? null });
    } catch {
      // Unparseable package.json — its specifiers stay unresolved.
    }
  }
  const files = new Map<string, FileInfo>();
  for (const rel of all) {
    if (!SOURCE_EXT_RE.test(rel) || rel.endsWith(".d.ts") || rel.includes("node_modules/"))
      continue;
    let text: string;
    try {
      text = readFileSync(join(workspaceRoot, rel), "utf8");
    } catch {
      continue;
    }
    if (rel.endsWith(".astro")) text = astroFrontmatter(text);
    const clean = stripComments(text);
    const imports: ImportRecord[] = [];
    for (const m of clean.matchAll(IMPORT_RE)) {
      if (m[1]) continue; // import type
      const clause = m[2]!.trim();
      const target = resolveSpecifier(rel, m[3]!, tracked, packages);
      const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
      const braced = /\{[^}]*\}/.exec(clause);
      const rec: ImportRecord = { target, names: braced ? namedList(braced[0]) : new Set() };
      if (ns) {
        rec.namespace = ns[1]!;
        rec.names.add("*");
      }
      imports.push(rec);
    }
    for (const m of clean.matchAll(DYNAMIC_RE)) {
      imports.push({
        target: resolveSpecifier(rel, m[2]!, tracked, packages),
        names: namedList(m[1]!),
      });
    }
    const reexports: FileInfo["reexports"] = [];
    for (const m of clean.matchAll(REEXPORT_RE)) {
      if (m[1]) continue;
      reexports.push({
        target: resolveSpecifier(rel, m[3]!, tracked, packages),
        names: m[2] === "*" ? new Set(["*"]) : namedList(m[2]!),
      });
    }
    files.set(rel, { imports, reexports, text: clean });
  }
  return { files, packages };
}

function scanIndex(workspaceRoot: string): Promise<ScanIndex> {
  let p = indexCache.get(workspaceRoot);
  if (!p) {
    p = buildIndex(workspaceRoot);
    indexCache.set(workspaceRoot, p);
  }
  return p;
}

/** Test seam: forget memoized scans (fixtures mutate their repositories). */
export function resetReachableScanCache(): void {
  indexCache.clear();
}

export interface ReachableSymbolResult {
  ok: boolean;
  detail: string;
}

export async function probeReachableSymbol(opts: {
  workspaceRoot: string;
  symbol: string;
  module: string;
  root?: string;
}): Promise<ReachableSymbolResult> {
  const { workspaceRoot, symbol } = opts;
  const moduleRel = toPosix(normalize(opts.module));
  if (!existsSync(join(workspaceRoot, moduleRel))) return { ok: false, detail: "module not found" };
  const exportRe = new RegExp(
    `\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:const|let|var|function\\*?|class|enum)\\s+${symbol}\\b|\\bexport\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`,
  );
  const moduleText = stripComments(readFileSync(join(workspaceRoot, moduleRel), "utf8"));
  if (!exportRe.test(moduleText)) return { ok: false, detail: "symbol not exported" };

  const index = await scanIndex(workspaceRoot);
  // Files that provide the symbol: the module plus barrels re-exporting it.
  const providers = new Set([moduleRel]);
  for (let depth = 0; depth < MAX_REEXPORT_DEPTH; depth++) {
    let grew = false;
    for (const [rel, info] of index.files) {
      if (providers.has(rel)) continue;
      if (
        info.reexports.some(
          (r) => r.target && providers.has(r.target) && (r.names.has(symbol) || r.names.has("*")),
        )
      ) {
        providers.add(rel);
        grew = true;
      }
    }
    if (!grew) break;
  }

  const importers: string[] = [];
  for (const [rel, info] of index.files) {
    if (EXCLUDED_RE.test(rel)) continue;
    const uses = info.imports.some((imp) => {
      if (!imp.target || !providers.has(imp.target)) return false;
      if (imp.names.has(symbol)) return true;
      return (
        imp.namespace !== undefined &&
        new RegExp(`\\b${imp.namespace}\\.${symbol}\\b`).test(info.text)
      );
    });
    if (uses) importers.push(rel);
  }
  if (importers.length === 0) return { ok: false, detail: "no runtime importer" };

  if (opts.root) {
    const rootRel = toPosix(normalize(opts.root));
    const seen = new Set<string>([rootRel]);
    const queue = [rootRel];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const imp of index.files.get(cur)?.imports ?? []) {
        if (imp.target && !seen.has(imp.target)) {
          seen.add(imp.target);
          queue.push(imp.target);
        }
      }
    }
    const reached = importers.filter((i) => seen.has(i));
    if (reached.length === 0) {
      return {
        ok: false,
        detail: `importers not reachable from root ${rootRel}: ${importers.slice(0, 3).join(", ")}`,
      };
    }
    return { ok: true, detail: `reachable from ${rootRel} via ${reached.slice(0, 3).join(", ")}` };
  }
  return { ok: true, detail: `imported by ${importers.slice(0, 3).join(", ")}` };
}

export async function probeReachableCommand(opts: {
  workspaceRoot: string;
  command: string;
}): Promise<ReachableSymbolResult> {
  const manifestPath = join(opts.workspaceRoot, "docs", "command-manifest.generated.yaml");
  if (!existsSync(manifestPath)) return { ok: false, detail: "command manifest not found" };
  const manifest = yamlParse(readFileSync(manifestPath, "utf8")) as {
    commands?: Array<{
      name: string;
      coverageNote?: string | null;
      reachableVia?: Array<{ kind: string; ref: string }>;
    }>;
  };
  const entry = manifest.commands?.find((c) => c.name === opts.command);
  if (!entry) return { ok: false, detail: "command not in manifest" };
  if (!Array.isArray(entry.reachableVia)) {
    return { ok: false, detail: "manifest predates reachableVia — run command.manifest.generate" };
  }
  const edges = entry.reachableVia.filter(
    (e) =>
      e.kind !== "coverage" ||
      e.ref !== "delegated" ||
      (entry.coverageNote ?? "").trim().length > 0,
  );
  if (edges.length === 0) return { ok: false, detail: "no pipeline, invoker, or coverage edge" };
  return {
    ok: true,
    detail: edges
      .slice(0, 3)
      .map((e) => `${e.kind}:${e.ref}`)
      .join(", "),
  };
}
