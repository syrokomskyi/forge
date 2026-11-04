/*
<MODULE_CONTRACT>
<purpose>outbox.validate (RFC-1510) — the single validator of the outbox
contract (DNA-91). Reads docs/outbox/*.yaml in ANY repository profile,
checks every entry against forge/outbox@1 (OUTBOX-01) and binds each entry's
id to its filename stem (OUTBOX-02). An absent docs/outbox/ is a pass —
outbox adoption is opt-in per product.</purpose>
<non-goals>
  <item>No system-side checks — matching and the identity-leak warning are
  system.outbox.scan's job; a product cannot know a system's name.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1510: step 2 — profile-agnostic outbox entry validator</item>
  <item>RFC-1510: implement RFC-1510 — product outbox for dependency-contract requests</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import YAML from "yaml";

import { resolveIo } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { OUTBOX_DIR, outboxEntrySchema } from "../outbox-schema.ts";

export interface OutboxValidateResult {
  command: "outbox.validate";
  checked: number;
  diagnostics: Diagnostic[];
}

function schemaIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export async function runOutboxValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<OutboxValidateResult>> {
  const io = resolveIo(context.io);
  const root = context.workspaceRoot;
  const diagnostics: Diagnostic[] = [];
  const dir = path.join(root, OUTBOX_DIR);

  let checked = 0;
  if (await io.exists(dir)) {
    for (const entry of await io.readdir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
      const rel = path.posix.join(OUTBOX_DIR, entry.name);
      const file = path.join(dir, entry.name);
      checked += 1;

      let raw: unknown;
      try {
        raw = YAML.parse(await io.readFile(file));
      } catch (error) {
        diagnostics.push({
          ruleId: "OUTBOX-01",
          severity: "error",
          file: rel,
          message: `${rel} is not parseable YAML: ${error instanceof Error ? error.message : String(error)}`,
          fixHint: "Repair the entry — see forge/outbox@1.",
        });
        continue;
      }
      const parsed = outboxEntrySchema.safeParse(raw);
      if (!parsed.success) {
        diagnostics.push({
          ruleId: "OUTBOX-01",
          severity: "error",
          file: rel,
          message: `${rel} fails forge/outbox@1: ${schemaIssues(parsed.error)}`,
          fixHint: "See the fo-outbox skill — an entry names a contract, need, why and state.",
        });
        continue;
      }
      const stem = entry.name.slice(0, -".yaml".length);
      if (parsed.data.id !== stem) {
        diagnostics.push({
          ruleId: "OUTBOX-02",
          severity: "error",
          file: rel,
          message: `${rel} declares id ${parsed.data.id} but the filename stem is ${stem}`,
          fixHint: "Rename the file or fix the id — the filename stem is the canonical id.",
        });
      }
    }
  }

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return {
    data: { command: "outbox.validate", checked, diagnostics },
    exitCode: errors > 0 ? 1 : 0,
    summary:
      checked === 0
        ? "outbox.validate: no docs/outbox/ entries — pass"
        : `outbox.validate: ${checked} entr${checked === 1 ? "y" : "ies"}, ${errors} error(s)`,
  };
}
