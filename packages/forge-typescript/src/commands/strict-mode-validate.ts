/*
<MODULE_CONTRACT>
<purpose>
ts.strict.mode.validate (TS-005) — v10 SDK port: non-test source avoids `any`
leakage markers. Pure rule over SDK workspace port.
</purpose>
<CHANGE_SUMMARY><item>WP-5: TS-005 port.</item></CHANGE_SUMMARY>
*/
import type { CommandModule } from "@warpgogol/forge/sdk";

const PATTERNS: Array<{ regex: RegExp; message: string }> = [
  { regex: /:\s*any\b/, message: "explicit any type annotation" },
  { regex: /as\s+any\b/, message: "any cast" },
  { regex: /@ts-ignore/, message: "@ts-ignore suppression" },
  { regex: /@ts-expect-error(?!.*\w)/, message: "@ts-expect-error without justification" },
];

export const command: CommandModule = {
  id: "ts.strict.mode.validate",
  scope: "workspace",
  description: "TS-005: strict-mode conventions in non-test source",
  async run(ctx) {
    const violations: Array<{ ruleId: string; message: string; severity: "blocking"; file?: string; line?: number }> = [];
    const scan = async (dir: string): Promise<void> => {
      let entries: string[] = [];
      try {
        entries = await ctx.workspace.list(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
        const p = dir ? `${dir}/${entry}` : entry;
        if (!/\.[a-z]+$/.test(entry)) {
          // extensionless entries are directories in source trees — recurse; list() on a file throws, which we treat as a file
          await scan(p);
          continue;
        }
        if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts") && !entry.includes("/test")) {
          let content = "";
          try {
            content = await ctx.workspace.readFile(p);
          } catch {
            continue;
          }
          content.split("\n").forEach((line, i) => {
            if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
            for (const { regex, message } of PATTERNS) {
              if (regex.test(line)) {
                violations.push({ ruleId: "TS-005", message: `${message} at line ${i + 1}`, severity: "blocking" as const, file: p, line: i + 1 });
              }
            }
          });
        }
      }
    };
    for (const root of ["packages", "src"]) {
      if (await ctx.workspace.exists(root)) {
        // scan one level deep — workspace packages or direct src
        try {
          const subs = await ctx.workspace.list(root);
          for (const sub of subs) {
            const candidate = `${root}/${sub}/src`;
            if (await ctx.workspace.exists(candidate)) await scan(candidate);
          }
        } catch {
          await scan(root);
        }
      }
    }
    return violations.length > 0 ? { status: "fail" as const, violations } : { status: "pass" as const };
  },
};
export default command;
