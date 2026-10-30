/*
<MODULE_CONTRACT>
<purpose>
RFC-1453: RFC-IMP-14 outcome gate — when an RFC's implementation diff touches
a declared `outcomeSurfaces` glob (forge.yaml), the stamp requires at least
one executed, passing outcome probe: a `page` probe, or a `run` probe whose
command equals the normalized `outcomeBuild` binding. The diff reuses the
RFC-1330 implementation-range machinery; an unresolved range falls back to
the implementation commit's own changed file set so the gate always
evaluates a deterministic file set.
</purpose>
<non-goals>
  <item>Do not re-execute probes at stamp time — the gate reads the committed envelope's recorded verdicts.</item>
  <item>Do not evaluate when no outcome surfaces are declared or no diff path matches — projects without surfaces are unaffected.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1453: outcome gate evaluator — diff/surface match, outcome-probe satisfaction, --waive-outcome warning path.</item>
  <item>RFC-1453: executed outcome probes, IMP-14 surface gate, outcome.serve + V-47/V-48</item>
</CHANGE_SUMMARY>
*/

import picomatch from "picomatch";
import type {
  AcceptanceProbe,
  VerificationEvidenceProbeRecord,
} from "../types.ts";
import {
  createOriginGit,
  resolveImplementationRange,
  type OriginGit,
} from "../verification-origin.ts";

export interface OutcomeGateInput {
  targetId: string;
  /** The RFC's declared acceptance probes. */
  probes: AcceptanceProbe[];
  /** Committed envelope probe records (verdicts read here, not re-executed). */
  evidenceRecords: VerificationEvidenceProbeRecord[] | undefined;
  git: OriginGit;
  rfcRelPath: string;
  /** Validated implementation commit (RFC-IMP-03) — fallback diff source when the accepted-transition base is unresolved. */
  implementationCommit?: string;
  /** forge.yaml `outcomeSurfaces` globs (repo-root-relative). */
  outcomeSurfaces: string[];
  /** forge.yaml `bindings.commands.outcomeBuild` — for `run`-probe normalization. */
  outcomeBuild: string | null;
  /** Operator waiver reason (operator-directed only — never agent-initiated). */
  waiveOutcome?: string;
}

export interface OutcomeGateResult {
  errors: Array<{ rule: "RFC-IMP-14"; message: string }>;
  warnings: Array<{ rule: "RFC-IMP-14"; message: string }>;
  /** True when a touched surface + waived gate fired — the caller records the waiver in the envelope. */
  waived: boolean;
}

/** Strips a leading `pnpm exec ` and collapses whitespace — the comparison form for `run`-probe equality. */
export function normalizeOutcomeBuildCommand(binding: string): string {
  return binding.replace(/^pnpm exec\s+/, "").replace(/\s+/g, " ").trim();
}

/**
 * True when a `run` probe's command equals the normalized outcomeBuild
 * binding for some target. `{target}` in the binding matches one non-space
 * token (e.g. `--site {target}` matches `--site dp7`).
 */
export function runProbeMatchesOutcomeBuild(command: string, outcomeBuild: string | null): boolean {
  if (!outcomeBuild) return false;
  const normalized = normalizeOutcomeBuildCommand(outcomeBuild);
  const probeCommand = command.replace(/\s+/g, " ").trim();
  if (!normalized.includes("{target}")) {
    return probeCommand === normalized;
  }
  const [prefix, suffix] = normalized.split("{target}", 2).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${prefix}\\S+${suffix}$`).test(probeCommand);
}

async function diffFiles(
  git: OriginGit,
  rfcRelPath: string,
  implementationCommit?: string,
): Promise<string[]> {
  const range = await resolveImplementationRange(git, rfcRelPath);
  if (range.base) {
    const out = await git.run(["diff", "--name-only", `${range.base}..${range.head}`]);
    return (out ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  }
  if (implementationCommit) {
    const out = await git.run(["show", "--name-only", "--format=", implementationCommit]);
    return (out ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  }
  return [];
}

function recordVerdict(rec: VerificationEvidenceProbeRecord): "pass" | "fail" | "unverified" {
  return rec.verdict ?? (rec.ok ? "pass" : "fail");
}

export async function evaluateOutcomeGate(input: OutcomeGateInput): Promise<OutcomeGateResult> {
  const errors: OutcomeGateResult["errors"] = [];
  const warnings: OutcomeGateResult["warnings"] = [];
  const empty = { errors, warnings, waived: false };

  if (input.outcomeSurfaces.length === 0) return empty;

  const files = await diffFiles(input.git, input.rfcRelPath, input.implementationCommit);
  if (files.length === 0) return empty;

  const matches = picomatch(input.outcomeSurfaces, { dot: true });
  const touched = files.filter((f) => matches(f));
  if (touched.length === 0) return empty;

  const satisfied = (input.evidenceRecords ?? []).some((rec) => {
    if (recordVerdict(rec) !== "pass") return false;
    if (rec.probe.probe === "page") return true;
    if (rec.probe.probe === "run") {
      return runProbeMatchesOutcomeBuild(rec.probe.command, input.outcomeBuild);
    }
    return false;
  });
  if (satisfied) return empty;

  const detail =
    `${input.targetId}: implementation diff touches ${touched.length} outcome-surface file(s) ` +
    `(e.g. ${touched.slice(0, 3).join(", ")}) but no outcome probe passed — ` +
    `record a passing \`page\` probe or a \`run\` probe equal to the outcomeBuild binding in the evidence envelope.`;

  if (input.waiveOutcome) {
    warnings.push({
      rule: "RFC-IMP-14",
      message:
        `${detail} Waived by operator: "${input.waiveOutcome}" — the waiver is recorded in the verification envelope ` +
        `and the stamp commit must carry an \`X-Outcome-Waiver:\` trailer.`,
    });
    return { errors, warnings, waived: true };
  }
  errors.push({
    rule: "RFC-IMP-14",
    message: `${detail} Operator override: re-run with --waive-outcome "<reason>" (operator-directed only).`,
  });
  return { errors, warnings, waived: false };
}

export { createOriginGit };
