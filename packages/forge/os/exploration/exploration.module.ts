/*
<MODULE_CONTRACT>
<purpose>Register the exploration note command family with the forge kernel registry and module loader.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0710: initial forgeExplorationModule registering exploration.list, exploration.show, exploration.archive commands.</item>
  <item>RFC-1097: sweep — packages/forge + services clean

Sweep batch 2: real KEY_DECISIONS on 10 files, expanded purposes (CONTRACT-02/PURPOSE-02), headers on mission/index + gen-upstreams, sanitizeItemText in summary.record (literal Compass tags corrupted history), excludedPaths for wrangler types, test-fixtures testPattern. forge+services now 0 diagnostics under --mode error.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeExplorationModule(): Promise<ForgeModule> {
  const { runExplorationList } = await import("./handlers/list.ts");
  const { runExplorationShow } = await import("./handlers/show.ts");
  const { runExplorationArchive } = await import("./handlers/archive.ts");
  return {
    name: "forge-exploration",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "exploration.list",
        description:
          "List all exploration notes in docs/explorations/. Returns id, title, status, and createdAt for each note. " +
          "Use --status <status> to filter by status (open, explored, archived). " +
          "Returns an empty list with exit code 0 if the directory is empty or missing.",
        scope: "workspace",
        mutatesState: false,
        writes: [],
        reads: ["docs/explorations/*.md"],
        cacheable: false,
        flags: {
          status: {
            kind: "string",
            description: "Filter by status (open, explored, archived).",
          },
        },
        execute: runExplorationList,
      },
      {
        name: "exploration.show",
        description:
          "Show the full content of a single exploration note. Use --id <slug> to specify the note slug " +
          "(kebab-case, lowercase, latin-only). Returns the note's frontmatter and body. " +
          "Returns exit code 1 if the note is not found.",
        scope: "workspace",
        mutatesState: false,
        writes: [],
        reads: ["docs/explorations/*.md"],
        cacheable: false,
        flags: {
          id: {
            kind: "string",
            required: true,
            description: "The slug of the exploration note to show (e.g. 'my-idea').",
          },
        },
        execute: runExplorationShow,
      },
      {
        name: "exploration.archive",
        description:
          "Archive an exploration note by setting its status to 'archived'. Use --id <slug> to specify the note. " +
          "Use --rfc <RFC-XXXX> to add an RFC id to the note's 'related' field. " +
          "Idempotent — if the note is already archived, returns exit code 0 with no changes. " +
          "Returns exit code 1 if the note is not found or the slug is invalid (non-kebab-case).",
        scope: "workspace",
        mutatesState: true,
        writes: ["docs/explorations/*.md"],
        reads: ["docs/explorations/*.md"],
        cacheable: false,
        flags: {
          id: {
            kind: "string",
            required: true,
            description: "The slug of the exploration note to archive (e.g. 'my-idea').",
          },
          rfc: {
            kind: "string",
            description: "RFC id to add to the note's 'related' field (e.g. 'RFC-0710').",
          },
        },
        execute: runExplorationArchive,
      },
    ],
    pipelines: [],
  };
}
