/*
<MODULE_CONTRACT>
<purpose>Register note validation commands (note.link.validate, note.frontmatter.validate, note.orphan.detect) with the forge kernel registry.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to src/validators/.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0808: initial forgeNotesModule registering 3 note validation commands.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";

export const forgeNotesModule: ForgeModule = {
  name: "forge-notes",
  version: "0.1.0",
  async register(registry) {
    const { runNoteLinkValidate } = await import("../../src/validators/note-link-validate.ts");
    const { runNoteFrontmatterValidate } = await import(
      "../../src/validators/note-frontmatter-validate.ts"
    );
    const { runNoteOrphanDetect } = await import("../../src/validators/note-orphan-detect.ts");

    const noteLinkValidateWrapper = async (
      input: ForgeCommandInput,
      context: ForgeRuntimeContext,
    ): Promise<ForgeCommandResult> => {
      return runNoteLinkValidate(input, context);
    };

    const noteFrontmatterValidateWrapper = async (
      input: ForgeCommandInput,
      context: ForgeRuntimeContext,
    ): Promise<ForgeCommandResult> => {
      return runNoteFrontmatterValidate(input, context);
    };

    const noteOrphanDetectWrapper = async (
      input: ForgeCommandInput,
      context: ForgeRuntimeContext,
    ): Promise<ForgeCommandResult> => {
      return runNoteOrphanDetect(input, context);
    };

    registry.registerCommand({
      name: "note.link.validate",
      description:
        "Validate wikilink integrity across an Obsidian vault. Scans [[wikilinks]] and resolves each against the note graph.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {
        "vault-dir": {
          kind: "string",
          description: "Vault directory relative to workspace root (default: vault).",
        },
        path: {
          kind: "string",
          description: "Subdirectory within the vault to scope the scan to.",
        },
      },
      reads: ["vault/**/*.md"],
      cacheable: false,
      execute: noteLinkValidateWrapper,
    });

    registry.registerCommand({
      name: "note.frontmatter.validate",
      description:
        "Validate frontmatter consistency across an Obsidian vault. Checks for required fields in YAML frontmatter.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {
        "vault-dir": {
          kind: "string",
          description: "Vault directory relative to workspace root (default: vault).",
        },
        fields: {
          kind: "string",
          description: "Comma-separated list of required fields (default: title).",
        },
      },
      reads: ["vault/**/*.md"],
      cacheable: false,
      execute: noteFrontmatterValidateWrapper,
    });

    registry.registerCommand({
      name: "note.orphan.detect",
      description:
        "Detect orphan notes in an Obsidian vault — notes with zero inbound wikilinks. Always exits zero (warnings, not errors).",
      scope: "workspace",
      supportsAllSites: false,
      flags: {
        "vault-dir": {
          kind: "string",
          description: "Vault directory relative to workspace root (default: vault).",
        },
      },
      reads: ["vault/**/*.md"],
      cacheable: false,
      execute: noteOrphanDetectWrapper,
    });
  },
};
