/*
<MODULE_CONTRACT>
<purpose>Queue manifest loading and validation (RFC-1140) — YAML parse, zod
schema, id↔filename stem check, item id pattern, document resolution across
active and archive dirs, duplicate detection, and dependsOn order warnings.</purpose>
<non-goals>
  <item>Do not derive item status — that is src/pipeline-status.ts.</item>
  <item>Do not mutate the manifest file.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1140: initial manifest loader and validator.</item>
  <item>RFC-1140: steps 1-4 — shared resolver, queue module, registration

Extract pipeline-status derivation into packages/forge/src/pipeline-status.ts, refactor rfc.pipeline.status onto it, add os/queue module with queue.validate command, register in WORKSHOP_MODULE_MAP.forge + bin/cli.ts + package.json exports.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

import type { Diagnostic } from "../../src/types.ts";
import { resolveDocument } from "../../src/pipeline-status.ts";
import { QUEUE_ITEM_ID_PATTERN, queueManifestSchema } from "./types.ts";
import type { QueueManifest } from "./types.ts";

export interface LoadedQueueManifest {
  manifest: QueueManifest;
  errors: Diagnostic[];
  warnings: Diagnostic[];
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
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(workspaceRoot, filePath);
  const displayPath = path.isAbsolute(filePath)
    ? path.relative(workspaceRoot, filePath)
    : filePath;

  let source: string;
  try {
    source = await fs.readFile(absolutePath, "utf-8");
  } catch (e) {
    errors.push(
      diag(
        "QUEUE-01",
        "error",
        `Cannot read queue manifest: ${e instanceof Error ? e.message : String(e)}`,
        displayPath,
      ),
    );
    return { manifest: { id: "", createdAt: "", items: [] }, errors, warnings };
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
    return { manifest: { id: "", createdAt: "", items: [] }, errors, warnings };
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
    return { manifest: { id: "", createdAt: "", items: [] }, errors, warnings };
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
        diag("QUEUE-03", "error", `Item id "${item.id}" does not match ^(RFC|ADR)-\\d{4}$`, displayPath),
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

  return { manifest, errors, warnings };
}
