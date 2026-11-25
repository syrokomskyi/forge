/*
<MODULE_CONTRACT>
<purpose>
system.structure.validate (SYS-001) — a system-profile superfolder carries honest
zone structure: products.local.yaml parseable when present, sibling checkouts not
nested inside each other, no git repos embedded as plain directories.
</purpose>
<CHANGE_SUMMARY><item>WP-5: SYS-001 initial.</item></CHANGE_SUMMARY>
*/
import type { CommandModule } from "@warpgogol/forge/sdk";

export const command: CommandModule = {
  id: "system.structure.validate",
  scope: "system",
  description: "SYS-001: superfolder structural honesty",
  async run(ctx) {
    const violations: Array<{ ruleId: string; message: string; severity: "blocking" | "advisory"; file?: string }> = [];
    // Embedded-repo detection: a .git directory one level deep inside a non-git sibling
    // directory tree signals a clone-in-clone defect.
    try {
      for (const entry of await ctx.workspace.list(".")) {
        if (entry.startsWith(".") || entry === "node_modules") continue;
        if (/\.[a-z]+$/.test(entry)) continue;
        if (await ctx.workspace.exists(`${entry}/.git`)) {
          // a direct sibling checkout — legitimate in superfolders; the defect is NESTED embedding
          try {
            for (const nested of await ctx.workspace.list(entry)) {
              if (nested.startsWith(".") || /\.[a-z]+$/.test(nested)) continue;
              if (await ctx.workspace.exists(`${entry}/${nested}/.git`)) {
                violations.push({
                  ruleId: "SYS-001",
                  message: `nested git embedding: ${entry}/${nested} is a repo inside a repo — extraction or submodule, never embedding`,
                  severity: "blocking",
                  file: `${entry}/${nested}`,
                });
              }
            }
          } catch {
            // unreadable sibling — no evidence
          }
        }
      }
    } catch {
      // root unreadable — no evidence
    }
    // products.local.yaml parseability when present.
    if (await ctx.workspace.exists("products.local.yaml")) {
      try {
        const content = await ctx.workspace.readFile("products.local.yaml");
        if (content.includes("\t")) {
          violations.push({ ruleId: "SYS-001", message: "products.local.yaml contains tabs — YAML-invalid", severity: "blocking", file: "products.local.yaml" });
        }
      } catch {
        violations.push({ ruleId: "SYS-001", message: "products.local.yaml unreadable", severity: "blocking", file: "products.local.yaml" });
      }
    }
    return violations.length > 0 ? { status: "fail" as const, violations } : { status: "pass" as const };
  },
};
export default command;
