/*
<MODULE_CONTRACT>
<purpose>
RFC-1465: resolver.doors.audit — canonical-reader parity audit for multi-door
resolution surfaces. Reads the `resolverDoors:` registry from forge.yaml;
emits DOOR-01 (undeclared module importing the canonical reader or globbing
the surface's domain dirs), DOOR-02 (declared door that does not import the
canonical reader), DOOR-03 (canonical path missing or exports nothing).
Autonomous — scans source text only (FORGE-AUTONOMY-01).
</purpose>
<non-goals>
  <item>Does not rewrite doors — convergence is a separate queue item.</item>
  <item>Wave-1 rollout: all diagnostics are warnings; DOOR-01/02 promote to blocking in packages.check once seeded surfaces converge.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1465: canonical-reader parity audit — DOOR-01/02/03 over the forge.yaml resolverDoors registry</item>
  <item>RFC-1465: canonical-reader parity audit — resolver.doors.audit with DOOR-01/02/03 over forge.yaml registry</item>
  <item>RFC-1465: harden RFC-1465 door detection — module-level semantics, dynamic imports, comment stripping, wider corpus</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse } from "yaml";
// Autonomous convention (ADR-0019): ambient io at module scope — kernel
// callers pass context.io via resolveIo where the port is honored.
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface DoorSurface {
  canonical: string;
  domains: string[];
  doors: string[];
}

export interface DoorDiagnostic {
  ruleId: "DOOR-01" | "DOOR-02" | "DOOR-03";
  severity: "warning" | "error";
  surface: string;
  file?: string;
  message: string;
}

export interface ResolverDoorsAuditData {
  command: "resolver.doors.audit";
  status: "ok";
  surfaces: number;
  scanned: number;
  diagnostics: DoorDiagnostic[];
}

const IMPORT_RE =
  /(?:^|\n)\s*import\s+(?:type\s+)?([^;]*?)\s+from\s+["'`]([^"'`]+)["'`]|(?:^|\n)\s*export\s+[^;]+?\s+from\s+["'`]([^"'`]+)["'`]/g;
const DYNAMIC_IMPORT_RE = /(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]/g;
const GLOB_RE = /(?:readdir|glob|collectFiles|readdirSync)\s*\(\s*[`"']?[^,)]*?docs\/|\.glob\s*\(|readdir\s*\(/;
const SCAN_ROOTS = ["packages", "services", "tools"];
const EXCLUDE_DIRS = new Set(["node_modules", "dist", ".turbo", ".sessions"]);
const EXPORT_RE = (name: string) =>
  new RegExp(
    `export\\s+(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b|export\\s+default\\s+${name}\\b`,
  );

function parseCanonical(canonical: string): { file: string; symbol: string } | null {
  const idx = canonical.lastIndexOf("#");
  if (idx <= 0 || idx === canonical.length - 1) return null;
  return { file: canonical.slice(0, idx), symbol: canonical.slice(idx + 1) };
}

function validateRegistry(raw: unknown): Record<string, DoorSurface> {
  const out: Record<string, DoorSurface> = {};
  if (raw == null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("resolverDoors must be a map of surface → { canonical, domains, doors }");
  }
  for (const [surface, entry] of Object.entries(raw)) {
    const e = entry as Record<string, unknown>;
    const unknown = Object.keys(e).filter((k) => !["canonical", "domains", "doors"].includes(k));
    if (unknown.length > 0) {
      throw new Error(`resolverDoors.${surface}: unknown field(s) ${unknown.join(", ")}`);
    }
    if (typeof e.canonical !== "string" || !parseCanonical(e.canonical)) {
      throw new Error(`resolverDoors.${surface}.canonical must be "path#export"`);
    }
    const c = parseCanonical(e.canonical)!;
    if (path.isAbsolute(c.file) || c.file.includes("..")) {
      throw new Error(`resolverDoors.${surface}.canonical must be a relative workspace path`);
    }
    const doors = e.doors === undefined ? [] : e.doors;
    const domains = e.domains === undefined ? [] : e.domains;
    if (!Array.isArray(doors) || !Array.isArray(domains)) {
      throw new Error(`resolverDoors.${surface}: doors and domains must be arrays`);
    }
    for (const d of [...doors, ...domains]) {
      if (typeof d !== "string" || path.isAbsolute(d) || d.includes("..")) {
        throw new Error(`resolverDoors.${surface}: paths must be relative, no "..": ${d}`);
      }
    }
    out[surface] = {
      canonical: e.canonical,
      domains: domains as string[],
      doors: doors as string[],
    };
  }
  return out;
}

function norm(p: string): string {
  return p.split(path.sep).join("/");
}

function stripExt(p: string): string {
  return p.replace(/\.(ts|tsx|mts|cts|js|mjs)$/, "");
}

/** Import match → { clause, specifier }. Clause is undefined for require/dynamic/export-from. */
function importRefs(src: string): { clause: string | undefined; specifier: string }[] {
  const refs = [...src.matchAll(IMPORT_RE)].map((m) => ({
    clause: m[1] as string | undefined,
    specifier: (m[2] ?? m[3]) as string,
  }));
  for (const m of src.matchAll(DYNAMIC_IMPORT_RE)) {
    refs.push({ clause: undefined, specifier: m[1]! });
  }
  return refs;
}

/** Strip line + block comments — the domain-dir glob check must not fire on
 * commented examples or doc prose (the doctor.ts FP class). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/**
 * Module-level delegation: an import resolves to the canonical reader module
 * — any binding counts (the reader owns existence AND shape; sibling exports
 * are still the same door). Type-only imports count: delegating shape to the
 * reader IS convergence.
 */
function bindsCanonical(ref: { clause: string | undefined; specifier: string }, door: string, canonical: string, _symbol: string): boolean {
  return importsTarget(ref.specifier, door, canonical);
}

/** Does `specifier` (as written in `door`'s imports) resolve to `target` (repo-relative)? */
function importsTarget(specifier: string, door: string, target: string): boolean {
  const doorDir = norm(path.posix.dirname(door));
  let resolved: string;
  if (specifier.startsWith(".")) {
    resolved = path.posix.normalize(path.posix.join(doorDir, specifier));
  } else {
    resolved = specifier; // bare specifier — tail-match below
  }
  const want = stripExt(norm(target));
  const got = stripExt(resolved);
  if (got === want) return true;
  if (specifier.startsWith(".")) return false; // resolved relative miss — no tail-match
  // Bare package specifier — match on the canonical's tail segments
  // (e.g. @warpgogol/forge/registry → packages/forge/src/registry).
  return want.endsWith("/" + path.posix.basename(got)) || got.endsWith("/" + path.posix.basename(want));
}

async function walk(dir: string, root: string, io: ReturnType<typeof resolveIo>): Promise<string[]> {
  const out: string[] = [];
  const entries = await io.readdir(dir).catch(() => [] as { name: string; isFile: boolean; isDirectory: boolean }[]);
  for (const e of entries) {
    if (e.isDirectory && EXCLUDE_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory) out.push(...(await walk(abs, root, io)));
    else if (e.isFile && /\.(ts|tsx|mts|cts|astro|jsx)$/.test(e.name)) out.push(norm(path.relative(root, abs)));
  }
  return out;
}

export async function runResolverDoorsAudit(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ResolverDoorsAuditData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const forgeYaml = await io.readFile(path.join(root, "forge.yaml")).catch(() => null);
  if (forgeYaml === null) {
    throw new Error("resolver.doors.audit requires forge.yaml at the workspace root");
  }
  const surfaces = validateRegistry(yamlParse(forgeYaml)?.resolverDoors);

  // Workspace corpus for DOOR-01 — scanned once, reused per surface.
  const corpus = new Map<string, string>();
  for (const dir of SCAN_ROOTS) {
    const files = await walk(path.join(root, dir), root, io);
    const contents = await Promise.all(
      files.map((rel) => io.readFile(path.join(root, rel)).catch(() => "")),
    );
    files.forEach((rel, i) => corpus.set(rel, contents[i]!));
  }

  const diagnostics: DoorDiagnostic[] = [];
  for (const [surface, decl] of Object.entries(surfaces)) {
    const c = parseCanonical(decl.canonical)!;
    const canonRel = norm(c.file);
    const doorSet = new Set(decl.doors.map(norm));

    // DOOR-03: canonical exists and exports the named symbol.
    const canonSrc = corpus.get(canonRel) ?? (await io.readFile(path.join(root, canonRel)).catch(() => ""));
    if (!canonSrc || !EXPORT_RE(c.symbol).test(canonSrc)) {
      diagnostics.push({
        ruleId: "DOOR-03",
        severity: "warning",
        surface,
        file: canonRel,
        message: `${surface}: canonical reader ${decl.canonical} ${!canonSrc ? "does not exist" : `does not export ${c.symbol}`}`,
      });
    }

    // DOOR-02: each declared door imports the canonical reader.
    for (const door of decl.doors) {
      const doorRel = norm(door);
      if (doorRel === canonRel) continue;
      const src = corpus.get(doorRel) ?? (await io.readFile(path.join(root, doorRel)).catch(() => undefined));
      if (src === undefined) {
        diagnostics.push({
          ruleId: "DOOR-02",
          severity: "warning",
          surface,
          file: doorRel,
          message: `${surface}: declared door ${doorRel} does not exist`,
        });
        continue;
      }
      if (!importRefs(src).some((r) => bindsCanonical(r, doorRel, canonRel, c.symbol))) {
        diagnostics.push({
          ruleId: "DOOR-02",
          severity: "warning",
          surface,
          file: doorRel,
          message: `${surface}: declared door ${doorRel} does not import canonical reader ${canonRel}`,
        });
      }
    }

    // DOOR-01: undeclared module importing the canonical reader or globbing
    // the surface's domain dirs.
    for (const [file, src] of corpus) {
      if (file === canonRel || doorSet.has(file) || !src) continue;
      const importsCanon = importRefs(src).some((r) => bindsCanonical(r, file, canonRel, c.symbol));
      const code = stripComments(src);
      const globsDomain =
        GLOB_RE.test(code) && decl.domains.some((d) => code.includes(norm(d)));
      if (importsCanon || globsDomain) {
        diagnostics.push({
          ruleId: "DOOR-01",
          severity: "warning",
          surface,
          file,
          message: `${surface}: undeclared door ${file} ${importsCanon ? `imports canonical reader ${canonRel}` : `reads domain dir(s) ${decl.domains.join(", ")}`} — declare it in resolverDoors or delegate to the canonical reader`,
        });
      }
    }
  }

  if (context.outputFormat === "pretty") {
    for (const d of diagnostics) context.logger.warn(`${d.ruleId} ${d.message}`);
    context.logger.info(`${diagnostics.length} resolver-door diagnostic(s) over ${Object.keys(surfaces).length} surface(s)`);
  }
  return {
    data: {
      command: "resolver.doors.audit",
      status: "ok",
      surfaces: Object.keys(surfaces).length,
      scanned: corpus.size,
      diagnostics,
    },
    summary: `${diagnostics.length} door diagnostic(s) — wave-1 warnings`,
    exitCode: 0,
  };
}
