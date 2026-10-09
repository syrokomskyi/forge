/*
<MODULE_CONTRACT>
<purpose>Queue manifest loading and validation (RFC-1140) — YAML parse, zod
schema, id↔filename stem check, item id pattern, document resolution across
active and archive dirs, duplicate detection, and dependsOn order warnings.
Also loads the decision-ledger sibling (RFC-1250).</purpose>
<non-goals>
  <item>Do not derive item status — that is src/pipeline-status.ts.</item>
  <item>Do not mutate the manifest file.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1250: loadDecisionLedger — sibling stem.decisions.yaml resolution,
  ENOENT-only absence (other read errors are QUEUE-01 blocking), schema check,
  ledger↔manifest binding (queue/id stem QUEUE-02, duplicate Q-N QUEUE-05),
  hygiene warnings QUEUE-08 (missing answers, foreign doc ids);
  LoadedQueueManifest exposes resolved dependsOn edges for the parking
  cascade.</item>
  <item>RFC-1140: initial manifest loader and validator.</item>
  <item>RFC-1140: steps 1-4 — shared resolver, queue module, registration

Extract pipeline-status derivation into packages/forge/src/pipeline-status.ts, refactor rfc.pipeline.status onto it, add os/queue module with queue.validate command, register in WORKSHOP_MODULE_MAP.forge + bin/cli.ts + package.json exports.</item>
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
  <item>RFC-1250: re-review wave — blocked dependsOn cascade, manifest-failure gating, generated artifacts</item>
</CHANGE_SUMMARY>
*/

import { ambientIo as fs } from "../../src/utils/io.ts";
import path from "node:path";
import YAML from "yaml";

import type { Diagnostic } from "../../src/types.ts";
import { resolveDocument } from "../../src/pipeline-status.ts";
import { QUEUE_ITEM_ID_PATTERN, decisionLedgerSchema, queueManifestSchema } from "./types.ts";
import type { DecisionLedger, QueueManifest } from "./types.ts";

export interface LoadedQueueManifest {
  manifest: QueueManifest;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** In-queue dependsOn edges resolved from document frontmatter (RFC-1250 parking cascade). */
  dependsOn: Map<string, string[]>;
}

function diag(
  ruleId: string,
  severity: "error" | "warning",
  message: string,
  file?: string,
): Diagnostic {
  return { ruleId, severity, message, file };
}

/**
 * Load and validate a queue manifest. Blocking errors: unreadable/invalid
 * YAML, schema violations, id↔filename mismatch, malformed or unresolvable
 * item ids, duplicates. Non-blocking: dependsOn order violations.
 */
export async function loadQueueManifest(
  workspaceRoot: string,
  filePath: string,
): Promise<LoadedQueueManifest> {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
  const displayPath = path.isAbsolute(filePath) ? path.relative(workspaceRoot, filePath) : filePath;

  let source: string;
  try {
    source = await fs.readFile(absolutePath);
  } catch (e) {
    errors.push(
      diag(
        "QUEUE-01",
        "error",
        `Cannot read queue manifest: ${e instanceof Error ? e.message : String(e)}`,
        displayPath,
      ),
    );
    return {
      manifest: { id: "", createdAt: "", items: [] },
      errors,
      warnings,
      dependsOn: new Map(),
    };
  }

  let raw: unknown;
  try {
    raw = YAML.parse(source);
  } catch (e) {
    errors.push(
      diag(
        "QUEUE-01",
        "error",
        `YAML parse error: ${e instanceof Error ? e.message : String(e)}`,
        displayPath,
      ),
    );
    return {
      manifest: { id: "", createdAt: "", items: [] },
      errors,
      warnings,
      dependsOn: new Map(),
    };
  }

  const parsed = queueManifestSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(
        diag(
          "QUEUE-01",
          "error",
          `Manifest schema violation at ${issue.path.join(".") || "<root>"}: ${issue.message}`,
          displayPath,
        ),
      );
    }
    return {
      manifest: { id: "", createdAt: "", items: [] },
      errors,
      warnings,
      dependsOn: new Map(),
    };
  }

  const manifest = parsed.data;

  // QUEUE-02: manifest id must equal the filename stem.
  const stem = path.basename(absolutePath).replace(/\.(ya?ml)$/i, "");
  if (manifest.id !== stem) {
    errors.push(
      diag(
        "QUEUE-02",
        "error",
        `Manifest id "${manifest.id}" does not match filename stem "${stem}"`,
        displayPath,
      ),
    );
  }

  // QUEUE-03/04/05: item id pattern, resolution, duplicates.
  const seen = new Set<string>();
  const resolvedDependsOn = new Map<string, string[]>();
  for (const item of manifest.items) {
    const id = item.id.trim();
    if (!QUEUE_ITEM_ID_PATTERN.test(id)) {
      errors.push(
        diag(
          "QUEUE-03",
          "error",
          `Item id "${item.id}" does not match ^(RFC|ADR)-\\d{4}$`,
          displayPath,
        ),
      );
      continue;
    }
    const upper = id.toUpperCase();
    if (seen.has(upper)) {
      errors.push(diag("QUEUE-05", "error", `Duplicate item id "${upper}"`, displayPath));
      continue;
    }
    seen.add(upper);

    const doc = await resolveDocument(workspaceRoot, upper);
    if (!doc) {
      errors.push(
        diag(
          "QUEUE-04",
          "error",
          `Item "${upper}" does not resolve to a document in docs/rfcs/ or docs/adrs/ (incl. archive)`,
          displayPath,
        ),
      );
      continue;
    }

    const dependsOn = doc.frontmatter["dependsOn"];
    if (Array.isArray(dependsOn)) {
      resolvedDependsOn.set(
        upper,
        dependsOn.map((d) => String(d).toUpperCase()),
      );
    }
  }

  // QUEUE-06: dependsOn order — an item must not precede its in-queue dependency.
  const order = new Map<string, number>();
  manifest.items.forEach((item, index) => order.set(item.id.trim().toUpperCase(), index));
  for (const [itemId, deps] of resolvedDependsOn) {
    const itemIndex = order.get(itemId);
    if (itemIndex === undefined) continue;
    for (const dep of deps) {
      const depIndex = order.get(dep);
      if (depIndex !== undefined && depIndex > itemIndex) {
        warnings.push(
          diag(
            "QUEUE-06",
            "warning",
            `Item "${itemId}" (position ${itemIndex + 1}) precedes its dependsOn dependency "${dep}" (position ${depIndex + 1})`,
            displayPath,
          ),
        );
      }
    }
  }

  return { manifest, errors, warnings, dependsOn: resolvedDependsOn };
}

// ---------------------------------------------------------------------------
// Decision ledger (RFC-1250) — sibling <stem>.decisions.yaml of the manifest
// ---------------------------------------------------------------------------

export interface LoadedDecisionLedger {
  ledger: DecisionLedger | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

/** Manifest `docs/queues/<id>.yaml` → sibling ledger `docs/queues/<id>.decisions.yaml`. */
export function decisionLedgerPath(manifestPath: string): string {
  return manifestPath.replace(/\.(ya?ml)$/i, ".decisions.yaml");
}

/**
 * Load the decision ledger sibling of a queue manifest. An absent ledger is
 * legal — it means zero recorded decisions. An unreadable or schema-invalid
 * ledger joins the manifest load path as a QUEUE-01 blocking error: the ledger
 * is part of the queue's durable state.
 */
export async function loadDecisionLedger(
  workspaceRoot: string,
  filePath: string,
  manifest?: QueueManifest,
): Promise<LoadedDecisionLedger> {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const ledgerPath = decisionLedgerPath(filePath);
  const absolutePath = path.isAbsolute(ledgerPath)
    ? ledgerPath
    : path.join(workspaceRoot, ledgerPath);
  const displayPath = path.isAbsolute(ledgerPath)
    ? path.relative(workspaceRoot, ledgerPath)
    : ledgerPath;

  let source: string;
  try {
    source = await fs.readFile(absolutePath);
  } catch (e) {
    // ENOENT = legal absence (zero recorded decisions). Any other read
    // failure (EACCES, EISDIR, …) is an unreadable durable artifact — the
    // ledger must never fail open into "no decisions" or QUEUE-07 disarms.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ledger: null, errors, warnings };
    }
    errors.push(
      diag(
        "QUEUE-01",
        "error",
        `Cannot read decision ledger: ${e instanceof Error ? e.message : String(e)}`,
        displayPath,
      ),
    );
    return { ledger: null, errors, warnings };
  }

  let raw: unknown;
  try {
    raw = YAML.parse(source);
  } catch (e) {
    errors.push(
      diag(
        "QUEUE-01",
        "error",
        `Decision ledger YAML parse error: ${e instanceof Error ? e.message : String(e)}`,
        displayPath,
      ),
    );
    return { ledger: null, errors, warnings };
  }

  const parsed = decisionLedgerSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(
        diag(
          "QUEUE-01",
          "error",
          `Decision ledger schema violation at ${issue.path.join(".") || "<root>"}: ${issue.message}`,
          displayPath,
        ),
      );
    }
    return { ledger: null, errors, warnings };
  }

  const ledger = parsed.data;

  // Binding and hygiene checks require a successfully loaded manifest — when
  // the manifest itself failed, the stub (empty id, no items) would blame a
  // healthy ledger for a broken queue (QUEUE-02 against "") and flag every
  // entry as foreign (QUEUE-08). The manifest failure already blocks.
  const manifestId = manifest?.id ?? "";
  const manifestReady = manifestId !== "";

  // QUEUE-02-family binding: the ledger belongs to exactly one manifest —
  // `queue` names the manifest id and `id` names the ledger filename stem
  // (`<manifest-stem>.decisions`). A misplaced or copy-pasted ledger must not
  // silently apply foreign decisions to this queue.
  const ledgerStem = path.basename(absolutePath).replace(/\.(ya?ml)$/i, "");
  if (manifestReady && ledger.queue !== manifestId) {
    errors.push(
      diag(
        "QUEUE-02",
        "error",
        `Decision ledger queue "${ledger.queue}" does not match manifest id "${manifestId}"`,
        displayPath,
      ),
    );
  }
  if (ledger.id !== ledgerStem) {
    errors.push(
      diag(
        "QUEUE-02",
        "error",
        `Decision ledger id "${ledger.id}" does not match filename stem "${ledgerStem}"`,
        displayPath,
      ),
    );
  }

  // QUEUE-05-family: decision ids are queue-global — window codes and
  // PENDING DECISION markers address them, so duplicates corrupt arbitration.
  const seenDecisions = new Set<string>();
  const manifestDocs = new Set((manifest?.items ?? []).map((i) => i.id.trim().toUpperCase()));
  for (const entry of ledger.items) {
    if (seenDecisions.has(entry.id)) {
      errors.push(diag("QUEUE-05", "error", `Duplicate decision id "${entry.id}"`, displayPath));
      continue;
    }
    seenDecisions.add(entry.id);
    if ((entry.status === "answered" || entry.status === "auto-resolved") && !entry.answer) {
      warnings.push(
        diag(
          "QUEUE-08",
          "warning",
          `Decision "${entry.id}" is ${entry.status} but carries no answer — implement has nothing to bind`,
          displayPath,
        ),
      );
    }
    if (manifestReady && !manifestDocs.has(entry.doc.toUpperCase())) {
      warnings.push(
        diag(
          "QUEUE-08",
          "warning",
          `Decision "${entry.id}" targets "${entry.doc}" which is not a manifest item — invisible to this queue`,
          displayPath,
        ),
      );
    }
  }

  return { ledger, errors, warnings };
}
