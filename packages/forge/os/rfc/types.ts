/***************************************************************
 * <MODULE_CONTRACT>
 * <purpose>
 * Defines types and constants for managing RFC lifecycle,
 * including statuses, kinds, and scopes, facilitating
 * structured proposal submissions.
 * </purpose>
 *  *  * <non-goals>
 * <item>Do not implement RFC processing or validation logic here.</item>
 * <item>Do not handle user input or command execution related to RFCs.</item>
 * <item>Do not manage the storage or retrieval of RFC documents.</item>
 * </non-goals>
 * </MODULE_CONTRACT>
 *  * <CHANGE_SUMMARY>
  <item>RFC-1322: steps 1-3 — --check-criteria flag, auto-check pass, atomic flip+stamp</item>
  <item>RFC-1322: fo-review fix pass — criteriaPendingRefresh/evidenceWouldRefresh dry-run fields</item>
  <item>RFC-1330: origin contracts, RFC_ORIGIN_CUTOFF, RFC-IMP-10/11 rule ids, stamp warnings.</item>
  <item>RFC-1333: steps 1-3 — report contract, rfc.verify.workspace export, RFC-IMP-12 gate, RFC-IMP-11 blocking</item>
  <item>RFC-1334: step 4 — reachable acceptance probe (symbol and command modes) and V-45</item>
  <item>RFC-1336: RfcFrontmatter.decidedBy — the granting human when an agent:&lt;id&gt; reviewer decided under an rfc.decision delegation; added to RFC_KNOWN_KEYS.</item>
  <history>RFC-0465, RFC-0478, RFC-0480, RFC-0795, RFC-0998, RFC-0999, RFC-1097, RFC-1249, RFC-1271, RFC-1306, RFC-1310, RFC-1320</history>
</CHANGE_SUMMARY>
 ***************************************************************/

import type { Diagnostic } from "../../src/types.ts";

/**
 * The lifecycle status of an RFC.
 *
 * Transitions:
 *   draft → reviewing → accepted → implemented
 *                    ↘ rejected
 *   any → superseded (when a new RFC replaces this one)
 *
 * Only a person with role "architecture" may change status.
 * Agents may only create RFCs in "draft" status.
 *
 * Derived decision mapping (not stored, computed when needed):
 *   "pending"  ← draft | reviewing
 *   "approved" ← accepted | implemented | superseded
 *   "rejected" ← rejected
 */
export type RfcStatus =
  | "draft" // Idea formed; no decision made yet.
  | "reviewing" // Under discussion; awaiting architectural decision.
  | "accepted" // Decision made; implementation may begin.
  | "implemented" // Normative change is live in code/docs/CLI.
  | "rejected" // Consciously not accepted; reason recorded.
  | "superseded"; // Historically relevant; replaced by another RFC.

export const RFC_STATUSES: readonly RfcStatus[] = [
  "draft",
  "reviewing",
  "accepted",
  "implemented",
  "rejected",
  "superseded",
] as const;

/**
 * The nature of the change an RFC proposes.
 *
 * "architecture" — introduces or modifies an architectural invariant.
 * "contract"     — adds or revises a page, component, semantic, brand, or quality contract.
 * "command"      — adds, changes, or removes a site-kernel CLI command.
 * "policy"       — establishes a governance, ownership, or agent-behavior rule.
 * "deprecation"  — officially retires a rule, command, or document.
 */
export type RfcKind = "architecture" | "contract" | "command" | "policy" | "deprecation";

export const RFC_KINDS: readonly RfcKind[] = [
  "architecture",
  "contract",
  "command",
  "policy",
  "deprecation",
] as const;

/**
 * Whether the RFC affects a single app or the whole workspace.
 *
 * "workspace" — applies to all apps and/or shared packages.
 * "app"       — applies to one specific app; may be promoted later.
 */
export type RfcScope = "app" | "workspace";

export const RFC_SCOPES: readonly RfcScope[] = ["app", "workspace"] as const; // ─── Frontmatter ─────────────────────────────────────────────────────────────

/**
 * RFC-1271: optional verification rigor declaration — standard (default)
 * checks, high (adds negative-path + independent verification where it
 * genuinely reduces risk), formal (opt-in formal/property methods for
 * precisely specifiable properties). Tier semantics live in
 * `.agents/skills/_shared/agent-operating-model.md`.
 */
export type RfcVerificationTier = "standard" | "high" | "formal";

export const RFC_VERIFICATION_TIERS: readonly RfcVerificationTier[] = [
  "standard",
  "high",
  "formal",
] as const;

/**
 * RFC-1271: where a check's expected result originates. `self` is
 * implementer-derived (diagnostic, not sole proof); `requirement` follows an
 * accepted requirement; `independent` is fixed before/independently of the
 * implementation; `external` comes from an authoritative external system.
 */
export type RfcExpectationSource = "self" | "requirement" | "independent" | "external";

export const RFC_EXPECTATION_SOURCES: readonly RfcExpectationSource[] = [
  "self",
  "requirement",
  "independent",
  "external",
] as const;
/**
 * Tracks which OS commands this RFC adds, changes, or removes.
 * Used by rfc.validate to cross-check that proposed commands
 * exist in the registry once status reaches "implemented".
 */
export interface RfcCommands {
  /** Commands this RFC intends to add. */
  proposed?: string[];
  /** Commands added by this RFC (populated when implemented). */
  added?: string[];
  /** Commands modified by this RFC (populated when implemented). */
  changed?: string[];
  /** Commands removed by this RFC (populated when implemented). */
  removed?: string[];
}

/**
 * The canonical frontmatter shape for every RFC file.
 *
 * RFC files live in `docs/rfcs/` and are named `RFC-XXXX-kebab-title.md`.
 * The frontmatter is the machine-readable contract;
 * the markdown body is the human-readable explanation.
 *
 * Design note: `decision` and `agentPolicy` fields from earlier proposals
 * are intentionally omitted. Decision is derived from status deterministically.
 * Agent policy is defined globally in AGENTS.md, not per-RFC.
 */
export interface RfcFrontmatter {
  /** Unique identifier. Format: RFC-XXXX (zero-padded to 4 digits). */
  id: string;

  /** Short imperative title. Sentence-case, no trailing period. */
  title: string;

  status: RfcStatus;
  kind: RfcKind;
  scope: RfcScope;

  /** Primary owners. At least one required. Use handle strings, e.g. "architecture". */
  owners: string[];

  /** Optional additional reviewers. */
  reviewers?: string[];

  /**
   * RFC-1336: the granting human when a reviewer is `agent:<id>` —
   * V-25 admits an agent reviewer only when decidedBy names the operator
   * AND an active `rfc.decision` delegation covers the agent under that
   * grantor. Absent on human-decided RFCs.
   */
  decidedBy?: string;

  /** ISO 8601 date of creation. */
  createdAt: string;

  /** ISO 8601 date of last frontmatter update. */
  updatedAt: string;

  /** ISO 8601 date when the RFC was enhanced via fo-idea-enhance (audit findings integrated). */
  enhancedAt?: string;

  /** ISO 8601 date when status became "implemented". */
  implementedAt?: string;

  /** ISO 8601 date when status became "rejected" or "superseded". */
  closedAt?: string;

  /**
   * IDs of RFCs this RFC supersedes.
   * Those RFCs must set supersededBy to this RFC's id.
   */
  supersedes?: string[];

  /**
   * ID of the RFC that supersedes this one (if any).
   * Set when this RFC is superseded.
   */
  supersededBy?: string;

  /**
   * IDs of RFCs this RFC amends — partially modifies without retiring.
   * Weaker than `supersedes`: the amended RFC keeps its status.
   * Those RFCs must list this RFC's id in `amendedBy`.
   */
  amends?: string[];

  /**
   * IDs of RFCs that amend this one (partial later modifications).
   * Non-terminal: being amended does NOT change this RFC's status.
   */
  amendedBy?: string[];

  /**
   * Cross-references to Architecture DNA invariants, anti-patterns,
   * spec documents, or other RFCs.
   *
   * Use identifiers like: "DNA-5", "AP-3", "RFC-0001",
   * "PAGE-MANDATORY-ARTIFACTS", "COMPONENT-THREE-WAY-MIRROR"
   */
  related?: string[];

  commands?: RfcCommands;

  /** App directory names affected by this RFC. */
  appsImpacted?: string[];

  /** Package names affected by this RFC. */
  packagesImpacted?: string[];

  /**
   * Observable signals that confirm this RFC is fully implemented
   * and working as intended. Written as plain statements, not checklist items.
   */
  successSignals?: string[];

  /**
   * Explicit list of what this RFC does NOT cover.
   * Prevents scope creep in implementation.
   */
  nonGoals?: string[];

  /**
   * RFC-0268: OPTIONAL machine-checkable acceptance probes. Executed by
   * `rfc.acceptance.run`, never automatically inside `rfc.validate` (which
   * must stay fast and side-effect free).
   */
  acceptance?: AcceptanceProbe[];

  /**
   * RFC-0331: DNA invariants this RFC satisfies. Each entry is a DNA-NN identifier.
   * Required for RFCs created on or after RFC_METADATA_CUTOFF (V-24).
   */
  satisfies?: string[];

  /**
   * RFC-0396: Traceability to a vendored spec node.
   * Format: "<spec-id>/<node-id>", e.g. "pbp-specification-package/RFC-PBP-000".
   * Set by spec.materialize; optional for non-spec RFCs.
   */
  specRef?: string;

  /**
   * RFC-0478: Platform versioning enforcement. Declares the SemVer delta
   * this RFC produces when implemented. Required for post-cutoff implemented
   * RFCs (V-29). Values: "minor" (Breaks-B, requires migrator), "patch" (safe),
   * "none" (prose-only), "major" (architectural, manually reserved).
   */
  versionBump?: "minor" | "patch" | "none" | "major";

  /**
   * RFC-0480: Declares that this RFC changes Layer C external surfaces
   * (URL schema, JSON-LD types, sitemap shape). If true, the RFC must
   * modify files in packages/ontology/src/external-surfaces/. Validated
   * by V-30.
   */
  breaksC?: boolean;

  /**
   * RFC-0711: Declares that this RFC contributes to a living feature spec
   * under docs/specs/live/<domain>.md. When true, the domain is auto-derived
   * from packagesImpacted[0]. When a string, used as an explicit domain override.
   * Absent or false means no living spec merge occurs.
   */
  liveSpec?: boolean | string;

  /**
   * RFC-0795: IDs of RFCs that must be `implemented` before this RFC
   * can be stamped `implemented` via `rfc.implement.stamp`.
   * Direct dependencies only — not transitive.
   * Each entry must match ^RFC-\d{4}$ and exist in docs/rfcs/.
   * Validated by V-33 (referential integrity) and RFC-IMP-07 (stamp gate).
   */
  dependsOn?: string[];

  /**
   * RFC-0795: Kebab-case slug grouping RFCs designed as a coherent set.
   * Example: "engine-consolidation", "pbp-locale-fixes".
   * Must match /^[a-z0-9]+(-[a-z0-9]+)*$/.
   * Optional — RFCs without a batch are standalone.
   * Filterable via `rfc.list --batch <slug>`.
   */
  batch?: string;
} // ─── RFC-0268: acceptance probes ───────────────────────────────────────────

/**
 * Closed probe vocabulary (v1). `run` commands are restricted to the
 * site-kernel CLI itself (string must start with "site-kernel ") — no
 * arbitrary shell, keeping the probe surface auditable and platform-independent.
 */
export interface AcceptanceProbeMeta {
  expectationSource?: RfcExpectationSource;
  limitations?: string;
}

export type AcceptanceProbe = (
  | { probe: "run"; command: string; expect: { exitCode: number }; criterion?: string }
  | { probe: "file-exists"; path: string; criterion?: string }
  | { probe: "file-contains"; path: string; pattern: string; criterion?: string }
  | { probe: "command-registered"; name: string; criterion?: string }
  // RFC-0333: black-box expectation against the rendered site. Executed
  // ONLY by qa.independent.run (needs a built dist); rfc.acceptance.run
  // reports it as skipped.
  | {
      probe: "page";
      path: string;
      expectStatus?: number;
      selector?: string;
      textPattern?: string;
      allowConsoleErrors?: boolean;
      criterion?: string;
    }
  // RFC-0998: run a specific vitest file or test name and check exit code.
  | {
      probe: "test";
      file: string;
      testName?: string;
      expect: { exitCode: number };
      criterion?: string;
    }
  // RFC-1334: structural wiring — symbol mode (value-imported by a non-test
  // module, optionally inside a root's import graph) or command mode (manifest reachableVia).
  | { probe: "reachable"; symbol: string; module: string; root?: string; criterion?: string }
  | { probe: "reachable"; command: string; criterion?: string }
  // RFC-0998: validate a JSON/YAML artifact against an inline JSON Schema using Ajv.
  | {
      probe: "json-schema";
      artifact: string;
      schemaInline: Record<string, unknown>;
      criterion?: string;
    }
) &
  AcceptanceProbeMeta;

export interface ProbeResult {
  probe: AcceptanceProbe;
  ok: boolean;
  /** Actual exit code / resolution info. */
  detail: string;
}

export interface RfcAcceptanceRunResult {
  command: "rfc.acceptance.run";
  status: "pass" | "fail";
  diagnostics: Diagnostic[];
  results: Array<{ rfcId: string; probeResults: ProbeResult[]; coverage?: ProbeCoverageReport }>;
} // ─── RFC-0330: verification evidence ─────────────────────────────────────────
export interface VerificationEvidenceProbeRecord {
  probe: AcceptanceProbe;
  ok: boolean;
  detail: string;
  durationMs: number;
  /** RFC-1330: git-derived origin — present for RFCs created on or after RFC_ORIGIN_CUTOFF. */
  origin?: ProbeOriginRecord;
}

/**
 * RFC-1330: origin of a probe derived from git history of the RFC's
 * implementation range (base = `status: accepted` transition, head = HEAD).
 * `presence` marks structural probe kinds whose origin is not counted.
 */
export type DerivedProbeOrigin = "self" | "verifier" | "unchanged" | "unresolved";

export interface ProbeOriginRecord {
  declared: RfcExpectationSource | "undeclared";
  derivedOrigin: DerivedProbeOrigin | "presence";
  effective: RfcExpectationSource | "undeclared" | "presence";
  /** Commit SHAs (short) that made the probe self, or the verifier report path. */
  reason: string[];
}

/** RFC-1333: one minimized counterexample returned by the acceptance verifier. */
export interface AcceptanceCounterexample {
  id: string; // CX-1, CX-2 …
  criterion: string; // AC-N or "design:<heading>"
  input: string;
  expected: string; // quoted RFC text the expectation follows from
  observed: string;
  reproCommand: string;
  triage?: "confirmed" | "disputed";
  triageReason?: string;
}

/** RFC-1333: frontmatter of docs/reviews/acceptance/<rfc>/acceptance-<date>-r<round>.md. */
export interface AcceptanceVerificationReport {
  rfcId: string;
  candidateSha: string;
  round: 0 | 1 | 2;
  isolation: "subagent" | "isolated-inline" | "inline";
  verifierModel: string | null;
  verdict: "pass" | "counterexamples" | "inconclusive";
  counterexamples: AcceptanceCounterexample[];
}

export interface ImplementationRange {
  /** null ⇒ unresolved (no `status: accepted` transition in history). */
  base: string | null;
  head: string;
}

export interface VerificationEvidence {
  rfcId: string;
  title: string;
  rfcStatus: RfcStatus;
  emittedAt: string;
  lastRefreshedAt?: string;
  commit: string;
  workingTreeDirty: boolean;
  kernelVersion: string;
  rfcFileHash: string;
  acceptanceHash: string;
  probes: VerificationEvidenceProbeRecord[];
  overall: "pass" | "fail";
  filesModified?: string[];
}

export interface VerificationDelta {
  /** Envelopes that flipped fail → pass since the committed version. */
  recovered: string[];
  /** Envelopes that flipped pass → fail since the committed version. */
  regressed: string[];
}

export interface RfcVerificationEmitResult {
  command: "rfc.verification.emit";
  status: "pass" | "fail";
  emitted: Array<{
    rfcId: string;
    file: string;
    overall: "pass" | "fail";
    previousOverall?: "pass" | "fail";
  }>;
  // RFC-1320: "stale-generated-artifact" — EVIDENCE-FRESH-01 blocked the
  // pre-probe freshness gate; "unknown-probe-kind" — EVIDENCE-FRESH-03, a
  // probe kind outside the artifact map (fail-closed); no envelope either way.
  skipped: Array<{
    rfcId: string;
    reason: "no-probes" | "stale-generated-artifact" | "unknown-probe-kind";
  }>;
  diagnostics: Diagnostic[];
  delta?: VerificationDelta;
  /** RFC-1271 `--check`: committed-vs-fresh comparison per RFC — populated
   *  only in check mode; `emitted` stays empty (nothing is written). */
  check?: Array<{ rfcId: string; match: boolean; mismatches: string[] }>;
}

export interface RfcVerificationRefreshResult {
  command: "rfc.verification.refresh";
  status: "pass" | "fail";
  refreshed: Array<{
    rfcId: string;
    file: string;
    overall: "pass" | "fail";
    previousOverall?: "pass" | "fail";
    probesTotal: number;
    probesFailed: number;
  }>;
  skipped: Array<{ rfcId: string; reason: "no evidence envelope" | "not implemented" }>;
  diagnostics: Diagnostic[];
  delta?: VerificationDelta;
  summary: { total: number; passed: number; failed: number; skipped: number };
} // ─── Validation ──────────────────────────────────────────────────────────────
export interface RfcValidationViolation {
  rfcId: string;
  file: string;
  rule: string;
  message: string;
  severity: "error" | "warning";
}

export interface Marker {
  line: number;
  text: string;
  severity: "warn" | "error";
}

export interface RfcValidationResult {
  command: "rfc.validate";
  status: "pass" | "fail";
  count: number;
  violations: RfcValidationViolation[];
  markers?: Marker[];
  coverage?: Array<{ rfcId: string; report: ProbeCoverageReport }>;
} // ─── Command results ─────────────────────────────────────────────────────────

export interface RfcCommandLifecycleDiagnosticData {
  rfcId: string;
  command: string;
  status: RfcStatus;
  bucket: "proposed" | "added" | "changed" | "removed";
}

export interface RfcCommandLifecycleViolation {
  rfcId: string;
  file: string;
  rule: "RFC-CMD-01" | "RFC-CMD-02" | "RFC-CMD-03" | "RFC-CMD-04" | "RFC-CMD-05";
  message: string;
  severity: "error" | "warning";
  data: RfcCommandLifecycleDiagnosticData;
}

export interface RfcCommandLifecycleValidationResult {
  command: "rfc.command-lifecycle.validate";
  status: "pass" | "fail";
  count: number;
  violations: RfcCommandLifecycleViolation[];
}

/** Compact RFC summary for list output. */
export interface RfcListEntry {
  id: string;
  title: string;
  status: RfcStatus;
  kind: RfcKind;
  scope: RfcScope;
  owners: string[];
  createdAt: string;
  updatedAt: string;
  file: string;
  /** RFC-0795: batch slug if this RFC belongs to a coherent set. */
  batch?: string;
  /** RFC-0795: direct dependency RFC IDs that must be implemented first. */
  dependsOn?: string[];
}

export interface RfcListResult {
  command: "rfc.list";
  status: "ok";
  count: number;
  entries: RfcListEntry[];
}

export interface RfcCreateResult {
  command: "rfc.create";
  status: "ok";
  file: string;
  id: string;
  satisfies?: string[];
  /** RFC-0329: prior decisions consulted at creation time. */
  consultedDecisions?: ConsultedDecision[];
}

export interface RfcNextIdResult {
  command: "rfc.next-id";
  nextId: string;
  nextNumber: number;
  maxExistingId: string;
  scannedFiles: number;
} // ─── RFC-0329: decision log ──────────────────────────────────────────────────
export type DecisionLogEntryKind = "rejected-rfc" | "superseded-rfc" | "rejected-alternative";

export interface DecisionLogEntry {
  kind: DecisionLogEntryKind;
  rfcId: string;
  title: string;
  status: RfcStatus;
  closedAt?: string;
  supersededBy?: string;
  decisionSummary?: string;
  alternativesText?: string;
  file: string;
}

export interface DecisionLogResult {
  command: "rfc.decision-log.generate";
  status: "ok" | "drift";
  count: number;
  entries: DecisionLogEntry[];
  written?: string[];
  /** RFC-1320: dry-run render surface for generated.drift.validate. */
  renderedFiles?: Record<string, string>;
}

export interface ConsultedDecision {
  rfcId: string;
  kind: DecisionLogEntryKind;
  title: string;
  score: number;
  file: string;
} // ─── RFC-0334: supersede propose ─────────────────────────────────────────────
export interface RfcSupersedeProposeResult {
  command: "rfc.supersede.propose";
  status: "ok";
  file: string;
  id: string;
  supersedesTarget: string;
  invariants: string[];
  consultedDecisions: ConsultedDecision[];
}

export interface RfcCheckViolation {
  rfcId: string;
  file: string;
  kind: "missing-file" | "missing-feature-flag";
  /** The artifact path or flag key that is missing. */
  artifact: string;
  message: string;
}

export interface RfcCheckResult {
  command: "rfc.check";
  status: "pass" | "fail";
  checkedRfcs: number;
  violations: RfcCheckViolation[];
}

/** One entry in the rfc.index.generate relationship index. */
export interface RfcIndexEntry {
  id: string;
  title: string;
  status: RfcStatus;
  kind: RfcKind;
  createdAt: string;
  implementedAt: string;
  closedAt: string;
  supersedes: string[];
  supersededBy: string;
  amends: string[];
  amendedBy: string[];
  related: string[];
  file: string;
}

export interface RfcIndexResult {
  command: "rfc.index.generate";
  status: "ok";
  count: number;
  entries: RfcIndexEntry[];
  /** Path written, if --write was passed. */
  written?: string;
}

export interface RfcGraphResult {
  command: "rfc.graph";
  status: "ok";
  id: string;
  supersedes: string[];
  supersededBy: string;
  amends: string[];
  amendedBy: string[];
  related: string[];
} // ─── RFC-0476: rfc.implement.stamp ──────────────────────────────────────────
export interface RfcImplementStampData {
  rfcId: string;
  implementationCommit: string;
  stampedAt: string;
  criteriaChecked: number;
  /** RFC-1322: criterion ids flipped `[ ]` → `[x]` by --check-criteria. */
  criteriaAutoChecked?: string[];
  /**
   * RFC-1322 dry-run only: criterion ids whose `probe:` annotations await the
   * envelope refresh a real run would perform — pending, not failures.
   */
  criteriaPendingRefresh?: string[];
  /** RFC-1322 dry-run only: the missing/stale envelope would be refreshed first. */
  evidenceWouldRefresh?: boolean;
  evidencePath?: string;
  evidenceReEmitted?: boolean;
  metricsPath?: string;
}

export type RfcImplementStampRule =
  | "RFC-IMP-01"
  | "RFC-IMP-02"
  | "RFC-IMP-03"
  | "RFC-IMP-04"
  | "RFC-IMP-05"
  | "RFC-IMP-06"
  | "RFC-IMP-07"
  | "RFC-IMP-08"
  | "RFC-IMP-09"
  // RFC-1330: declared expectationSource contradicted by git-derived origin.
  | "RFC-IMP-10"
  // RFC-1330: verificationTier high WHEN/IF criterion without non-self evidence.
  | "RFC-IMP-11"
  // RFC-1333: verificationTier high needs a passing, subagent-isolated
  // acceptance-verification report bound to the implementation commit.
  | "RFC-IMP-12"
  // RFC-1310: commit-time governance provenance — the implementation commit
  // must carry the X-RFC trailer or an injected CHANGE_SUMMARY item.
  | "STAMP-GOV-01"
  // RFC-1306: --sync delegates to rfc.evidence.sync through ctx.invoke; the
  // chain's own rule ids surface as stamp violations on host-less or
  // mid-chain-failure paths.
  | "EVIDENCE-SYNC-01"
  | "EVIDENCE-SYNC-02"
  // RFC-1322: --check-criteria — an unchecked criterion carries no resolvable
  // (evidence: ...) annotation; the stamp refuses rather than blank-checking.
  | "STAMP-CHECK-01";

export interface RfcImplementStampViolation {
  rule: RfcImplementStampRule;
  message: string;
}

export interface RfcImplementStampResult {
  command: "rfc.implement.stamp";
  status: "pass" | "fail";
  data?: RfcImplementStampData;
  violations: RfcImplementStampViolation[];
  /** RFC-1330: non-blocking gate findings (RFC-IMP-11 until RFC-1333). */
  warnings?: RfcImplementStampViolation[];
} // ─── Constants ───────────────────────────────────────────────────────────────
export const RFC_DIR = "docs/rfcs";
export const RFC_TEMPLATE_FILE = "docs/rfcs/rfc-0000-template.md";
export const RFC_TEMPLATE_FALLBACK_FILE = "os/rfc/rfc-0000-template.md";
export const RFC_ID_PATTERN = /^RFC-\d{4}$/;

/** Required H2 sections for every RFC. */
export const RFC_FULL_REQUIRED_SECTIONS = [
  "Context",
  "Problem",
  "Decision",
  "Architectural fit",
  "Design",
  "Rollout",
  "Alternatives considered",
  "Risks",
  "Acceptance criteria",
  "Implementation notes for agents",
] as const;

/** Every frontmatter key the RFC schema sanctions. V-20 warns on anything else. */
export const RFC_KNOWN_KEYS: readonly string[] = [
  "id",
  "title",
  "status",
  "kind",
  "scope",
  "owners",
  "reviewers",
  "decidedBy",
  "createdAt",
  "updatedAt",
  "enhancedAt",
  "implementedAt",
  "closedAt",
  "supersedes",
  "supersededBy",
  "amends",
  "amendedBy",
  "related",
  "commands",
  "appsImpacted",
  "packagesImpacted",
  "successSignals",
  "nonGoals",
  "acceptance",
  "satisfies",
  "specRef",
  "versionBump",
  "verificationTier",
  "breaksC",
  "liveSpec",
  "dependsOn",
  "batch",
] as const;

/**
 * RFC-0330 / RFC-0331 / RFC-0335: shared cutoff date for new metadata rules.
 * RFCs created on or after this date are subject to V-23 (evidence), V-24 (DNA-trace),
 * and V-25 (reviewer identity). RFCs created before are exempt.
 */
export const RFC_METADATA_CUTOFF = "2026-07-07";

/**
 * RFC-0478: cutoff date for versionBump enforcement (V-29).
 * RFCs created on or after this date with status "implemented" must declare
 * a versionBump field. RFCs created before are exempt.
 */
export const RFC_VERSION_BUMP_CUTOFF = "2026-07-21";

/**
 * RFC-0997: cutoff date for probe-criterion binding rules.
 * RFCs created on or after this date are subject to V-35 (probe→criterion
 * referential integrity), V-36 (criterion identifier discipline), V-37
 * (evidence mechanism validity), and RFC-IMP-08 (minimum-one-probe stamp gate).
 * RFCs created before are exempt.
 */
export const RFC_PROBE_BINDING_CUTOFF = "2026-09-01";

/**
 * RFC-1006: cutoff date for criteria content rules (phase separation, reject
 * checklist, criterion versioning). RFCs created on or after this date are
 * subject to V-38 (document readiness completeness), V-39 (non-atomic
 * criterion), V-40 (unbounded quantity), V-41 (weasel verb), and V-42
 * (criterion versioning annotation format). RFCs created before are exempt.
 */
export const RFC_CRITERIA_CONTENT_CUTOFF = "2026-09-03";

/**
 * RFC-1330: cutoff date for git-derived probe origin. RFCs created on or after
 * this date get `origin` records in their evidence envelope and are subject to
 * V-44 (presence-only behavioral criterion), RFC-IMP-10 (declared origin
 * contradicted by git), and RFC-IMP-11 (HIGH tier needs non-self evidence).
 */
export const RFC_ORIGIN_CUTOFF = "2026-10-18";

/** RFC-1334: cutoff for V-45 (proposed/added commands need a command-mode reachable probe). */
export const RFC_REACHABLE_CUTOFF = "2026-10-18";

/**
 * RFC-0997: non-blocking probe coverage report per RFC.
 * Emitted in `rfc.validate --json` and `rfc.acceptance.run` outputs.
 */
export interface ProbeCoverageReport {
  totalCriteria: number;
  probeBackedCriteria: number;
  coverageRatio: number;
  unboundProbes: string[];
  uncoveredCriteria: string[];
}
