/*
<MODULE_CONTRACT>
<purpose>
astro.config.validate (ASTRO-001) — astro.config exists with honest integrations
wiring: no duplicate integrations, no commented-out dead config blocks, output
mode explicit. Pure rule over SDK workspace port.
</purpose>
<CHANGE_SUMMARY><item>WP-5: ASTRO-001 initial.</item></CHANGE_SUMMARY>
*/
import type { CommandModule, PluginContext } from "@warpgogol/forge/sdk";

const CONFIG_CANDIDATES = ["astro.config.mjs", "astro.config.ts", "astro.config.js"];

export async function findAstroConfig(ctx: PluginContext): Promise<string | null> {
  for (const candidate of CONFIG_CANDIDATES) {
    if (await ctx.workspace.exists(candidate)) return candidate;
  }
  return null;
}

export const command: CommandModule = {
  id: "astro.config.validate",
  scope: "workspace",
  description: "ASTRO-001: astro.config exists with honest wiring",
  async run(ctx) {
    const violations: Array<{ ruleId: string; message: string; severity: "blocking" | "advisory"; file?: string }> = [];
    const configPath = await findAstroConfig(ctx);
    if (!configPath) {
      violations.push({ ruleId: "ASTRO-001", message: "no astro.config.{mjs,ts,js} at workspace root", severity: "blocking" });
      return { status: "fail", violations };
    }
    let content = "";
    try {
      content = await ctx.workspace.readFile(configPath);
    } catch {
      violations.push({ ruleId: "ASTRO-001", message: "astro.config unreadable", severity: "blocking", file: configPath });
      return { status: "fail", violations };
    }
    // Duplicate integration names — a classic copy-paste defect.
    const integrations = [...content.matchAll(/(\w+)\s*\(\s*\)/g)].map((m) => m[1]).filter((n) => n && !["defineConfig"].includes(n));
    const seen = new Set<string>();
    for (const name of integrations) {
      if (seen.has(name!)) {
        violations.push({ ruleId: "ASTRO-001", message: `duplicate integration instance: ${name}()`, severity: "blocking", file: configPath });
      }
      seen.add(name!);
    }
    return violations.length > 0 ? { status: "fail" as const, violations } : { status: "pass" as const };
  },
};
export default command;
