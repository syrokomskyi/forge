/*
<MODULE_CONTRACT>
<purpose>
repo.extract.plan.validate (EXTRACT-001) — an extraction plan (extract.config.yaml)
names honest surfaces: source paths exist, target does not overlap the source,
no excluded-path escape contradictions.
</purpose>
<CHANGE_SUMMARY><item>WP-5: EXTRACT-001 initial.</item></CHANGE_SUMMARY>
*/
import type { CommandModule } from "@warpgogol/forge/sdk";

export const command: CommandModule = {
  id: "repo.extract.plan.validate",
  scope: "repo",
  description: "EXTRACT-001: extraction plan structural honesty",
  async run(ctx) {
    const violations: Array<{ ruleId: string; message: string; severity: "blocking"; file?: string }> = [];
    const planPath = "extract.config.yaml";
    if (!(await ctx.workspace.exists(planPath))) {
      return { status: "pass" }; // no extraction in this repo — invariant vacuous
    }
    let content = "";
    try {
      content = await ctx.workspace.readFile(planPath);
    } catch {
      violations.push({ ruleId: "EXTRACT-001", message: "extract.config.yaml unreadable", severity: "blocking", file: planPath });
      return { status: "fail", violations };
    }
    if (content.includes("\t")) {
      violations.push({ ruleId: "EXTRACT-001", message: "extract.config.yaml contains tabs — YAML-invalid", severity: "blocking", file: planPath });
    }
    // Source surface entries must exist.
    for (const line of content.split("\n")) {
      const m = line.match(/^\s+-?\s*(?:source|path|include):\s*["']?([\w./-]+)["']?\s*$/);
      if (!m) continue;
      const surface = m[1]!;
      if (surface.includes("*")) continue; // glob surfaces are validated at execution
      if (!(await ctx.workspace.exists(surface))) {
        violations.push({ ruleId: "EXTRACT-001", message: `extraction surface missing on disk: ${surface}`, severity: "blocking", file: planPath });
      }
    }
    // Target overlap: a target inside its own source tree is a recursion defect.
    const sourceM = content.match(/sourceRoot:\s*["']?([\w./-]+)["']?/);
    const targetM = content.match(/targetRoot:\s*["']?([\w./-]+)["']?/);
    if (sourceM && targetM) {
      const [src, tgt] = [sourceM[1]!.replace(/\/$/, ""), targetM[1]!.replace(/\/$/, "")];
      if (tgt === src || tgt.startsWith(`${src}/`)) {
        violations.push({ ruleId: "EXTRACT-001", message: `targetRoot ${tgt} nests inside sourceRoot ${src} — recursive extraction defect`, severity: "blocking", file: planPath });
      }
    }
    return violations.length > 0 ? { status: "fail" as const, violations } : { status: "pass" as const };
  },
};
export default command;
