/*
<MODULE_CONTRACT>
<purpose>
Plugin loader (Werkstatt RFC-1648) — discover, verify, register, activate.
Fail-closed at every phase: a plugin failing any phase is entirely absent —
partial activation is impossible. Strict forgeRange compatibility; plugin
dependencies resolve refuse-on-conflict (never silent dedupe, never multi-instance).
Public npm and project-local plugins are the same species — one code path.
</purpose>
<non-goals><item>No compile cache in v1 — plugins ship compiled dist or plain-JS.</item></non-goals>
<CHANGE_SUMMARY><item>RFC-1648 (WP-5): initial loader.</item></CHANGE_SUMMARY>
*/

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import { createPluginContext, type ContextHostServices } from "./context.ts";
import { LIFECYCLE_HOOKS, PluginLoadError, type CommandModule, type HookModule, type PluginContext, type PluginManifest } from "./types.ts";

/** The running core version — plugins' forgeRange is checked against this. */
export function coreVersion(): string {
  // The compiled artifact lives one level deeper than the source module
  // (dist/src/sdk/loader.js vs src/sdk/loader.ts) — probe both layouts.
  const here = import.meta.dirname ?? __dirname;
  for (const candidate of ["../../package.json", "../../../package.json"]) { // pkg-health-10: defensive probe — each candidate intentionally misses in one layout (src vs dist) and hits in the other; miss is the designed path
    try {
      const pkg = JSON.parse(readFileSync(join(here, candidate), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@warpgogol/forge" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // try the next layout candidate
    }
  }
  return "10.0.0";
}

function semverSatisfies(version: string, range: string): boolean {
  // Minimal honest semver: caret ranges and exact pins — the vocabulary forgeRange uses.
  const parse = (v: string): [number, number, number] => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) throw new Error(`unparseable version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const [maj, min, pat] = parse(version);
  if (range.startsWith("^")) {
    const [rMaj, rMin, rPat] = parse(range.slice(1));
    if (maj !== rMaj) return false;
    if (maj === 0) return min === rMin && pat >= rPat;
    return min > rMin || (min === rMin && pat >= rPat);
  }
  if (range.startsWith(">=")) {
    const [rMaj, rMin, rPat] = parse(range.slice(2));
    return maj > rMaj || (maj === rMaj && (min > rMin || (min === rMin && pat >= rPat)));
  }
  const [eMaj, eMin, ePat] = parse(range);
  return maj === eMaj && min === eMin && pat === ePat;
}

const KNOWN_CAPABILITIES = new Set(["filesystem", "network", "processSpawn", "gitMutation", "envKeys", "forgeState", "primaryState"]);

export function verifyManifest(raw: unknown, pluginDir: string): PluginManifest {
  const m = raw as Partial<PluginManifest>;
  if (!m || typeof m !== "object") throw new PluginLoadError("manifest-invalid", "manifest is not an object");
  if (!m.id || typeof m.id !== "string") throw new PluginLoadError("manifest-invalid", "manifest.id missing");
  if (!m.version) throw new PluginLoadError("manifest-invalid", `manifest.version missing`, m.id);
  if (!m.forgeRange) throw new PluginLoadError("manifest-invalid", "manifest.forgeRange missing — strict compatibility is required", m.id);
  for (const key of Object.keys(m.capabilities ?? {})) {
    if (!KNOWN_CAPABILITIES.has(key)) {
      throw new PluginLoadError("capability-unknown", `unknown capability declared: ${key}`, m.id);
    }
  }
  // registers.hooks entries are module paths — validated at load, not here.
  void pluginDir;
  return { schema: "forge:plugin-manifest/v1", ...m } as PluginManifest;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  ctx: PluginContext;
  commands: CommandModule[];
  hooks: HookModule[];
  skillsDir: string | null;
  dir: string;
}

export interface LoadResult {
  ok: true;
  plugins: LoadedPlugin[];
}

/**
 * Resolve a plugin entry — npm package name or project-local path — to its
 * directory. One code path for both species: locality is discovery, never capability.
 */
export function resolvePluginDir(entry: string, consumerRoot: string): string {
  // Project-local: path entries starting with ./ or packages/.
  if (entry.startsWith("./") || entry.startsWith("packages/") || entry.startsWith("/")) {
    const p = resolve(consumerRoot, entry);
    if (existsSync(join(p, "forge.plugin.yaml")) || existsSync(join(p, "package.json"))) return p;
  }
  // npm species: node_modules resolution — scoped or bare name.
  const nm = join(consumerRoot, "node_modules", entry);
  if (existsSync(nm)) return nm;
  const scopedNm = join(consumerRoot, "node_modules", "@warpgogol", entry);
  if (existsSync(scopedNm)) return scopedNm;
  throw new PluginLoadError("manifest-invalid", `plugin entry unresolvable: ${entry}`, entry);
}

export async function loadPlugin(entry: string, consumerRoot: string, host: ContextHostServices): Promise<LoadedPlugin> {
  const dir = resolvePluginDir(entry, consumerRoot);
  const manifestPath = join(dir, "forge.plugin.yaml");
  if (!existsSync(manifestPath)) {
    throw new PluginLoadError("manifest-invalid", `forge.plugin.yaml missing in ${dir}`, entry);
  }
  const manifest = verifyManifest(parseYaml(readFileSync(manifestPath, "utf8")), dir);

  // Strict compatibility — fail-closed, no degraded modes.
  const core = coreVersion();
  if (!semverSatisfies(core, manifest.forgeRange)) {
    throw new PluginLoadError(
      "forgerange-violation",
      `plugin "${manifest.id}" requires forge ${manifest.forgeRange}, running core is ${core}`,
      manifest.id,
    );
  }

  const ctx = createPluginContext(manifest, host);

  // Register command modules — fail-closed: any violation, the plugin is entirely absent.
  const commands: CommandModule[] = [];
  for (const modulePath of manifest.registers.commands ?? []) {
    const abs = join(dir, modulePath);
    if (!existsSync(abs)) {
      throw new PluginLoadError("registration-refused", `command module missing: ${modulePath}`, manifest.id);
    }
    const mod = (await import(pathToFileURL(abs).href)) as { default?: CommandModule; command?: CommandModule };
    const command = mod.default ?? mod.command;
    if (!command || typeof command.id !== "string" || typeof command.run !== "function") {
      throw new PluginLoadError("registration-refused", `command module ${modulePath} does not implement CommandModule`, manifest.id);
    }
    commands.push(command);
  }

  // Register lifecycle-hook modules — fail-closed: each module's declared hook
  // must be in the closed vocabulary; duplicates within one plugin refuse.
  const hooks: HookModule[] = [];
  const seenHooks = new Set<string>();
  for (const hookPath of manifest.registers.hooks ?? []) {
    const abs = join(dir, hookPath);
    if (!existsSync(abs)) {
      throw new PluginLoadError("registration-refused", `hook module missing: ${hookPath}`, manifest.id);
    }
    const mod = (await import(pathToFileURL(abs).href)) as { default?: HookModule; hook?: HookModule };
    const hookMod = mod.default ?? mod.hook;
    if (!hookMod || typeof hookMod.run !== "function" || !LIFECYCLE_HOOKS.includes(hookMod.hook)) {
      throw new PluginLoadError("registration-refused", `hook module ${hookPath} does not implement HookModule`, manifest.id);
    }
    if (seenHooks.has(hookMod.hook)) {
      throw new PluginLoadError("registration-refused", `duplicate hook implementation: ${hookMod.hook}`, manifest.id);
    }
    seenHooks.add(hookMod.hook);
    hooks.push(hookMod);
  }

  const skillsDir = manifest.registers.skills ? join(dir, manifest.registers.skills) : null;
  return { manifest, ctx, commands, hooks, skillsDir, dir };
}

/** Plugin dependency resolution — refuse-on-conflict across the active set. */
export function checkPluginDependencyConflicts(manifests: PluginManifest[]): void {
  const versions = new Map<string, { version: string; requiredBy: Array<[string, string]> }>();
  for (const m of manifests) {
    versions.set(m.id, { version: m.version, requiredBy: [] });
  }
  for (const m of manifests) {
    for (const [depId, range] of Object.entries(m.pluginDependencies ?? {})) {
      const dep = versions.get(depId);
      if (!dep) {
        throw new PluginLoadError("dependency-conflict", `plugin "${m.id}" requires absent plugin "${depId}"`, m.id);
      }
      dep.requiredBy.push([m.id, range]);
      if (!semverSatisfies(dep.version, range)) {
        throw new PluginLoadError(
          "dependency-conflict",
          `plugin "${m.id}" requires ${depId} ${range}, active version is ${dep.version} — refuse-on-conflict`,
          m.id,
        );
      }
    }
  }
}
