/*
<MODULE_CONTRACT>
<purpose>
ts.import.boundaries.validate (TS-002) — v10 SDK port: packages never import from
apps; cross-package imports go through package names, never relative path escapes
into sibling packages. Pure rule over SDK workspace port.
</purpose>
<CHANGE_SUMMARY><item>WP-5: TS-002 port.</item></CHANGE_SUMMARY>
*/
import type { CommandModule, PluginContext } from "@warpgogol/forge/sdk";

const RELATIVE_ESCAPE_RE = /(?:import|export)\s+[^"']*from\s+["'](\.\.[^"']*)["']|require\(["'](\.\.[^"']*)["']\)/g;

async function scanPackage(ctx: PluginContext, pkgDir: string): Promise<Array<{ ruleId: string; message: string; severity: "blocking"; file: string; line?: number }>> {
  const violations: Array<{ ruleId: string; message: string; severity: "blocking"; file: string; line?: number }> = [];
  const srcDir = `${pkgDir}/src`;

  const scan = async (dir: string): Promise<void> => {
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
        await scan(p);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".js")) continue;
      if (entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
      let content: string;
      try {
        content = await ctx.workspace.readFile(p);
      } catch {
        continue;
      }
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        for (const match of line.matchAll(RELATIVE_ESCAPE_RE)) {
          const spec = match[1] ?? match[2];
          if (!spec) continue;
          // Escape beyond the package root: counting ../ segments against the file's depth.
          const fileDepth = p.split("/").length - srcDir.split("/").length - 1;
          const escapes = spec.split("/").filter((s) => s === "..").length;
          if (escapes > fileDepth + 1) {
            violations.push({
              ruleId: "TS-002",
              message: `relative escape into sibling package territory: "${spec}" — cross-package imports use package names`,
              severity: "blocking",
              file: p,
              line: i + 1,
            });
          }
        }
        // Direct apps-imports in package source — boundary inversion.
        if (/from\s+["']apps\//.test(line) || /require\(["']apps\//.test(line)) {
          violations.push({
            ruleId: "TS-002",
            message: "package source imports from apps/ — dependency direction inverted",
            severity: "blocking",
            file: p,
            line: i + 1,
          });
        }
      });
    }
  };

  if (await ctx.workspace.exists(srcDir)) await scan(srcDir);
  return violations;
}

export const command: CommandModule = {
  id: "ts.import.boundaries.validate",
  scope: "workspace",
  description: "TS-002: no packages-to-apps inversions, no relative escapes into siblings",
  async run(ctx) {
    const violations: Array<{ ruleId: string; message: string; severity: "blocking"; file: string; line?: number }> = [];
    if (await ctx.workspace.exists("packages")) {
      try {
        for (const sub of await ctx.workspace.list("packages")) {
          if (!/\.[a-z]+$/.test(sub)) violations.push(...(await scanPackage(ctx, `packages/${sub}`)));
        }
      } catch {
        // no packages tree
      }
    }
    return violations.length > 0 ? { status: "fail" as const, violations } : { status: "pass" as const };
  },
};
export default command;
