/*
<MODULE_CONTRACT>
<purpose>spec.status handler — read-only roadmap progress projection (RFC-0396).</purpose>
<non-goals>
  <item>Do not mutate any files — status is read-only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0396: initial spec.status handler — per-node states, blockers, front, progress.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadForgeConfig } from "../../src/config/forge-config.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";
import {
  forgeSpecSchema,
  specAmendmentSchema,
  type ForgeSpec,
  type SpecAmendment,
} from "./spec-schema.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpecNodeStatus {
  id: string;
  state: "unmaterialized" | "draft" | "accepted" | "implemented";
  materializedAs?: string;
  wave: number;
  blockedBy: string[];
}

interface SpecProgress {
  implemented: number;
  total: number;
}

interface SpecStatusEntry {
  id: string;
  status: string;
  nodes: SpecNodeStatus[];
  front: string[];
  progress: SpecProgress;
  amendments?: {
    proposed: number;
    accepted: number;
    rejected: number;
  };
  amendedNodes?: string[];
  amendedDecisions?: string[];
}

interface SpecStatusResult {
  command: "spec.status";
  specs: SpecStatusEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readYaml<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return parseYaml(content) as T;
  } catch {
    return null;
  }
}

async function listSpecDirs(specsDir: string): Promise<string[]> {
  if (!existsSync(specsDir)) return [];
  const entries = await fs.readdir(specsDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function loadRfcStatuses(
  rfcDir: string,
): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();
  if (!existsSync(rfcDir)) return statuses;
  const files = await fs.readdir(rfcDir);
  for (const file of files) {
    if (!file.endsWith(".md") || file.startsWith("rfc-0000")) continue;
    try {
      const content = await fs.readFile(path.join(rfcDir, file), "utf8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
      const id = String(fm["id"] ?? "");
      const status = String(fm["status"] ?? "");
      if (id && status) statuses.set(id, status);
    } catch {
      // skip
    }
  }
  return statuses;
}

async function loadAmendments(specDir: string): Promise<SpecAmendment[]> {
  const amendmentsDir = path.join(specDir, "amendments");
  if (!existsSync(amendmentsDir)) return [];

  const entries = await fs.readdir(amendmentsDir);
  const amendments: SpecAmendment[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    try {
      const content = await fs.readFile(path.join(amendmentsDir, entry), "utf8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      const raw = parseYaml(fmMatch[1]) as unknown;
      const parsed = specAmendmentSchema.safeParse(raw);
      if (parsed.success) {
        amendments.push(parsed.data);
      }
    } catch {
      // skip unreadable files
    }
  }

  return amendments;
}

function computeFront(
  nodes: SpecNodeStatus[],
  nodeMap: Map<string, SpecNodeStatus>,
): string[] {
  return nodes
    .filter((n) => n.state === "unmaterialized")
    .filter((n) => n.blockedBy.every((dep) => {
      const depNode = nodeMap.get(dep);
      return depNode?.state === "implemented";
    }))
    .map((n) => n.id);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function runSpecStatus(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SpecStatusResult>> {
  const { workspaceRoot, logger, outputFormat } = context;

  let specsDir = "docs/specs";
  try {
    const config = loadForgeConfig(workspaceRoot);
    specsDir = config.paths.specsDir;
  } catch {
    // Use default
  }

  const specsRoot = path.join(workspaceRoot, specsDir);
  const rfcDir = path.join(workspaceRoot, "docs", "rfcs");
  const filterSpec = input.flags["spec"] as string | undefined;

  let specDirs = await listSpecDirs(specsRoot);
  if (filterSpec) {
    specDirs = specDirs.filter((d) => d === filterSpec);
  }

  const rfcStatuses = await loadRfcStatuses(rfcDir);
  const results: SpecStatusEntry[] = [];

  for (const specId of specDirs) {
    const specDir = path.join(specsRoot, specId);
    const forgeSpecPath = path.join(specDir, "forge-spec.yaml");
    const rawSpec = await readYaml<unknown>(forgeSpecPath);
    if (!rawSpec) continue;

    const parsed = forgeSpecSchema.safeParse(rawSpec);
    if (!parsed.success) continue;

    const spec: ForgeSpec = parsed.data;
    const nodeMap = new Map<string, SpecNodeStatus>();
    const nodes: SpecNodeStatus[] = [];

    for (const node of spec.rfcs) {
      let state: SpecNodeStatus["state"] = "unmaterialized";
      if (node.materializedAs) {
        const rfcStatus = rfcStatuses.get(node.materializedAs);
        if (rfcStatus === "implemented") state = "implemented";
        else if (rfcStatus === "accepted") state = "accepted";
        else if (rfcStatus) state = "draft";
        else state = "draft";
      }

      const blockedBy = node.dependsOn.filter((dep) => {
        const depNode = spec.rfcs.find((n) => n.id === dep);
        if (!depNode) return false;
        if (!depNode.materializedAs) return true;
        const depStatus = rfcStatuses.get(depNode.materializedAs);
        return depStatus !== "implemented";
      });

      const nodeStatus: SpecNodeStatus = {
        id: node.id,
        state,
        materializedAs: node.materializedAs,
        wave: node.wave,
        blockedBy,
      };
      nodes.push(nodeStatus);
      nodeMap.set(node.id, nodeStatus);
    }

    const front = computeFront(nodes, nodeMap);
    const progress: SpecProgress = {
      implemented: nodes.filter((n) => n.state === "implemented").length,
      total: nodes.length,
    };

    // Load amendments (RFC-0397)
    const amendments = await loadAmendments(specDir);
    const acceptedAmendments = amendments.filter((a) => a.status === "accepted");
    const amendedNodes = new Set<string>();
    const amendedDecisions = new Set<string>();
    for (const amendment of acceptedAmendments) {
      for (const target of amendment.targets) {
        if (target.kind === "node") amendedNodes.add(target.id);
        else if (target.kind === "decision") amendedDecisions.add(target.id);
      }
    }

    results.push({
      id: spec.id,
      status: spec.status,
      nodes,
      front,
      progress,
      amendments: {
        proposed: amendments.filter((a) => a.status === "proposed").length,
        accepted: acceptedAmendments.length,
        rejected: amendments.filter((a) => a.status === "rejected").length,
      },
      amendedNodes: [...amendedNodes],
      amendedDecisions: [...amendedDecisions],
    });
  }

  if (outputFormat === "pretty") {
    if (results.length === 0) {
      logger.info("No vendored specs found.");
    } else {
      for (const entry of results) {
        logger.section(`Spec: ${entry.id} (${entry.status})`);
        logger.info(
          `Progress: ${entry.progress.implemented}/${entry.progress.total} implemented`,
        );
        logger.info(`Front: ${entry.front.join(", ") || "(none)"}`);
        for (const node of entry.nodes) {
          const blocked = node.blockedBy.length > 0
            ? ` [blocked by ${node.blockedBy.join(", ")}]`
            : "";
          logger.info(
            `  ${node.id}  ${node.state.padEnd(14)} wave ${node.wave}${blocked}`,
          );
        }
      }
    }
  }

  return {
    data: {
      command: "spec.status",
      specs: results,
    },
    exitCode: 0,
    summary: `spec.status: ${results.length} spec(s)`,
  };
}
