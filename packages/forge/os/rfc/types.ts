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
  <item>Tidied by compass.changesummary.tidy; see git history for prior entries.</item>
  <item>RFC-0465: added specRef field to RfcFrontmatter interface and RFC_KNOWN_KEYS array for PBP spec traceability.</item>
  <item>RFC-0478: added versionBump field to RfcFrontmatter interface and RFC_KNOWN_KEYS array for platform versioning enforcement.</item>
  <item>RFC-0480: added breaksC field to RfcFrontmatter interface and RFC_KNOWN_KEYS array for Layer C protection.</item>
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
} // ─── RFC-0268: acceptance probes ───────────────────────────────────────────

/**
 * Closed probe vocabulary (v1). `run` commands are restricted to the
 * site-kernel CLI itself (string must start with "site-kernel ") — no
 * arbitrary shell, keeping the probe surface auditable and platform-independent.
 */
export type AcceptanceProbe =
  | { probe: "run"; command: string; expect: { exitCode: number } }
  | { probe: "file-exists"; path: string }
  | { probe: "file-contains"; path: string; pattern: string }
  | { probe: "command-registered"; name: string }
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
    };

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
  results: Array<{ rfcId: string; probeResults: ProbeResult[] }>;
} // ─── RFC-0330: verification evidence ─────────────────────────────────────────
export interface VerificationEvidenceProbeRecord {
  probe: AcceptanceProbe;
  ok: boolean;
  detail: string;
  durationMs: number;
}

export interface VerificationEvidence {
  rfcId: string;
  title: string;
  rfcStatus: RfcStatus;
  emittedAt: string;
  commit: string;
  workingTreeDirty: boolean;
  kernelVersion: string;
  rfcFileHash: string;
  acceptanceHash: string;
  probes: VerificationEvidenceProbeRecord[];
  overall: "pass" | "fail";
  filesModified?: string[];
}

export interface RfcVerificationEmitResult {
  command: "rfc.verification.emit";
  status: "pass" | "fail";
  emitted: Array<{ rfcId: string; file: string; overall: "pass" | "fail" }>;
  skipped: Array<{ rfcId: string; reason: "no-probes" }>;
  diagnostics: Diagnostic[];
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
  evidencePath?: string;
}

export type RfcImplementStampRule =
  "RFC-IMP-01" | "RFC-IMP-02" | "RFC-IMP-03" | "RFC-IMP-04" | "RFC-IMP-05" | "RFC-IMP-06";

export interface RfcImplementStampViolation {
  rule: RfcImplementStampRule;
  message: string;
}

export interface RfcImplementStampResult {
  command: "rfc.implement.stamp";
  status: "pass" | "fail";
  data?: RfcImplementStampData;
  violations: RfcImplementStampViolation[];
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
  "breaksC",
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
