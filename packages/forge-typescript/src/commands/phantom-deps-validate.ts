/*
<MODULE_CONTRACT>
<purpose>
ts.phantom.deps.validate (TS-003) — v10 SDK port: every external package imported
in a package's source is declared in that package's package.json dependencies.
Pure rule over SDK workspace port.
</purpose>
<CHANGE_SUMMARY><item>WP-5: TS-003 port.</item></CHANGE_SUMMARY>
*/
import type { CommandModule, PluginContext } from "@warpgogol/forge/sdk";

const IMPORT_RE = /(?:import|export)\s+(?:[^"']*from\s+)?["']([^"./][^"']*)["']|require\(["']([^"./][^"']*)["']\)/g;

function packageNameOf(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return specifier.split("/")[0] ?? specifier;
}

const NODE_BUILTINS = new Set([
  "fs", "path", "os", "crypto", "child_process", "util", "events", "stream", "http", "https", "net", "url", "module", "process", "buffer", "assert", "console", "dns", "readline", "zlib", "worker_threads", "perf_hooks", "timers",
]);

async function collectImports(ctx: PluginContext, dir: string, out: Map<string, string[]>): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await ctx.workspace.list(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const p = `${dir}/${entry}`;
    if (!/\.[a-z]+$/.test(entry)) {
      await collectImports(ctx, p, out);
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".js") && !entry.endsWith(".mts")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
    let content: string;
    try {
      content = await ctx.workspace.readFile(p);
    } catch {
      continue;
    }
    for (const match of content.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      const pkg = packageNameOf(spec.replace(/^node:/, ""));
      if (NODE_BUILTINS.has(pkg) || spec.startsWith("node:")) continue;
      if (!out.has(pkg)) out.set(pkg, []);
      out.get(pkg)!.push(p);
    }
  }
}

async function validateOne(ctx: PluginContext, pkgDir: string): Promise<Array<{ ruleId: string; message: string; severity: "blocking"; file: string }>> {
  const violations: Array<{ ruleId: string; message: string; severity: "blocking"; file: string }> = [];
  const manifestPath = `${pkgDir}/package.json`;
  const srcDir = `${pkgDir}/src`;
  if (!(await ctx.workspace.exists(manifestPath)) || !(await ctx.workspace.exists(srcDir))) return violations;

  let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> } = {};
  try {
    manifest = JSON.parse(await ctx.workspace.readFile(manifestPath));
  } catch {
    return violations;
  }
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);

  const imports = new Map<string, string[]>();
  await collectImports(ctx, srcDir, imports);
  for (const [pkg, files] of imports) {
    // intra-workspace deps are declared too — but a workspace self-reference is legal by hoisting; keep strict: must be declared.
    if (!declared.has(pkg)) {
      violations.push({
        ruleId: "TS-003",
        message: `phantom dependency: "${pkg}" imported in ${files.length} file(s) but undeclared in ${manifestPath}`,
        severity: "blocking",
        file: files[0]!,
      });
    }
  }
  return violations;
}

export const command: CommandModule = {
  id: "ts.phantom.deps.validate",
  scope: "workspace",
  description: "TS-003: no phantom dependencies",
  async run(ctx) {
    const violations: Array<{ ruleId: string; message: string; severity: "blocking"; file: string }> = [];
    if (await ctx.workspace.exists("packages")) {
      try {
        for (const sub of await ctx.workspace.list("packages")) {
          if (!/\.[a-z]+$/.test(sub)) violations.push(...(await validateOne(ctx, `packages/${sub}`)));
        }
      } catch {
        // no packages tree — nothing to validate
      }
    }
    return violations.length > 0 ? { status: "fail" as const, violations } : { status: "pass" as const };
  },
};
export default command;
