/*
<MODULE_CONTRACT>
<purpose>RFC-1578: RFC-IMP-16 — at `rfc.implement.stamp`, every acceptance
criterion an RFC `promotes` needs a product correctness-manifest entry with
`source: rfc-ac` and `ref: RFC-NNNN/AC-N`. Refuses when the project binds a
manifest (`bindings.paths.correctnessManifest`); warns when it binds none.</purpose>
<non-goals>
  <item>Do not validate the rest of the manifest — correctness.manifest.validate owns CORR-*.</item>
  <item>Do not check that a promoted id is a real criterion — V-55 (rfc.validate) owns that.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1578: initial RFC-IMP-16 promotion gate.</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { correctnessManifestSchema } from "../../correctness/manifest-schema.ts";
import { readCorrectnessSettings } from "../../correctness/workspace.ts";
import type { OriginGateResult } from "./implement-stamp-origin.ts";

export interface PromotesGateInput {
  targetId: string;
  frontmatter: Record<string, unknown>;
  workspaceRoot: string;
}

export function evaluatePromotesGate(input: PromotesGateInput): OriginGateResult {
  const result: OriginGateResult = { errors: [], warnings: [] };
  const raw = input.frontmatter["promotes"];
  const promoted = Array.isArray(raw) ? raw.map(String).filter((id) => /^AC-\d+$/.test(id)) : [];
  if (promoted.length === 0) return result;

  const settings = readCorrectnessSettings(input.workspaceRoot);
  if (!settings.manifestPath) {
    result.warnings.push({
      rule: "RFC-IMP-16",
      message: `${input.targetId} promotes ${promoted.join(", ")} but the project binds no correctness manifest (bindings.paths.correctnessManifest) — the promoted criteria are not tracked after the stamp`,
      fixHint:
        "bind bindings.paths.correctnessManifest and add rfc-ac entries, or accept that promotion is untracked in this project",
    });
    return result;
  }

  let refs: Set<string>;
  try {
    const doc = parseYaml(
      readFileSync(path.join(input.workspaceRoot, settings.manifestPath), "utf8"),
    );
    const parsed = correctnessManifestSchema.safeParse(doc ?? {});
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
    refs = new Set(
      parsed.data.entries.filter((e) => e.source === "rfc-ac" && e.ref).map((e) => e.ref!),
    );
  } catch (err) {
    result.errors.push({
      rule: "RFC-IMP-16",
      message: `${input.targetId} promotes ${promoted.join(", ")} but the correctness manifest ${settings.manifestPath} cannot be read: ${(err as Error).message}`,
      fixHint: "run correctness.manifest.validate and repair the manifest",
    });
    return result;
  }

  const missing = promoted.filter((ac) => !refs.has(`${input.targetId}/${ac}`));
  if (missing.length > 0) {
    result.errors.push({
      rule: "RFC-IMP-16",
      message: `${input.targetId} promotes ${missing.join(", ")} with no matching manifest entry (source: rfc-ac, ref: ${input.targetId}/<AC>) in ${settings.manifestPath}`,
      fixHint: `add a manifest entry per promoted criterion (source: rfc-ac, ref: ${input.targetId}/${missing[0]}), anchored and with an oracle`,
    });
  }
  return result;
}
