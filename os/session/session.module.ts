/*
<MODULE_CONTRACT>
<purpose>Register the session documentation domain commands with the forge kernel registry.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/*.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0537: initial forgeSessionModule registering session.save, session.archive, session.validate, session.list commands.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export const forgeSessionModule: ForgeModule = {
  name: "forge-session",
  version: "0.1.0",
  async register(registry) {
    const { runSessionSave } = await import("./handlers/save.ts");
    const { runSessionArchive } = await import("./handlers/archive.ts");
    const { runSessionValidate } = await import("./handlers/validate.ts");
    const { runSessionList } = await import("./handlers/list.ts");

    registry.registerCommand({
      name: "session.save",
      description:
        "Convert raw ATIF files from docs/sessions/.raw/ to structured markdown " +
        "in docs/sessions/ with auto-extracted metadata. Idempotent — same raw " +
        "file always produces the same output filename. Deletes raw file after " +
        "conversion unless --keep-raw. Use --raw-file to process a specific file.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/sessions/*.md"],
      reads: ["docs/sessions/.raw/*"],
      cacheable: false,
      flags: {
        "raw-file": {
          kind: "string",
          description: "Process a specific raw file instead of scanning .raw/.",
        },
        "keep-raw": {
          kind: "boolean",
          description: "Do not delete raw file after conversion.",
        },
        "dry-run": {
          kind: "boolean",
          description: "Preview without writing files.",
        },
      },
      execute: runSessionSave,
    });

    registry.registerCommand({
      name: "session.archive",
      description:
        "Move session files older than --max-age-days (default 7) from " +
        "docs/sessions/ to docs/sessions/archive/. Bidirectional: files in " +
        "archive/ younger than threshold are moved back to docs/sessions/. " +
        "Use --dry-run to preview. Age is computed from frontmatter date, " +
        "not filesystem mtime. Prefer the docs.archive umbrella command " +
        "unless you need to archive only sessions.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/sessions/*.md", "docs/sessions/archive/**"],
      reads: ["docs/sessions/**/*.md"],
      cacheable: false,
      flags: {
        "max-age-days": {
          kind: "string",
          description: "Age threshold in days (default 7).",
        },
        "dry-run": {
          kind: "boolean",
          description: "Preview what would be moved without touching the filesystem.",
        },
      },
      execute: runSessionArchive,
    });

    registry.registerCommand({
      name: "session.validate",
      description:
        "Validate session frontmatter schema (SES-01), id-filename match (SES-02), " +
        "RFC-id existence (SES-03), raw file hygiene (SES-04), and non-markdown " +
        "file detection (SES-05). Pass a session id to validate a single file, " +
        "or run without arguments for all. On-demand only — not integrated into " +
        "build.check.",
      scope: "workspace",
      flags: {},
      reads: ["docs/sessions/**/*.md", "docs/rfcs/**/*.md"],
      execute: runSessionValidate,
    });

    registry.registerCommand({
      name: "session.list",
      description:
        "List all sessions. Filter with --date-from, --date-to, --rfc, --type flags. " +
        "Use --json for machine-readable output. Parses frontmatter on the fly. " +
        "Includes archived sessions (marked with archived: true).",
      scope: "workspace",
      flags: {
        "date-from": {
          kind: "string",
          description: "Filter sessions from this date (YYYY-MM-DD, inclusive).",
        },
        "date-to": {
          kind: "string",
          description: "Filter sessions up to this date (YYYY-MM-DD, inclusive).",
        },
        rfc: {
          kind: "string",
          description: "Filter by related RFC id (e.g. RFC-0537).",
        },
        type: {
          kind: "string",
          description: "Filter by session type (mission, grilling, implementation, review, fix, freeform).",
        },
      },
      reads: ["docs/sessions/**/*.md"],
      execute: runSessionList,
    });
  },
};
