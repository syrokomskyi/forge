/*
<MODULE_CONTRACT>
<purpose>
ts.tsconfig.validate (TS-001) — v10 SDK port: tsconfig.base.json exists with
strict:true and consistent module/moduleResolution. Pure rule over workspace
facts through SDK ports — no raw node imports.
</purpose>
<CHANGE_SUMMARY><item>WP-5: first v10 SDK command port.</item></CHANGE_SUMMARY>
*/
import type { CommandModule, PluginContext } from "@warpgogol/forge/sdk";

interface TsconfigFacts {
  exists: boolean;
  strict?: boolean;
  module?: string;
  moduleResolution?: string;
  parseError?: boolean;
}

function parseJsonc(text: string): Record<string, unknown> | null {
  // Minimal JSONC tolerance: strip line comments and trailing commas.
  const stripped = text.replace(/\/\/[^\n"]*(?=\n)/g, "").replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readFacts(ctx: PluginContext): Promise<TsconfigFacts> {
  const path = "tsconfig.base.json";
  if (!(await ctx.workspace.exists(path))) return { exists: false };
  const text = await ctx.workspace.readFile(path);
  const parsed = parseJsonc(text);
  if (!parsed) return { exists: true, parseError: true };
  const compilerOptions = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
  return {
    exists: true,
    strict: compilerOptions.strict === true,
    module: typeof compilerOptions.module === "string" ? (compilerOptions.module as string) : undefined,
    moduleResolution: typeof compilerOptions.moduleResolution === "string" ? (compilerOptions.moduleResolution as string) : undefined,
  };
}

const COUPLED_PAIRS: Array<[string, string]> = [
  ["NodeNext", "NodeNext"],
  ["nodenext", "nodenext"],
  ["ESNext", "Bundler"],
  ["esnext", "bundler"],
];

export const command: CommandModule = {
  id: "ts.tsconfig.validate",
  scope: "workspace",
  description: "TS-001: tsconfig.base.json strictness and module/moduleResolution consistency",
  async run(ctx) {
    const facts = await readFacts(ctx);
    const violations = [];
    if (!facts.exists) {
      violations.push({ ruleId: "TS-001", message: "tsconfig.base.json missing at workspace root", severity: "blocking" });
    } else if (facts.parseError) {
      violations.push({ ruleId: "TS-001", message: "tsconfig.base.json unparseable", severity: "blocking" });
    } else {
      if (facts.strict !== true) {
        violations.push({ ruleId: "TS-001", message: "compilerOptions.strict must be true", severity: "blocking", file: "tsconfig.base.json" });
      }
      if (facts.module && facts.moduleResolution) {
        const consistent =
          facts.module.toLowerCase() === facts.moduleResolution.toLowerCase() ||
          COUPLED_PAIRS.some(([m, r]) => m.toLowerCase() === facts.module!.toLowerCase() && r.toLowerCase() === facts.moduleResolution!.toLowerCase());
        if (!consistent) {
          violations.push({
            ruleId: "TS-001",
            message: `module/moduleResolution inconsistent: ${facts.module} + ${facts.moduleResolution}`,
            severity: "blocking",
            file: "tsconfig.base.json",
          });
        }
      }
    }
    return violations.length > 0 ? { status: "fail" as const, violations } : { status: "pass" as const };
  },
};
export default command;
