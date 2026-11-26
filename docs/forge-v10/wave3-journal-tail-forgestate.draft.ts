/* Wave-3 draft: journal-tail migrated to the forgeState port (requires forge 10.2.0 host).
   Replaces the workspace-port .git/forge/journal.jsonl read (primary-only) with the
   host-implemented port (works in worktrees across the sandbox boundary).
   Migration checklist when applying:
   1. manifest: capabilities.forgeState = "read"
   2. host: forge10 alias bump to >=10.2.0
   3. record discriminator: `event` not `kind` (measured journal schema) — fix the mapping below */
import type { CommandModule } from "@warpgogol/forge/sdk";

const command: CommandModule = {
  id: "studio.journal.tail",
  scope: "repo",
  description: "Read the last N forge journal records (forgeState port — worktree-correct)",
  async run(ctx, args) {
    const count = typeof args.count === "number" ? args.count : 5;
    const records = await ctx.forgeState.journal.tail(count);
    const total = await ctx.forgeState.journal.size();
    return {
      status: "pass",
      data: {
        total,
        count: records.length,
        records: records.map((r) => ({
          event: r.event ?? "unknown",
          branch: r.branch,
          sha: r.sha,
          at: r.at,
        })) as unknown as Record<string, unknown>,
      },
    };
  },
});

export default command;
