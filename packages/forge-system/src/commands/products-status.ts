/*
<MODULE_CONTRACT>
<purpose>
system.products.status (SYS-002) — read-only superfolder health sweep: products
named in products.local.yaml probe as present sibling checkouts; unregistered
git siblings surface as advisories. Never mutates.
</purpose>
<CHANGE_SUMMARY><item>WP-5: SYS-002 initial.</item></CHANGE_SUMMARY>
*/
import type { CommandModule } from "@warpgogol/forge/sdk";

export const command: CommandModule = {
  id: "system.products.status",
  scope: "system",
  description: "SYS-002: superfolder product roster health sweep",
  async run(ctx) {
    const violations: Array<{ ruleId: string; message: string; severity: "advisory" | "blocking"; file?: string }> = [];
    const data: Record<string, unknown> = { registered: [], missing: [], unregistered: [] };

    const registered: string[] = [];
    if (await ctx.workspace.exists("products.local.yaml")) {
      try {
        const content = await ctx.workspace.readFile("products.local.yaml");
        for (const line of content.split("\n")) {
          const m = line.match(/^\s+-?\s*(?:id|path|name):\s*["']?([\w./-]+)["']?\s*$/);
          if (m) registered.push(m[1]!);
        }
      } catch {
        // unreadable — structure validator owns that verdict
      }
    }
    data.registered = registered;

    for (const id of registered) {
      const probe = id.startsWith(".") || id.includes("/") ? id : `./${id}`;
      if (!(await ctx.workspace.exists(probe))) {
        (data.missing as string[]).push(id);
        violations.push({ ruleId: "SYS-002", message: `registered product missing on disk: ${id}`, severity: "advisory", file: "products.local.yaml" });
      }
    }

    // Unregistered git siblings.
    try {
      for (const entry of await ctx.workspace.list(".")) {
        if (entry.startsWith(".") || entry === "node_modules" || /\.[a-z]+$/.test(entry)) continue;
        if ((await ctx.workspace.exists(`${entry}/.git`)) && !registered.some((r) => r === entry || r === `./${entry}`)) {
          (data.unregistered as string[]).push(entry);
          violations.push({ ruleId: "SYS-002", message: `unregistered git sibling: ${entry} — roster drift`, severity: "advisory", file: entry });
        }
      }
    } catch {
      // no evidence
    }

    return { status: violations.some((v) => v.severity === "blocking") ? ("fail" as const) : ("pass" as const), violations, data };
  },
};
export default command;
