/*
<MODULE_CONTRACT>
<purpose>
ts.barrel.validate (TS-006) — v10 SDK port: barrel (index) files that re-export
node-only modules must have matching subpath exports in package.json, so consumers
opting into the root export do not transitively load node builtins in incompatible
runtimes. Pure rule over SDK workspace port.
</purpose>
<CHANGE_SUMMARY><item>WP-5: TS-006 port.</item></CHANGE_SUMMARY>
*/
import type { CommandModule, PluginContext } from "@warpgogol/forge/sdk";

const NODE_ONLY_RE = /from\s+["']node:(fs|child_process|net|worker_threads|readline|os)["']|require\(["'](?:node:)?(fs|child_process|net|worker_threads|readline|os)["']\)/;
const REEXPORT_RE = /export\s+(?:\*|\{[^}]*\})\s+from\s+["'](\.[^"']*)["']/g;

async function validateBarrel(ctx: PluginContext, pkgDir: string): Promise<Array<{ ruleId: string; message: string; severity: "blocking"; file: string }>> {
  const violations: Array<{ ruleId: string; message: string; severity: "blocking"; file: string }> = [];
  const barrelPath = `${pkgDir}/src/index.ts`;
  const manifestPath = `${pkgDir}/package.json`;
  if (!(await ctx.workspace.exists(barrelPath)) || !(await ctx.workspace.exists(manifestPath))) return violations;

  let barrel: string;
  let manifest: { exports?: Record<string, unknown> };
  try {
    barrel = await ctx.workspace.readFile(barrelPath);
    manifest = JSON.parse(await ctx.workspace.readFile(manifestPath));
  } catch {
    return violations;
  }

  const subpaths = new Set(Object.keys(manifest.exports ?? {}).filter((k) => k !== "."));
  for (const match of barrel.matchAll(REEXPORT_RE)) {
    const spec = match[1]!;
    // Resolve the re-export target relative to the barrel dir (src/).
    const targetBase = `${pkgDir}/src/${spec.replace(/^\.\//, "")}`;
    const candidates = [`${targetBase}.ts`, `${targetBase}/index.ts`];
    let nodeOnly = false;
    for (const candidate of candidates) {
      if (!(await ctx.workspace.exists(candidate))) continue;
      try {
        const content = await ctx.workspace.readFile(candidate);
        if (NODE_ONLY_RE.test(content)) {
          nodeOnly = true;
          break;
        }
      } catch {
        // unreadable — no evidence
      }
    }
    if (nodeOnly) {
      const expectedSubpath = `./${spec.replace(/^\.\//, "")}`;
      if (!subpaths.has(expectedSubpath) && ![...subpaths].some((s) => s.includes("*"))) {
        violations.push({
          ruleId: "TS-006",
          message: `barrel re-exports node-only module "${spec}" without a matching subpath export (${expectedSubpath}) — root-export consumers inherit node builtins`,
          severity: "blocking",
          file: barrelPath,
        });
      }
    }
  }
  return violations;
}

export const command: CommandModule = {
  id: "ts.barrel.validate",
  scope: "workspace",
  description: "TS-006: barrel re-exports of node-only modules require subpath exports",
  async run(ctx) {
    const violations: Array<{ ruleId: string; message: string; severity: "blocking"; file: string }> = [];
    if (await ctx.workspace.exists("packages")) {
      try {
        for (const sub of await ctx.workspace.list("packages")) {
          if (!/\.[a-z]+$/.test(sub)) violations.push(...(await validateBarrel(ctx, `packages/${sub}`)));
        }
      } catch {
        // no packages tree
      }
    }
    return violations.length > 0 ? { status: "fail" as const, violations } : { status: "pass" as const };
  },
};
export default command;
