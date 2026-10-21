/*
<MODULE_CONTRACT>
<purpose>
RFC-1363: shared amendment loader for spec.validate, spec.status and
spec.materialize. Reads docs/specs/<id>/amendments/*.md, parses frontmatter,
validates against forge/spec-amendment@1, and FAILS CLOSED: a file without
parseable frontmatter or failing the schema is returned as a SPEC-14 error
naming the file and the issues — never silently skipped.
</purpose>
<non-goals>
  <item>Do not validate amendment targets against a forge-spec here — callers own SPEC-08..11.</item>
  <item>Do not edit or normalize amendment files.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Fail-closed per DNA-112: unreadable input is a diagnostic, not a pass.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1363: extracted the three per-command amendment loops into one fail-closed loader with SPEC-14 diagnostics.</item>
  <item>RFC-1363: fail-closed amendment loader SPEC-14 + target repairs AMD-008..011</item>
</CHANGE_SUMMARY>
*/

import { ambientIo as fs } from "../../src/utils/io.ts";
import { existsSync } from "../../src/utils/sync-fs.ts";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { specAmendmentSchema, type SpecAmendment, type SpecViolation } from "./spec-schema.ts";

export interface LoadedAmendments {
  amendments: SpecAmendment[];
  errors: SpecViolation[];
}

function formatZodIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

export async function loadAmendments(specDir: string): Promise<LoadedAmendments> {
  const amendmentsDir = path.join(specDir, "amendments");
  if (!existsSync(amendmentsDir)) return { amendments: [], errors: [] };

  const entries = (await fs.readdir(amendmentsDir)).map((e) => e.name);
  const amendments: SpecAmendment[] = [];
  const errors: SpecViolation[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    try {
      const content = await fs.readFile(path.join(amendmentsDir, entry));
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) {
        errors.push({
          rule: "SPEC-14",
          message: `amendment ${entry} does not match forge/spec-amendment@1: (root): no frontmatter block`,
        });
        continue;
      }
      let raw: unknown;
      try {
        raw = parseYaml(fmMatch[1]) as unknown;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({
          rule: "SPEC-14",
          message: `amendment ${entry} does not match forge/spec-amendment@1: (frontmatter): YAML parse error: ${msg}`,
        });
        continue;
      }
      const parsed = specAmendmentSchema.safeParse(raw);
      if (parsed.success) {
        amendments.push(parsed.data);
      } else {
        errors.push({
          rule: "SPEC-14",
          message: `amendment ${entry} does not match forge/spec-amendment@1: ${formatZodIssues(parsed.error)}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({
        rule: "SPEC-14",
        message: `amendment ${entry} does not match forge/spec-amendment@1: unreadable file: ${msg}`,
      });
    }
  }

  return { amendments, errors };
}
