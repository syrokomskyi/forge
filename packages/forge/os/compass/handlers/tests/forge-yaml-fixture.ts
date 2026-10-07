/*
<MODULE_CONTRACT>
<purpose>Shared forge.yaml fixture helpers for compass tests — one schema-valid minimal workspace shape (bindings placeholder), a sync writer, and a temp-dir policy resolver with tracked cleanup so pattern-specific policy tests never fall back silently to generic defaults or leak mkdtemp roots.</purpose>
<non-goals>
  <item>Do not build full workspace fixtures — only forge.yaml, created on demand in caller-managed temp dirs.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1220: extract shared forge.yaml fixture from triplicated test copies — schema-required paths section included; mkdtemp roots tracked for afterEach cleanup.</item>
  <item>RFC-1220: dedupe auto-stamped CHANGE_SUMMARY item in forge-yaml fixture</item>
</CHANGE_SUMMARY>
*/

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCompassPolicy, type CompassPolicy } from "../../policy.ts";

/**
 * Minimal schema-valid forge.yaml body. `paths:` is REQUIRED — a fixture
 * without it fails `loadForgeConfig` schema validation and the resolver
 * silently falls back to generic policy.
 */
export function forgeYaml(bindings: string): string {
  return `
schema: forge/config@1
project:
  name: test-ws
  stack: [typescript]
  packageManager: pnpm
paths:
  rfcsDir: docs/rfcs
  adrsDir: docs/adrs
  plansDir: docs/plans
  auditsDir: docs/audits
  specsDir: docs/specs
  skillsDir: .agents/skills
bindings:
  schema: forge/bindings@1
  commands: {}
  paths: {}
${bindings}`;
}

/** Write a minimal forge.yaml into `<dir>/forge.yaml`. */
export function writeForgeYaml(dir: string, bindings: string): void {
  writeFileSync(join(dir, "forge.yaml"), forgeYaml(bindings));
}

const patternRoots: string[] = [];

/**
 * Resolve a Compass policy for a fresh temp workspace whose
 * `bindings.compass.idPattern` is the given union. The temp root is tracked —
 * call {@link cleanupForgeYamlFixtures} from an `afterEach`.
 */
export function policyWithIdPattern(idPattern: string): CompassPolicy {
  const root = mkdtempSync(join(tmpdir(), "compass-pattern-"));
  patternRoots.push(root);
  writeForgeYaml(root, `  compass:\n    idPattern: '${idPattern}'`);
  return resolveCompassPolicy(root);
}

/** Remove every temp root created by {@link policyWithIdPattern}. */
export function cleanupForgeYamlFixtures(): void {
  for (const root of patternRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}
