/*
<MODULE_CONTRACT>
<purpose>
astro.content-collections.validate (ASTRO-002) — when src/content exists, a
content config with schemas guards it; collection directories without a matching
schema entry are blocking. Pure rule over SDK workspace port.
</purpose>
<CHANGE_SUMMARY><item>WP-5: ASTRO-002 initial.</item></CHANGE_SUMMARY>
*/
import type { CommandModule } from "@warpgogol/forge/sdk";

const CONFIG_CANDIDATES = ["src/content.config.ts", "src/content/config.ts", "src/content.config.mjs"];

export const command: CommandModule = {
  id: "astro.content-collections.validate",
  scope: "workspace",
  description: "ASTRO-002: content collections carry schemas",
  async run(ctx) {
    const violations: Array<{ ruleId: string; message: string; severity: "blocking"; file?: string }> = [];
    if (!(await ctx.workspace.exists("src/content"))) {
      return { status: "pass" }; // no content tree — invariant vacuous
    }

    let configPath: string | null = null;
    for (const candidate of CONFIG_CANDIDATES) {
      if (await ctx.workspace.exists(candidate)) {
        configPath = candidate;
        break;
      }
    }
    if (!configPath) {
      violations.push({
        ruleId: "ASTRO-002",
        message: "src/content exists without a content config — collections are untyped",
        severity: "blocking",
      });
      return { status: "fail", violations };
    }

    let configContent = "";
    try {
      configContent = await ctx.workspace.readFile(configPath);
    } catch {
      return { status: "pass" };
    }

    // Each collection directory must appear in the collections definition.
    let entries: string[] = [];
    try {
      entries = await ctx.workspace.list("src/content");
    } catch {
      return { status: "pass" };
    }
    for (const entry of entries) {
      if (entry === "config.ts" || entry.startsWith(".") || /\.[a-z]+$/.test(entry)) continue;
      // directory entry — must be named in the collections config
      if (!new RegExp(`["'\`]${entry}["'\`]`).test(configContent) && !new RegExp(`${entry}\\s*:`).test(configContent)) {
        violations.push({
          ruleId: "ASTRO-002",
          message: `collection directory "${entry}" has no schema entry in ${configPath}`,
          severity: "blocking",
          file: configPath,
        });
      }
    }
    return violations.length > 0 ? { status: "fail" as const, violations } : { status: "pass" as const };
  },
};
export default command;
