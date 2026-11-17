/*
<MODULE_CONTRACT>
<purpose>RFC-1589 pre-lock integration-gate helpers: the locked-delta step
selection (a forge-side mirror of the RFC-1582 domain vocabulary the real
gate applies to its own changed set), the develop-delta path list, and the
append-only pre-lock verdict records at
&lt;git-common-dir&gt;/forge/pre-lock-verdicts.json.</purpose>
<non-goals>
  <item>No gate execution — hooks/integration-gate.sh runs the real steps;
  this module only decides whether the locked delta is small enough to keep
  or whether the attempt restarts (the progress guarantee).</item>
  <item>No lock management — os/flow/locks.ts owns integrate.lock.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The selector mirrors werkstatt-site's GATE_STEP_DOMAINS vocabulary (autonomy forbids importing) — drift only over/under-selects, never skips.</item>
  <item>Unclassified or always-in-domain delta paths select every step —
  the same fail-closed direction the real gate takes.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1589: pre-lock verdict store + locked-delta selection mirror + progress guarantee inputs</item>
  <item>RFC-1589: run the integration gate outside the integration lock</item>
  <item>RFC-1592: probe-or-retire ratchet for blocking check rules

Every error-severity check rule now needs liveness evidence — a bound
gate-probe fixture that has actually run — or an explicit entry in the
shrink-only unprobed baseline, enforced by gate.probe.catalog --check
(PROBE-06/07) and wired into the worktree gate as probe-ratchet.

- probe-runs journal (docs/.index/gate-probes/runs.jsonl) records each
  gate.probe fixture execution; shared liveness.ts joins fixtures x
  journal for catalog + contribution report (liveness: none|fixture|fired)
- gate.probe.catalog --check/--write-baseline: PROBE-06 unprobed error
  rule, PROBE-07 stale baseline entry, PROBE-08 baseline growth refusal
  (shrink-only, no file modification), PROBE-09 expired/undeclared
  warnOnly provisional step
- checks.contribution.report adds liveness to every rule record
- KernelPipelineStep/RuleDescriptor gain provisionalUntil; the two
  warnOnly pipeline steps carry future dates
- worktree gate adds probe-ratchet step; gate-domains + forge pre-lock
  DELTA_STEP_SPECS mirror updated
- build-verification policy states blocking rules are probed or retired;
  fo-session-retro preserves probe/retire evidence for escape frictions
- baseline adopted at 1678 entries (forge/unprobed-baseline@1)</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import picomatch from "picomatch";
import { parse as yamlParse } from "yaml";

import type { WorkspaceIO } from "../../src/types.ts";

import { gitEvidence } from "./git.ts";

/** Where flow.integrate's pre-lock verdict records land — a sibling of the
 * RFC-1519 advisory gate-verdicts.json store (that file is machine-owned by
 * the gate and filters `verdicts[]` for well-formed check rows on every
 * load, so a foreign `pre-lock` record would be dropped on the next write).
 * The shared git dir survives worktree teardown. */
export const PRE_LOCK_VERDICTS_RELATIVE_PATH = "forge/pre-lock-verdicts.json";

export const PRE_LOCK_VERDICTS_SCHEMA = "forge/pre-lock-verdicts@1";

/** RFC-1589: how the integration gate ran for a successful integrate. */
export type IntegrateGateMode = "pre-lock" | "locked-delta" | "locked-full";

/** One `pre-lock` record — appended to pre-lock-verdicts.json after the
 * unlocked Phase-A gate, so a locked revalidation can audit which base and
 * tip the verdict covered. */
export interface PreLockVerdict {
  kind: "pre-lock";
  branch: string;
  /** Branch tip the Phase-A gate + correctness gate judged. */
  branchTip: string;
  /** develop tip the branch rebased onto and the gate diffed against. */
  base: string;
  /** Gate check rows as {id, status} when the persisted report was readable. */
  steps: Array<{ id: string; status: string }>;
  /** RFC-1532 report path when the gate wrote one. */
  reportPath?: string;
  at: string;
}

export interface DeltaGateSelection {
  /** Step ids the delta selects (domain intersection + always anchors). */
  selected: string[];
  /** Total integrate-phase step envelope size — the >half denominator. */
  total: number;
}

/**
 * Forge-side mirror of werkstatt-site's GATE_STEP_DOMAINS (RFC-1582). Ids
 * match the check rows the real gate emits; `command` entries resolve their
 * domains from the PRIMARY's generated command manifest (reads ∪ writes),
 * `inputDomains` are inline repo-relative globs, and entries with neither
 * are anchors (always run). Keep in sync with
 * packages/werkstatt-site/src/checks/gate-domains.ts — drift degrades
 * restart precision, never correctness.
 */
const DELTA_STEP_SPECS: ReadonlyArray<{
  id: string;
  command?: string | readonly string[];
  inputDomains?: readonly string[];
}> = [
  { id: "open-missions" },
  { id: "changed-range" },
  { id: "manifests", command: ["command.manifest.validate", "ecosystem.manifest.validate"] },
  { id: "scoped-tests", inputDomains: ["packages/**", "services/**", "integrations/**"] },
  { id: "scoped-typecheck", inputDomains: ["packages/**", "services/**", "integrations/**"] },
  { id: "scoped-lint", inputDomains: ["packages/**"] },
  { id: "test-depth", command: "test.depth.lint" },
  { id: "rfc-validate", command: "rfc.validate" },
  { id: "probe-ratchet", command: "gate.probe.catalog" },
  { id: "cold-e2e", inputDomains: ["packages/**", "services/**", "integrations/**"] },
];

/** Mirror of ALWAYS_IN_DOMAIN (RFC-1582) — repo skeleton/tooling surfaces a
 * develop move can invalidate under every step. */
const ALWAYS_IN_DOMAIN: readonly string[] = [
  ".github/**",
  "hooks/**",
  "pnpm-*.yaml",
  "package.json",
  "turbo.json",
  "tsconfig*",
  "forge.yaml",
];

/** Mirror of DOCS_DOMAIN (RFC-1582) — selects no step. */
const DOCS_DOMAIN: readonly string[] = ["docs/**", ".agents/memory/**"];

const COMMAND_MANIFEST_RELATIVE_PATH = "docs/command-manifest.generated.yaml";

/** `git diff --name-only B0..B1` — the paths a develop move invalidated.
 * Run in the primary checkout where both tips resolve. */
export async function deltaChangedPaths(
  io: WorkspaceIO,
  primary: string,
  b0: string,
  b1: string,
): Promise<string[]> {
  const diff = await gitEvidence(primary, ["diff", "--name-only", `${b0}..${b1}`]);
  if (diff.exitCode !== 0) return [];
  return diff.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function parseManifestSurfaces(
  text: string,
): Map<string, { reads: readonly string[]; writes: readonly string[] }> {
  const parsed = yamlParse(text) as { commands?: unknown } | null;
  const list = Array.isArray(parsed?.commands) ? parsed.commands : [];
  const map = new Map<string, { reads: readonly string[]; writes: readonly string[] }>();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { name?: unknown; reads?: unknown; writes?: unknown };
    if (typeof e.name !== "string") continue;
    map.set(e.name, {
      reads: Array.isArray(e.reads)
        ? e.reads.filter((r): r is string => typeof r === "string")
        : [],
      writes: Array.isArray(e.writes)
        ? e.writes.filter((w): w is string => typeof w === "string")
        : [],
    });
  }
  return map;
}

/** Resolve each mirrored step's domain globs against the primary's command
 * manifest — null means full-domain (anchor or unresolvable surface, never
 * skip). Same primary-wins + fail-closed doctrine as the real resolver. */
export async function resolveDeltaStepDomains(
  io: WorkspaceIO,
  primary: string,
): Promise<Map<string, readonly string[] | null>> {
  let commands: ReturnType<typeof parseManifestSurfaces> | null = null;
  try {
    commands = parseManifestSurfaces(
      await io.readFile(join(primary, COMMAND_MANIFEST_RELATIVE_PATH)),
    );
  } catch {
    commands = null;
  }
  const resolved = new Map<string, readonly string[] | null>();
  for (const spec of DELTA_STEP_SPECS) {
    const names = spec.command === undefined ? [] : [spec.command].flat();
    if (names.length === 0) {
      resolved.set(spec.id, spec.inputDomains ?? null);
      continue;
    }
    if (commands === null) {
      resolved.set(spec.id, null);
      continue;
    }
    const globs = new Set<string>();
    for (const name of names) {
      const c = commands.get(name);
      if (c === undefined) {
        // Unverifiable surface — fail closed to full-domain.
        globs.clear();
        break;
      }
      for (const g of [...c.reads, ...c.writes]) globs.add(g);
    }
    resolved.set(spec.id, globs.size === 0 ? null : [...globs]);
  }
  return resolved;
}

/** Select the steps a develop delta re-runs: steps whose resolved domains
 * intersect any delta path, plus every anchor (undeclared/full-domain
 * step). An always-in-domain or unclassified delta path selects all steps —
 * the fail-closed direction. Steps absent from the mirror registry count as
 * anchors (never skipped — RFC-1589 MUST-NOT). */
export function selectDeltaGateSteps(
  deltaPaths: readonly string[],
  resolved: ReadonlyMap<string, readonly string[] | null>,
  total?: number,
): DeltaGateSelection {
  const allStepIds = new Set(resolved.keys());
  const totalSteps = total ?? DELTA_STEP_SPECS.length;
  const alwaysIn = picomatch([...ALWAYS_IN_DOMAIN], { dot: true });
  const docsDomain = picomatch([...DOCS_DOMAIN], { dot: true });
  const stepMatchers = new Map<string, picomatch.Matcher>();
  for (const [id, domains] of resolved) {
    if (domains !== null && domains.length > 0) {
      stepMatchers.set(id, picomatch([...domains], { dot: true }));
    }
  }

  const selected = new Set<string>();
  let failClosed = false;
  for (const file of deltaPaths) {
    if (alwaysIn(file)) {
      failClosed = true;
      break;
    }
    let matched = false;
    for (const [id, match] of stepMatchers) {
      if (match(file)) {
        selected.add(id);
        matched = true;
      }
    }
    if (!matched && !docsDomain(file)) {
      // Unclassified delta path — the real gate fails closed to a full run.
      failClosed = true;
      break;
    }
  }
  if (failClosed) return { selected: [...allStepIds].sort(), total: totalSteps };

  // Anchors (undeclared or unresolvable domains) always run.
  for (const [id, domains] of resolved) {
    if (domains === null || domains === undefined) selected.add(id);
  }
  return { selected: [...selected].sort(), total: totalSteps };
}

/** Append a `pre-lock` verdict record to pre-lock-verdicts.json —
 * best-effort audit bookkeeping; a write failure never refuses the
 * integration. */
export async function recordPreLockVerdict(
  io: WorkspaceIO,
  commonGitDir: string,
  record: Omit<PreLockVerdict, "kind" | "at"> & { at?: string },
): Promise<void> {
  try {
    const file = join(commonGitDir, PRE_LOCK_VERDICTS_RELATIVE_PATH);
    let verdicts: unknown[] = [];
    if (await io.exists(file)) {
      try {
        const parsed = JSON.parse(await io.readFile(file)) as {
          schema?: unknown;
          verdicts?: unknown;
        };
        if (parsed?.schema === PRE_LOCK_VERDICTS_SCHEMA && Array.isArray(parsed.verdicts)) {
          verdicts = parsed.verdicts;
        }
      } catch {
        verdicts = [];
      }
    }
    verdicts.push({ kind: "pre-lock", at: record.at ?? new Date().toISOString(), ...record });
    await io.mkdir(join(commonGitDir, "forge"));
    await io.writeFile(
      file,
      `${JSON.stringify({ schema: PRE_LOCK_VERDICTS_SCHEMA, verdicts }, null, 2)}\n`,
    );
  } catch {
    /* verdict records are audit, never a gate */
  }
}

/** Read the persisted gate report's per-row {id, status} pairs — the
 * verdict's `steps` payload; empty when the report is absent or unreadable. */
export async function gateReportSteps(
  io: WorkspaceIO,
  primary: string,
  reportPath: string | null | undefined,
): Promise<Array<{ id: string; status: string }>> {
  if (!reportPath) return [];
  try {
    const parsed = JSON.parse(await io.readFile(join(primary, reportPath))) as {
      checks?: unknown;
    };
    const rows = Array.isArray(parsed?.checks) ? parsed.checks : [];
    const steps: Array<{ id: string; status: string }> = [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as { id?: unknown; status?: unknown };
      if (typeof r.id === "string" && typeof r.status === "string") {
        steps.push({ id: r.id, status: r.status });
      }
    }
    return steps;
  } catch {
    return [];
  }
}
