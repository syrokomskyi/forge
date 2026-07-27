/*
<MODULE_CONTRACT>
<purpose>spec.materialize handler — scaffolds RFC files for front nodes of a spec roadmap (RFC-0396).</purpose>
<non-goals>
  <item>Do not fill RFC content — the agent fills sections during the fo pipeline.</item>
  <item>Do not bulk-materialize past the front or above the --next cap.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0396: initial spec.materialize handler — front computation, scaffold via rfc.create, materializedAs write-back.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { toKebabCase } from "../../src/utils/string-utils.ts";
import { loadForgeConfig, resolveForgeRoot } from "../../src/config/forge-config.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";
import {
  forgeSpecSchema,
  specAmendmentSchema,
  type ForgeSpec,
  type SpecRfcNode,
  type SpecAmendment,
  resolveAmendedNode,
} from "./spec-schema.ts";
import { listRfcFiles } from "../rfc/frontmatter-io.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MaterializedNode {
  node: string;
  rfc: string;
  file: string;
}

interface SkippedNode {
  node: string;
  reason: string;
}

interface SpecMaterializeResult {
  command: "spec.materialize";
  status: "pass" | "fail";
  spec: string;
  created: MaterializedNode[];
  skipped: SkippedNode[];
  front: string[];
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

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function runSpecMaterialize(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SpecMaterializeResult>> {
  const { workspaceRoot, logger, outputFormat } = context;

  const specId = input.flags["spec"] as string | undefined;
  if (!specId) {
    return {
      data: {
        command: "spec.materialize",
        status: "fail",
        spec: "",
        created: [],
        skipped: [],
        front: [],
      },
      exitCode: 1,
      summary: "spec.materialize: --spec=<id> is required",
    };
  }

  let specsDir = "docs/specs";
  try {
    const config = loadForgeConfig(workspaceRoot);
    specsDir = config.paths.specsDir;
  } catch {
    // Use default
  }

  const specDir = path.join(workspaceRoot, specsDir, specId);
  const forgeSpecPath = path.join(specDir, "forge-spec.yaml");
  const rawSpec = await readYaml<unknown>(forgeSpecPath);
  if (!rawSpec) {
    return {
      data: {
        command: "spec.materialize",
        status: "fail",
        spec: specId,
        created: [],
        skipped: [],
        front: [],
      },
      exitCode: 1,
      summary: `spec.materialize: forge-spec.yaml not found for spec '${specId}'`,
    };
  }

  const parsed = forgeSpecSchema.safeParse(rawSpec);
  if (!parsed.success) {
    return {
      data: {
        command: "spec.materialize",
        status: "fail",
        spec: specId,
        created: [],
        skipped: [],
        front: [],
      },
      exitCode: 1,
      summary: `spec.materialize: forge-spec.yaml schema violation for spec '${specId}'`,
    };
  }

  const spec: ForgeSpec = parsed.data;

  if (spec.status !== "accepted") {
    return {
      data: {
        command: "spec.materialize",
        status: "fail",
        spec: specId,
        created: [],
        skipped: [],
        front: [],
      },
      exitCode: 1,
      summary: `spec.materialize: spec '${specId}' is not accepted (status: ${spec.status}). Run /fo-spec-ingest to complete acceptance.`,
    };
  }

  // Load amendments (RFC-0397)
  const amendmentsDir = path.join(specDir, "amendments");
  const amendments: SpecAmendment[] = [];
  if (existsSync(amendmentsDir)) {
    const amdEntries = await fs.readdir(amendmentsDir);
    for (const entry of amdEntries) {
      if (!entry.endsWith(".md")) continue;
      try {
        const content = await fs.readFile(path.join(amendmentsDir, entry), "utf8");
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;
        const raw = parseYaml(fmMatch[1]) as unknown;
        const amdParsed = specAmendmentSchema.safeParse(raw);
        if (amdParsed.success) {
          amendments.push(amdParsed.data);
        }
      } catch {
        // skip
      }
    }
  }

  const proposedAmendmentNodes = new Set<string>();
  for (const amendment of amendments) {
    if (amendment.status === "proposed") {
      for (const target of amendment.targets) {
        if (target.kind === "node") proposedAmendmentNodes.add(target.id);
      }
    }
  }

  const rfcDir = path.join(workspaceRoot, "docs", "rfcs");
  const rfcFiles = await listRfcFiles(rfcDir);

  // Load RFC statuses
  const rfcStatuses = new Map<string, string>();
  for (const file of rfcFiles) {
    try {
      const content = await fs.readFile(path.join(rfcDir, file), "utf8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
      const id = String(fm["id"] ?? "");
      const status = String(fm["status"] ?? "");
      if (id && status) rfcStatuses.set(id, status);
    } catch {
      // skip
    }
  }

  // Compute node states
  const nodeState = new Map<string, "unmaterialized" | "implemented">();
  for (const node of spec.rfcs) {
    if (node.materializedAs) {
      const status = rfcStatuses.get(node.materializedAs);
      nodeState.set(node.id, status === "implemented" ? "implemented" : "unmaterialized");
    } else {
      nodeState.set(node.id, "unmaterialized");
    }
  }

  // Compute front: unmaterialized nodes whose deps are all implemented
  function isFront(node: SpecRfcNode): boolean {
    if (node.materializedAs) return false;
    return node.dependsOn.every((dep) => nodeState.get(dep) === "implemented");
  }

  const frontNodes = spec.rfcs.filter(isFront);

  // Determine which nodes to materialize
  const explicitNodes = input.flags["nodes"] as string | undefined;
  let toMaterialize: SpecRfcNode[];

  if (explicitNodes) {
    const requested = explicitNodes.split(",").map((s) => s.trim()).filter(Boolean);
    toMaterialize = [];
    const skipped: SkippedNode[] = [];
    for (const nodeId of requested) {
      const node = spec.rfcs.find((n) => n.id === nodeId);
      if (!node) {
        skipped.push({ node: nodeId, reason: "node not found in spec" });
      } else if (!isFront(node)) {
        const blockers = node.dependsOn.filter((d) => nodeState.get(d) !== "implemented");
        skipped.push({ node: nodeId, reason: `blocked by ${blockers.join(", ")}` });
      } else {
        toMaterialize.push(node);
      }
    }
    if (skipped.length > 0 && toMaterialize.length === 0) {
      return {
        data: {
          command: "spec.materialize",
          status: "fail",
          spec: specId,
          created: [],
          skipped,
          front: frontNodes.map((n) => n.id),
        },
        exitCode: 1,
        summary: `spec.materialize: all requested nodes blocked or not found`,
      };
    }
  } else {
    const nextStr = input.flags["next"] as string | undefined;
    let next = nextStr ? parseInt(nextStr, 10) : 8;
    if (isNaN(next) || next < 1) next = 8;
    if (next > 12) next = 12;
    toMaterialize = frontNodes.slice(0, next);
  }

  // Find max RFC number
  let maxId = 0;
  for (const file of rfcFiles) {
    const match = path.basename(file).match(/^rfc-(\d{4})/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > maxId) maxId = num;
    }
  }

  // Load template from forge root (ships inside the package at os/rfc/)
  let templatePath: string;
  try {
    const forgeRoot = resolveForgeRoot(workspaceRoot);
    templatePath = path.join(forgeRoot, "os", "rfc", "rfc-0000-template.md");
  } catch {
    templatePath = path.join(workspaceRoot, "os", "rfc", "rfc-0000-template.md");
  }
  let templateContent: string;
  try {
    templateContent = await fs.readFile(templatePath, "utf-8");
  } catch {
    return {
      data: {
        command: "spec.materialize",
        status: "fail",
        spec: specId,
        created: [],
        skipped: [],
        front: frontNodes.map((n) => n.id),
      },
      exitCode: 1,
      summary: `spec.materialize: RFC template not found at ${templatePath}`,
    };
  }

  const today = toIsoDate(new Date());
  const created: MaterializedNode[] = [];
  const skipped: SkippedNode[] = [];

  for (const node of toMaterialize) {
    // Use amended node if amendments exist (RFC-0397)
    const effectiveNode = resolveAmendedNode(spec, node.id, amendments);
    const nextNum = maxId + 1;
    const paddedNum = String(nextNum).padStart(4, "0");
    const nextRfcId = `RFC-${paddedNum}`;
    const kebabTitle = toKebabCase(effectiveNode.title);
    const fileName = `rfc-${paddedNum}-${kebabTitle}.md`;

    // Warn if node has a proposed amendment (RFC-0397)
    if (proposedAmendmentNodes.has(node.id)) {
      logger.warn(`Warning: node ${node.id} has a proposed amendment — node knowledge may be about to change`);
    }

    let content = templateContent;
    content = content.replace(/^id: RFC-0000$/m, `id: ${nextRfcId}`);
    content = content.replace(/^title: ".*"$/m, `title: "${effectiveNode.title}"`);
    content = content.replace(/^status: draft$/m, `status: draft`);
    content = content.replace(/^kind: \w+$/m, `kind: contract`);
    content = content.replace(/^createdAt: YYYY-MM-DD$/m, `createdAt: ${today}`);
    content = content.replace(/^updatedAt: YYYY-MM-DD$/m, `updatedAt: ${today}`);
    content = content.replace(/^# specRef:$/m, `specRef: "${specId}/${node.id}"`);
    content = content.replace(/^# RFC-0000: .+$/m, `# ${nextRfcId}: ${effectiveNode.title}`);

    // Add normative source references in the body
    const sourceRefs = effectiveNode.sources.length > 0
      ? effectiveNode.sources.map((s) => `- ${s}`).join("\n")
      : "(none)";
    const designSection = `\n## Design\n\n**Normative source references:**\n${sourceRefs}\n\n_Fill in the implementation design for this repository. Reference vendored snapshot sections — do not copy model content._\n`;
    content = content.replace(/^---\n\n# /m, `---\n${designSection}\n# `);

    const targetPath = path.join(rfcDir, fileName);
    await fs.writeFile(targetPath, content, "utf-8");
    maxId = nextNum;

    created.push({
      node: node.id,
      rfc: nextRfcId,
      file: path.join("docs", "rfcs", fileName),
    });
  }

  // Write back materializedAs into forge-spec.yaml
  if (created.length > 0) {
    const updatedSpec: ForgeSpec = {
      ...spec,
      rfcs: spec.rfcs.map((node) => {
        const created_entry = created.find((c) => c.node === node.id);
        return created_entry ? { ...node, materializedAs: created_entry.rfc } : node;
      }),
    };
    const yamlContent = stringifyYaml(updatedSpec);
    await fs.writeFile(forgeSpecPath, yamlContent, "utf-8");
  }

  // Report skipped front nodes (beyond the materialized batch)
  const remainingFront = frontNodes
    .filter((n) => !created.some((c) => c.node === n.id))
    .map((n) => n.id);

  if (outputFormat === "pretty") {
    for (const c of created) {
      logger.success(`Materialized ${c.node} → ${c.rfc} (${c.file})`);
    }
    for (const s of skipped) {
      logger.warn(`Skipped ${s.node}: ${s.reason}`);
    }
    if (remainingFront.length > 0) {
      logger.info(`Remaining front: ${remainingFront.join(", ")}`);
    }
  }

  return {
    data: {
      command: "spec.materialize",
      status: "pass",
      spec: specId,
      created,
      skipped,
      front: remainingFront,
    },
    exitCode: 0,
    summary: `spec.materialize: created ${created.length} RFC(s) from spec '${specId}'`,
  };
}
