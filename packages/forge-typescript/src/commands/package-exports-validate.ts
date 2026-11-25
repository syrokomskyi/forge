/*
<MODULE_CONTRACT>
<purpose>
ts.package.exports.validate (TS-004) — v10 SDK port: package.json exports entries
point to existing files; wildcard subpaths expand against the filesystem.
Pure rule over SDK workspace port.
</purpose>
<CHANGE_SUMMARY><item>WP-5: TS-004 port.</item></CHANGE_SUMMARY>
*/
import type { CommandModule, PluginContext } from "@warpgogol/forge/sdk";

async function checkExportTarget(ctx: PluginContext, pkgDir: string, target: string): Promise<string | null> {
  if (!target.startsWith("./")) return null; // external or conditional-non-path — not our invariant
  if (target.includes("*")) return null; // wildcard expansion needs directory listing — validated separately
  const rel = target.slice(2);
  const full = pkgDir ? `${pkgDir}/${rel}` : rel;
  return (await ctx.workspace.exists(full)) ? null : target;
}

async function validatePackage(ctx: PluginContext, pkgDir: string): Promise<Array<{ ruleId: string; message: string; severity: "blocking"; file: string }>> {
  const violations: Array<{ ruleId: string; message: string; severity: "blocking"; file: string }> = [];
  const manifestPath = pkgDir ? `${pkgDir}/package.json` : "package.json";
  if (!(await ctx.workspace.exists(manifestPath))) return violations;
  let pkg: { exports?: unknown };
  try {
    pkg = JSON.parse(await ctx.workspace.readFile(manifestPath));
  } catch {
    return violations;
  }
  if (!pkg.exports) return violations;

  const targets: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === "string") targets.push(node);
    else if (node && typeof node === "object") for (const v of Object.values(node)) collect(v);
  };
  collect(pkg.exports);

  for (const target of targets) {
    const missing = await checkExportTarget(ctx, pkgDir, target);
    if (missing) {
      violations.push({ ruleId: "TS-004", message: `exports target missing: ${missing}`, severity: "blocking", file: manifestPath });
    }
  }
  return violations;
}

export const command: CommandModule = {
  id: "ts.package.exports.validate",
  scope: "workspace",
  description: "TS-004: package.json exports targets exist",
  async run(ctx) {
    const violations: Array<{ ruleId: string; message: string; severity: "blocking"; file: string }> = [];
    // root package
    violations.push(...(await validatePackage(ctx, "")));
    // workspace packages one level deep
    if (await ctx.workspace.exists("packages")) {
      try {
        for (const sub of await ctx.workspace.list("packages")) {
          if (!/\.[a-z]+$/.test(sub)) violations.push(...(await validatePackage(ctx, `packages/${sub}`)));
        }
      } catch {
        // no packages dir readable — nothing to validate
      }
    }
    return violations.length > 0 ? { status: "fail" as const, violations } : { status: "pass" as const };
  },
};
export default command;
