/*
<MODULE_CONTRACT>
<purpose>
Shared fixture builders for the RFC-1391 independent verifier checks —
tmp-workspace and runtime-context helpers only. Nothing here re-implements
production logic; expectations live in the *.acceptance.test.ts files.
</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1391 r1 verification: shared verifier support module.</item>
  <item>RFC-1391: commit independent verifier checks + independent probes + round-1 pass report

Round-0 verdict counterexamples (CX-1: emit dead for proof-probe RFCs),
fixed in 1342fe21a; round-1 verdict pass — 47/47 checks, AC-1..AC-10 all
verified on the real implementation surface, non-vacuity re-verified by
mutation.</item>
  <item>RFC-1391: close RFC-1391 review r1 findings — evidence freshness, config classification, contract guards

REVIEW-CODE-2026-10-24-04 (warning): a stale .cache/proofs report could
fabricate proved; forge.yaml now resolves inside runProofCheck so a malformed
config is error not unavailable, and both surfaces share one path; {entry} is
required in formal.tools.command; spec/entry paths are confined to the
workspace; the exhaustive entry dispatches per packageManager; proved runs
record log, counterexample stays the refuted-path record.</item>
  <item>RFC-1485: sweep compass headers — forge-os-rfc</item>
</CHANGE_SUMMARY>
*/

// RFC-1391 verifier fixtures — independent acceptance-check support.
// Nothing here re-implements production logic; these are tmp-workspace and
// context builders only. Expectations are derived from the RFC text.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ForgeRuntimeContext } from "../../../../src/types.ts";

/** packages/forge absolute path — workspaceRoot for the real-vitest spawns. */
export const FORGE_ROOT = resolve(__dirname, "../../../../");
/** Export (monorepo) root — workspaceRoot for registry/reachability/doc probes. */
export const EXPORT_ROOT = resolve(FORGE_ROOT, "../..");

export function tmpWorkspace(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function put(dir: string, rel: string, body: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

/** Git porcelain inside a fixture repo — env stripped of outer-repo vars. */
export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "v",
      GIT_AUTHOR_EMAIL: "v@v",
      GIT_COMMITTER_NAME: "v",
      GIT_COMMITTER_EMAIL: "v@v",
    },
  }).trim();
}

/** Minimal runtime context for handler-level calls (json output, no-op logger). */
export function ctx(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
      section: () => {},
      debug: () => {},
    },
    outputFormat: "json",
    commandRegistry: undefined,
    dryRun: false,
  } as unknown as ForgeRuntimeContext;
}

/** forge/config@1 with a `formal.tools` block (yaml text injected). */
export function forgeYaml(toolsBlock: string): string {
  return `schema: forge/config@1
project:
  name: verifier-fixture
paths: {}
${toolsBlock}`;
}

/** A `formal.tools:` section declaring `tlc` bound to node -e stub argv. */
export const TLC_STUB_TOOLS = `formal:
  tools:
    tlc:
      command: ["node", "-e", "process.exit(0)", "{entry}"]
      versionCommand: ["node", "-e", "console.log('TLC2 Version 2.18')"]
      versionPattern: "TLC2 Version (\\\\S+)"
      installHint: "install the tlc stub (fixture)"
`;

/** `formal.tools` whose executable cannot be spawned (ENOENT). */
export const TLC_MISSING_EXE_TOOLS = `formal:
  tools:
    tlc:
      command: ["/nonexistent/checker-tlc-9x7", "-deadlock", "{entry}"]
      versionCommand: ["/nonexistent/checker-tlc-9x7", "-version"]
      versionPattern: "Version (\\\\S+)"
      installHint: "brew install tlc2tools (fixture hint)"
`;

/** forge/proof-spec@1 YAML for an external tool binding. */
export function externalSpec(over: Partial<Record<string, unknown>> = {}): string {
  const toolVersion = (over["toolVersion"] as string) ?? "2.18";
  const id = (over["id"] as string) ?? "PROOF-verify-external";
  const tool = (over["tool"] as string) ?? "tlc";
  const entry = (over["entry"] as string) ?? "specs/claims.tla";
  return `schema: forge/proof-spec@1
id: ${id}
invariantRefs: [INV-verify-01]
statement: "The stubbed checker accepts the target at the pinned version."
tool: ${tool}
toolVersion: "${toolVersion}"
entry: ${entry}
target: "ClaimsConvergence"
domain:
  description: "bounded claims model"
  cardinality: 42
assumptions:
  - "the stub models the real checker faithfully"
trustedBase:
  - "node runtime and the stub executable"
unverifiedBoundaries:
  - "transport outside the model"
`;
}

/** forge/proof-spec@1 YAML for the built-in exhaustive runner. */
export function exhaustiveSpec(over: Partial<Record<string, unknown>> = {}): string {
  const id = (over["id"] as string) ?? "PROOF-verify-exhaustive";
  const toolVersion = (over["toolVersion"] as string) ?? "1";
  const entry = (over["entry"] as string) ?? "specs/domain.proof.test.ts";
  const domain =
    over["domain"] === null
      ? ""
      : `domain:
  description: "small literal domain"
  cardinality: ${String(over["cardinality"] ?? 3)}
`;
  return `schema: forge/proof-spec@1
id: ${id}
invariantRefs: [INV-verify-01]
statement: "every enumerated input satisfies the predicate"
tool: exhaustive
toolVersion: "${toolVersion}"
entry: ${entry}
target: "small domain"
${domain}assumptions:
  - "deterministic literal domain"
trustedBase:
  - "the forge exhaustive runner"
unverifiedBoundaries:
  - "nothing outside the literal inputs"
`;
}

/** Minimal valid RFC markdown for stamp/validate fixtures. */
export function rfcMd(opts: {
  id: string;
  tier?: string;
  status?: string;
  probesYaml: string;
  criteria: string[];
  createdAt?: string;
}): string {
  const lines = opts.criteria.map((c) => `- [x] ${c}`).join("\n");
  return `---
id: ${opts.id}
title: "${opts.id} verifier fixture"
status: ${opts.status ?? "accepted"}
kind: contract
scope: workspace
owners:
  - architecture
createdAt: ${opts.createdAt ?? "2026-10-24"}
updatedAt: ${opts.createdAt ?? "2026-10-24"}
verificationTier: ${opts.tier ?? "formal"}
acceptance:
${opts.probesYaml}
---

# ${opts.id}

## Context

Verifier fixture.

## Acceptance criteria

${lines}
`;
}
