/*
<MODULE_CONTRACT>
<purpose>Register note validation commands (note.link.validate, note.frontmatter.validate, note.orphan.detect) with the forge kernel registry.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to src/validators/.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0808: initial forgeNotesModule registering 3 note validation commands.</item>
  <item>RFC-1173: declare mutatesState on all kernel commands — collectDeclarationDiagnostics emits error-severity MUTATES-STATE-DECLARED, command.manifest.validate is the blocking consumer in packages.check, sweep declares the flag on every command definition (factories hardcode false for read-only check specs)</item>
  <item>RFC-1231: step 1 — rename supportsAllSites to acceptsAllFlag

Mechanical sweep: the field only ever gated --all argv acceptance; fan-out
follows the parsed selector. Guard renamed assertAllSitesAllowed ->
assertAllFlagAccepted, message updated. 417 declaration sites + type
surfaces (KernelCommandMetadata, ForgeCommandMetadata) in one atomic pass.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";

export async function createForgeNotesModule(): Promise<ForgeModule> {
  const { runNoteLinkValidate } = await import("../../src/validators/note-link-validate.ts");
  const { runNoteFrontmatterValidate } =
    await import("../../src/validators/note-frontmatter-validate.ts");
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
  return {
    name: "forge-notes",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "note.link.validate",
        mutatesState: false,
        contract: "note",
        rules: [],
        description:
          "Validate wikilink integrity across a markdown note vault. Scans [[wikilinks]] and resolves each against the note graph.",
        scope: "workspace",
        acceptsAllFlag: false,
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
      },
      {
        name: "note.frontmatter.validate",
        coverage: "operator",
        coverageNote: "notes vault frontmatter hygiene (vault workshops)",
        mutatesState: false,
        contract: "note",
        rules: [],
        description:
          "Validate frontmatter consistency across a markdown note vault. Checks for required fields in YAML frontmatter.",
        scope: "workspace",
        acceptsAllFlag: false,
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
      },
      {
        name: "note.orphan.detect",
        coverage: "operator",
        coverageNote: "notes vault orphan detection (vault workshops)",
        mutatesState: false,
        description:
          "Detect orphan notes in a markdown note vault — notes with zero inbound wikilinks. Always exits zero (warnings, not errors).",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          "vault-dir": {
            kind: "string",
            description: "Vault directory relative to workspace root (default: vault).",
          },
        },
        reads: ["vault/**/*.md"],
        cacheable: false,
        execute: noteOrphanDetectWrapper,
      },
    ],
    pipelines: [],
  };
}
