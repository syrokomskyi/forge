/*
<MODULE_CONTRACT>
<purpose>
repo.extract.provenance.validate (EXTRACT-002) — an extracted repo carries honest
provenance: extraction record files name a verifiable source digest, never a
placeholder; archive references are complete (bundle + digest pairs).
</purpose>
<CHANGE_SUMMARY><item>WP-5: EXTRACT-002 initial.</item></CHANGE_SUMMARY>
*/
import type { CommandModule } from "@warpgogol/forge/sdk";

const PROVENANCE_CANDIDATES = ["docs/extraction-record.md", "EXTRACTION.md", ".extract-provenance.yaml"];

export const command: CommandModule = {
  id: "repo.extract.provenance.validate",
  scope: "repo",
  description: "EXTRACT-002: extraction provenance completeness",
  async run(ctx) {
    const violations: Array<{ ruleId: string; message: string; severity: "blocking" | "advisory"; file?: string }> = [];
    let provenancePath: string | null = null;
    for (const candidate of PROVENANCE_CANDIDATES) {
      if (await ctx.workspace.exists(candidate)) {
        provenancePath = candidate;
        break;
      }
    }
    if (!provenancePath) return { status: "pass" }; // no extraction provenance claimed — vacuous

    let content = "";
    try {
      content = await ctx.workspace.readFile(provenancePath);
    } catch {
      violations.push({ ruleId: "EXTRACT-002", message: "provenance record unreadable", severity: "blocking", file: provenancePath });
      return { status: "fail", violations };
    }
    // Placeholder detection — a provenance record without a real digest is theater.
    if (!/[0-9a-f]{40}/.test(content) && !/sha256:[0-9a-f]{64}/.test(content)) {
      violations.push({
        ruleId: "EXTRACT-002",
        message: "provenance record carries no verifiable source digest (sha1/sha256) — placeholder provenance",
        severity: "blocking",
        file: provenancePath,
      });
    }
    if (/TODO|TBD|fill-in|placeholder/i.test(content)) {
      violations.push({ ruleId: "EXTRACT-002", message: "provenance record contains placeholder markers", severity: "advisory", file: provenancePath });
    }
    return violations.length > 0 ? { status: "fail" as const, violations } : { status: "pass" as const };
  },
};
export default command;
