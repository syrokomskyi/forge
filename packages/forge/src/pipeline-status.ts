/*
<MODULE_CONTRACT>
<purpose>Shared pipeline-status resolver (RFC-1140) — derives per-document
pipeline progress (audit, enhance, plan, implement) from document frontmatter
and pipeline artifacts. Single source of truth consumed by rfc.pipeline.status,
queue.validate, and the orchestrator's resume detection. Portable layer: no
os/ or kernel imports.</purpose>
<non-goals>
  <item>Do not validate RFC/ADR content — use rfc.validate / adr.validate.</item>
  <item>Do not mutate any files — derivation is read-only.</item>
  <item>Do not store progress state — status is derived at read time, never persisted.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1140: initial shared resolver — artifact conventions (audit-*.md,
  plan-*.md, enhancedAt, implementedAt) extracted from
  os/rfc/handlers/pipeline-status.ts; QueueItemStatus derivation matrix added
  for queue.validate.</item>
  <item>RFC-1140: steps 1-4 — shared resolver, queue module, registration

Extract pipeline-status derivation into packages/forge/src/pipeline-status.ts, refactor rfc.pipeline.status onto it, add os/queue module with queue.validate command, register in WORKSHOP_MODULE_MAP.forge + bin/cli.ts + package.json exports.</item>
  <item>RFC-1250: decision-aware queue report — QueueItemReport gains kind +
  decisions counts; `next` exclusion of parked/blocked items is computed by
  the queue.validate caller (the resolver stays ledger-agnostic).</item>
  <item>RFC-1140: step 6 — cover shared resolver and queue.validate

Add pipeline-status.test.ts (derivation matrix, order, next selection, ADR, skipped) and queue-validate.test.ts (schema errors, unknown/dup ids, id-filename mismatch, empty items, dependsOn warning, JSON shape). Fix queue derivation: pipelineStep is the stage after the last completed stage, not first incomplete — handles non-contiguous artifacts.</item>
  <item>RFC-1250: review wave — QUEUE-07 gates un-parked opens only, ledger binding checks, fail-closed loader

REVIEW-RFC-1250-01 findings: QUEUE-07 no longer fires on parked entries
(the park is the containment — a parked queue stays resumable and the
decision window arbitrates it); loader fails open only on ENOENT —
other read errors are QUEUE-01; ledger gains queue/id-stem binding
(QUEUE-02), Q-N uniqueness (QUEUE-05), and QUEUE-08 hygiene warnings
(missing answers, foreign doc ids); next excludes QUEUE-07-blocked
items; top-level decision totals added. Orchestrator pre-flight treats
QUEUE-07 as the window agenda — structural errors still stop the batch;
maturation skips parked/deferred items; uncovered imperative ask sites
gain collect riders (ADR code-trace, NC markers, audit-verdict guard).</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import type { WorkspaceIO } from "./types.ts";
import { resolveIo } from "./utils/io.ts";
import YAML from "yaml";

// ---------------------------------------------------------------------------
// Pipeline stages (shared with rfc.pipeline.status)
// ---------------------------------------------------------------------------

export type PipelineStage = "audit" | "enhance" | "plan" | "implement";

export interface RfcPipelineStageInfo {
  stage: PipelineStage;
  done: boolean;
  /** File or marker that confirms completion, when applicable. */
  evidence?: string;
}

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "implemented",
  "rejected",
  "superseded",
]);

// ---------------------------------------------------------------------------
// Minimal frontmatter parsing (self-contained — src/ must not import os/)
// ---------------------------------------------------------------------------

export interface ParsedDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(source: string): ParsedDocument {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: source };
  }
  return {
    frontmatter: (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>,
    body: match[2] ?? "",
  };
}

// ---------------------------------------------------------------------------
// Artifact finders — the canonical conventions
// ---------------------------------------------------------------------------

export async function findAuditFile(
  workspaceRoot: string,
  docId: string,
  io?: WorkspaceIO,
): Promise<string | undefined> {
  const fio = resolveIo(io);
  const auditsDir = path.join(workspaceRoot, "docs/audits");
  try {
    const entries = (await fio.readdir(auditsDir)).map((e) => e.name);
    const prefix = `audit-${docId.toLowerCase()}`;
    const match = entries.find((e) => e.toLowerCase().startsWith(prefix) && e.endsWith(".md"));
    return match ? path.join("docs/audits", match) : undefined;
  } catch {
    return undefined;
  }
}

export async function findPlanFile(
  workspaceRoot: string,
  docId: string,
  io?: WorkspaceIO,
): Promise<string | undefined> {
  const fio = resolveIo(io);
  const plansDir = path.join(workspaceRoot, "docs/plans");
  try {
    const entries = (await fio.readdir(plansDir)).map((e) => e.name);
    const prefix = `plan-${docId.toLowerCase()}`;
    const match = entries.find((e) => e.toLowerCase().startsWith(prefix) && e.endsWith(".md"));
    return match ? path.join("docs/plans", match) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Document resolution — active dir + archive (implemented docs may be archived)
// ---------------------------------------------------------------------------

export type QueueDocumentKind = "rfc" | "adr";

export interface ResolvedDocument {
  id: string;
  kind: QueueDocumentKind;
  /** Workspace-relative path to the document file. */
  file: string;
  frontmatter: Record<string, unknown>;
}

const DOC_ID_PATTERN = /^(RFC|ADR)-\d{4}$/i;

async function scanForDocument(
  dirPath: string,
  relativePrefix: string,
  idLower: string,
  io: WorkspaceIO,
): Promise<string | undefined> {
  let entries;
  try {
    entries = await io.readdir(dirPath);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      const found = await scanForDocument(
        path.join(dirPath, entry.name),
        relativePath,
        idLower,
        io,
      );
      if (found) return found;
    } else if (
      entry.isFile &&
      entry.name.endsWith(".md") &&
      entry.name.toLowerCase().startsWith(idLower)
    ) {
      return relativePath;
    }
  }
  return undefined;
}

/**
 * Resolve an RFC-XXXX or ADR-XXXX id to its document file and parsed
 * frontmatter. Scans the active dir and archive subdirectories recursively.
 * Returns undefined when the id is malformed or no file matches.
 */
export async function resolveDocument(
  workspaceRoot: string,
  docId: string,
  io?: WorkspaceIO,
): Promise<ResolvedDocument | undefined> {
  const fio = resolveIo(io);
  const idMatch = DOC_ID_PATTERN.exec(docId.trim());
  if (!idMatch) return undefined;
  const kind: QueueDocumentKind = idMatch[1]!.toUpperCase() === "ADR" ? "adr" : "rfc";
  const baseDir = kind === "adr" ? "docs/adrs" : "docs/rfcs";
  const idLower = docId.toLowerCase();

  const found = await scanForDocument(path.join(workspaceRoot, baseDir), "", idLower, fio);
  if (!found) return undefined;

  let source: string;
  try {
    source = await fio.readFile(path.join(workspaceRoot, baseDir, found));
  } catch {
    return undefined;
  }
  const parsed = parseFrontmatter(source);
  return {
    id: docId.toUpperCase(),
    kind,
    file: path.join(baseDir, found),
    frontmatter: parsed.frontmatter,
  };
}

// ---------------------------------------------------------------------------
// RFC stage derivation — shared by rfc.pipeline.status and queue.validate
// ---------------------------------------------------------------------------

export interface RfcStageInput {
  status: string;
  enhancedAt?: string;
  implementedAt?: string;
  auditFile?: string;
  planFile?: string;
}

/** Compute the four pipeline stages for an RFC from frontmatter + artifacts. */
export function computeRfcPipelineStages(input: RfcStageInput): RfcPipelineStageInfo[] {
  return [
    { stage: "audit", done: !!input.auditFile, evidence: input.auditFile },
    {
      stage: "enhance",
      done: !!input.enhancedAt,
      evidence: input.enhancedAt ? `enhancedAt: ${input.enhancedAt}` : undefined,
    },
    { stage: "plan", done: !!input.planFile, evidence: input.planFile },
    {
      stage: "implement",
      done: input.status === "implemented" || !!input.implementedAt,
      evidence: input.implementedAt ? `implementedAt: ${input.implementedAt}` : undefined,
    },
  ];
}

/** First incomplete stage for a non-terminal RFC, or null when terminal. */
export function nextPipelineStep(
  status: string,
  stages: RfcPipelineStageInfo[],
): PipelineStage | null {
  if (TERMINAL_STATUSES.has(status)) return null;
  for (const s of stages) {
    if (!s.done) return s.stage;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Queue item derivation (RFC-1140)
// ---------------------------------------------------------------------------

export type QueueItemStatus = "pending" | "in-progress" | "implemented" | "skipped";

export interface QueueItemReport {
  id: string;
  status: QueueItemStatus;
  /** First incomplete pipeline stage — present only when in-progress. */
  pipelineStep?: PipelineStage;
  /** Document kind — needed by queue.validate for QUEUE-07 (any non-terminal ADR is implementable). */
  kind?: QueueDocumentKind;
  /** Decision-ledger counts (RFC-1250) — present when the queue carries a sibling ledger. */
  decisions?: { open: number; deferred: number; autoResolved: number };
}

/**
 * Derive the queue status of a single document per the RFC-1140 matrix:
 * implemented → implemented; rejected/superseded → skipped; RFC accepted or
 * plan file → in-progress/implement; enhancedAt → in-progress/plan; audit
 * file → in-progress/enhance; otherwise pending. ADR non-terminal → pending.
 */
export async function deriveQueueItemStatus(
  workspaceRoot: string,
  docId: string,
  io?: WorkspaceIO,
): Promise<QueueItemReport | undefined> {
  const fio = resolveIo(io);
  const doc = await resolveDocument(workspaceRoot, docId, fio);
  if (!doc) return undefined;

  const fm = doc.frontmatter;
  const status = String(fm["status"] ?? "");
  const implementedAt = fm["implementedAt"] ? String(fm["implementedAt"]) : undefined;

  if (status === "implemented" || implementedAt) {
    return { id: doc.id, status: "implemented", kind: doc.kind };
  }
  if (status === "rejected" || status === "superseded") {
    return { id: doc.id, status: "skipped", kind: doc.kind };
  }

  // ADR pipeline is create → implement — no intermediate artifacts exist.
  if (doc.kind === "adr") {
    return { id: doc.id, status: "pending", kind: doc.kind };
  }

  // RFC accepted means the plan step is done by definition.
  if (status === "accepted") {
    return { id: doc.id, status: "in-progress", pipelineStep: "implement", kind: doc.kind };
  }

  const enhancedAt = fm["enhancedAt"] ? String(fm["enhancedAt"]) : undefined;
  const auditFile = await findAuditFile(workspaceRoot, doc.id, fio);
  const planFile = await findPlanFile(workspaceRoot, doc.id, fio);

  const stages = computeRfcPipelineStages({
    status,
    enhancedAt,
    implementedAt,
    auditFile,
    planFile,
  });

  // Queue semantics: the actionable step is the stage AFTER the last completed
  // one — artifacts may be non-contiguous (e.g. enhancedAt without an audit
  // file), where "first incomplete stage" would wrongly report audit.
  let lastDone = -1;
  for (let i = 0; i < stages.length; i++) {
    if (stages[i]!.done) lastDone = i;
  }
  if (lastDone === -1) {
    return { id: doc.id, status: "pending", kind: doc.kind };
  }
  const nextStage = stages[lastDone + 1];
  if (!nextStage) {
    return { id: doc.id, status: "pending", kind: doc.kind };
  }
  return { id: doc.id, status: "in-progress", pipelineStep: nextStage.stage, kind: doc.kind };
}

export interface QueueReport {
  items: QueueItemReport[];
  /** First item whose derived status is pending or in-progress; null when fully terminal. */
  next: string | null;
}

/**
 * Derive the full queue report, preserving manifest order. `next` selects
 * the first pending/in-progress item; callers that need ledger-aware
 * exclusion (RFC-1250 parked/QUEUE-07-blocked items) re-filter the returned
 * items — the resolver itself stays ledger-agnostic.
 */
export async function deriveQueueReport(
  workspaceRoot: string,
  itemIds: string[],
  io?: WorkspaceIO,
): Promise<QueueReport> {
  const fio = resolveIo(io);
  const items: QueueItemReport[] = [];
  for (const id of itemIds) {
    const report = await deriveQueueItemStatus(workspaceRoot, id, fio);
    // Unresolvable ids are reported by the manifest validator; the resolver
    // skips them here so a partial report stays usable.
    if (report) items.push(report);
  }
  const nextItem = items.find((i) => i.status === "pending" || i.status === "in-progress");
  return { items, next: nextItem?.id ?? null };
}
