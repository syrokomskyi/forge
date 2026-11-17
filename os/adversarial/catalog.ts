/*
<MODULE_CONTRACT>
<purpose>RFC-1616: the packaged adversarial scenario catalog — loads
docs/adversarial/<name>/scenario.yaml fixtures shipped with the package,
validates each against forge/adversarial-scenario@1, and reports uncovered
expected rules for the drift guard (new gate rules must add a scenario or
declare requires coverage).</purpose>
<non-goals>
  <item>Does not replay scenarios — runner.ts owns the scratch-clone execution.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1616: initial catalog loader.</item>
  <item>RFC-1616: external verification trust boundary

policy.digest (canonical SHA-256 over the frozen surface), adversarial.run
with a 12-scenario catalog replayed through the real gate in a scratch
clone, flow.push verifier-trailer hard stop (fail-closed on unreadable
forge.yaml), project.owner + push.requireVerifierReview config, trust-boundary
scaffold (CODEOWNERS + forge-policy workflow) and reference docs.</item>
</CHANGE_SUMMARY>
*/

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  adversarialScenarioSchema,
  type AdversarialScenario,
} from "../../src/adversarial/types.ts";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Ascend from this module to the directory holding `package.json` (src or dist layout). */
export function packageRoot(from: string = MODULE_DIR): string {
  let dir = from;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

export const CATALOG_DIR = path.join(packageRoot(), "docs", "adversarial");

export interface CatalogEntry {
  name: string;
  scenario?: AdversarialScenario;
  error?: string;
}

export function loadCatalog(dir: string = CATALOG_DIR): CatalogEntry[] {
  if (!existsSync(dir)) return [];
  const out: CatalogEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "scenario.yaml");
    if (!existsSync(file)) {
      out.push({ name: entry.name, error: `missing scenario.yaml` });
      continue;
    }
    try {
      const parsed = adversarialScenarioSchema.safeParse(parseYaml(readFileSync(file, "utf8")));
      if (parsed.success) out.push({ name: entry.name, scenario: parsed.data });
      else out.push({ name: entry.name, error: parsed.error.issues[0]?.message ?? "invalid" });
    } catch (e) {
      out.push({ name: entry.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
