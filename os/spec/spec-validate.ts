/*
<MODULE_CONTRACT>
<purpose>spec.validate handler — validates vendored spec packages under docs/specs/ (RFC-0394).</purpose>
<non-goals>
  <item>Do not modify spec files — validate is read-only.</item>
  <item>Do not implement materialization — that is RFC-0396.</item>
  <item>Do not implement amendment validation — that is RFC-0397.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0394: initial spec.validate handler with SPEC-01..07 rules.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { byteHash } from "../../src/utils/hash.ts";
import { collectFiles } from "../../src/utils/fs.ts";
import { loadForgeConfig } from "../../src/config/forge-config.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";
import {
  forgeSpecSchema,
  specIntegritySchema,
  specAmendmentSchema,
  type ForgeSpec,
  type SpecIntegrity,
  type SpecAmendment,
  type SpecViolation,
  type SpecValidateResult,
} from "./spec-schema.ts";

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

async function listSnapshotFiles(
  specDir: string,
  exclude: Set<string>,
): Promise<string[]> {
  const files = await collectFiles(specDir, {
    ignore: (name) => exclude.has(name),
  });
  return files.map((abs) => path.relative(specDir, abs).replace(/\\/g, "/"));
}

// ---------------------------------------------------------------------------
// SPEC-01: Integrity check
// ---------------------------------------------------------------------------

async function checkIntegrity(
  specDir: string,
  violations: SpecViolation[],
): Promise<void> {
  const integrityPath = path.join(specDir, "integrity.yaml");
  const integrity = await readYaml<SpecIntegrity>(integrityPath);
  if (!integrity) {
    violations.push({ rule: "SPEC-01", message: "integrity.yaml not found" });
    return;
  }

  const parsed = specIntegritySchema.safeParse(integrity);
  if (!parsed.success) {
    violations.push({
      rule: "SPEC-01",
      message: `integrity.yaml schema violation: ${parsed.error.message}`,
    });
    return;
  }

  const manifest = parsed.data;
  const exclude = new Set(["forge-spec.yaml", "integrity.yaml", "amendments"]);

  for (const [relPath, expectedHash] of Object.entries(manifest.files)) {
    const fullPath = path.join(specDir, relPath);
    try {
      const content = await fs.readFile(fullPath);
      const actualHash = byteHash(content);
      if (actualHash !== expectedHash) {
        violations.push({
          rule: "SPEC-01",
          message: `integrity mismatch: ${relPath}`,
        });
      }
    } catch {
      violations.push({
        rule: "SPEC-01",
        message: `file in manifest not found: ${relPath}`,
      });
    }
  }

  // Check for files in snapshot not in manifest
  const snapshotFiles = await listSnapshotFiles(specDir, exclude);
  for (const file of snapshotFiles) {
    if (!(file in manifest.files)) {
      violations.push({
        rule: "SPEC-01",
        message: `file not in integrity manifest: ${file}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// SPEC-02: Schema validation
// ---------------------------------------------------------------------------

function checkSchema(
  raw: unknown,
  violations: SpecViolation[],
): ForgeSpec | null {
  const parsed = forgeSpecSchema.safeParse(raw);
  if (!parsed.success) {
    violations.push({
      rule: "SPEC-02",
      message: `forge-spec.yaml schema violation: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    });
    return null;
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// SPEC-03: Dependency cycle detection
// ---------------------------------------------------------------------------

function checkCycles(spec: ForgeSpec, violations: SpecViolation[]): void {
  const nodes = new Map<string, string[]>();
  for (const node of spec.rfcs) {
    nodes.set(node.id, node.dependsOn);
  }

  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(id: string, path: string[]): boolean {
    if (stack.has(id)) {
      const cycle = [...path, id].join(" -> ");
      violations.push({
        rule: "SPEC-03",
        message: `dependency cycle: ${cycle}`,
      });
      return true;
    }
    if (visited.has(id)) return false;
    visited.add(id);
    stack.add(id);
    const deps = nodes.get(id) ?? [];
    for (const dep of deps) {
      if (dfs(dep, [...path, id])) return true;
    }
    stack.delete(id);
    return false;
  }

  for (const node of spec.rfcs) {
    if (!visited.has(node.id)) {
      dfs(node.id, []);
    }
  }
}

// ---------------------------------------------------------------------------
// SPEC-04: Unresolvable references
// ---------------------------------------------------------------------------

function checkReferences(spec: ForgeSpec, violations: SpecViolation[]): void {
  const nodeIds = new Set(spec.rfcs.map((n) => n.id));
  const docNames = new Set(Object.keys(spec.documents));

  for (const node of spec.rfcs) {
    for (const dep of node.dependsOn) {
      if (!nodeIds.has(dep)) {
        violations.push({
          rule: "SPEC-04",
          message: `dependsOn reference does not resolve: ${dep} (in node ${node.id})`,
        });
      }
    }
    for (const source of node.sources) {
      const docName = source.split("#")[0]!;
      if (!docNames.has(docName)) {
        violations.push({
          rule: "SPEC-04",
          message: `source reference does not resolve: ${source} (in node ${node.id})`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SPEC-05: Roadmap node without a wave
// ---------------------------------------------------------------------------

function checkWaveCoverage(spec: ForgeSpec, violations: SpecViolation[]): void {
  const waveIds = new Set(spec.waves.map((w) => w.id));
  for (const node of spec.rfcs) {
    if (!waveIds.has(node.wave)) {
      violations.push({
        rule: "SPEC-05",
        message: `node ${node.id} references wave ${node.wave} which does not exist`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// SPEC-06: Duplicate node or decision id
// ---------------------------------------------------------------------------

function checkDuplicates(spec: ForgeSpec, violations: SpecViolation[]): void {
  const nodeIds = new Set<string>();
  for (const node of spec.rfcs) {
    if (nodeIds.has(node.id)) {
      violations.push({
        rule: "SPEC-06",
        message: `duplicate node id: ${node.id}`,
      });
    }
    nodeIds.add(node.id);
  }

  const decisionIds = new Set<string>();
  for (const decision of spec.decisions) {
    if (decisionIds.has(decision.id)) {
      violations.push({
        rule: "SPEC-06",
        message: `duplicate decision id: ${decision.id}`,
      });
    }
    decisionIds.add(decision.id);
  }
}

// ---------------------------------------------------------------------------
// SPEC-07: materializedAs points to missing RFC file
// ---------------------------------------------------------------------------

async function checkMaterializedAs(
  spec: ForgeSpec,
  workspaceRoot: string,
  rfcDir: string,
  violations: SpecViolation[],
): Promise<void> {
  for (const node of spec.rfcs) {
    if (!node.materializedAs) continue;
    const rfcId = node.materializedAs;
    const rfcFiles = await fs.readdir(rfcDir).catch(() => []);
    const found = rfcFiles.some((f) => f.startsWith(rfcId.toLowerCase().replace(/^RFC-/, "rfc-")));
    if (!found) {
      violations.push({
        rule: "SPEC-07",
        message: `materializedAs ${rfcId} for node ${node.id} not found in ${rfcDir}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// SPEC-08..11: Amendment validation (RFC-0397)
// ---------------------------------------------------------------------------

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

function checkAmendments(
  spec: ForgeSpec,
  amendments: SpecAmendment[],
  violations: SpecViolation[],
): void {
  const nodeIds = new Set(spec.rfcs.map((n) => n.id));
  const decisionIds = new Set(spec.decisions.map((d) => d.id));
  const docNames = new Set(Object.keys(spec.documents));

  const seenIds = new Set<string>();

  for (const amendment of amendments) {
    // SPEC-08: schema/id violations
    if (seenIds.has(amendment.id)) {
      violations.push({
        rule: "SPEC-08",
        message: `duplicate amendment id: ${amendment.id}`,
      });
    }
    seenIds.add(amendment.id);

    // SPEC-09: unresolvable targets
    for (const target of amendment.targets) {
      if (target.kind === "section") {
        if (!docNames.has(target.document)) {
          violations.push({
            rule: "SPEC-09",
            message: `amendment ${amendment.id} targets document not found: ${target.document}`,
          });
        }
      } else if (target.kind === "decision") {
        if (!decisionIds.has(target.id)) {
          violations.push({
            rule: "SPEC-09",
            message: `amendment ${amendment.id} targets decision not found: ${target.id}`,
          });
        }
      } else if (target.kind === "node") {
        if (!nodeIds.has(target.id)) {
          violations.push({
            rule: "SPEC-09",
            message: `amendment ${amendment.id} targets node not found: ${target.id}`,
          });
        }
      }
    }

    // SPEC-11: accepted amendment without reviewers
    if (amendment.status === "accepted" && amendment.reviewers.length === 0) {
      violations.push({
        rule: "SPEC-11",
        message: `accepted amendment ${amendment.id} has no reviewers`,
      });
    }
  }

  // SPEC-10: two accepted amendments target the same anchor with conflicting Becomes
  const acceptedAmendments = amendments.filter((a) => a.status === "accepted");
  const targetCounts = new Map<string, number>();
  for (const amendment of acceptedAmendments) {
    for (const target of amendment.targets) {
      const key = target.kind === "section"
        ? `section:${target.document}:${target.anchor}`
        : target.kind === "decision"
          ? `decision:${target.id}`
          : `node:${target.id}`;
      targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of targetCounts) {
    if (count > 1) {
      violations.push({
        rule: "SPEC-10",
        message: `conflicting accepted amendments targeting ${key} — manual review required`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function runSpecValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SpecValidateResult>> {
  const { workspaceRoot, logger, outputFormat } = context;

  // Resolve specs directory from forge.yaml
  let specsDir = "docs/specs";
  try {
    const config = loadForgeConfig(workspaceRoot);
    specsDir = config.paths.specsDir;
  } catch {
    // Use default
  }

  const specsRoot = path.join(workspaceRoot, specsDir);
  const filterSpec = input.flags["spec"] as string | undefined;

  let specDirs = await listSpecDirs(specsRoot);
  if (filterSpec) {
    if (!specDirs.includes(filterSpec)) {
      return {
        data: {
          command: "spec.validate",
          status: "fail",
          specs: [],
        },
        exitCode: 1,
        summary: `spec.validate: spec '${filterSpec}' not found. Available: ${specDirs.join(", ") || "(none)"}`,
      };
    }
    specDirs = [filterSpec];
  }

  const rfcDir = path.join(workspaceRoot, "docs", "rfcs");
  const results: SpecValidateResult["specs"] = [];

  for (const specId of specDirs) {
    const specDir = path.join(specsRoot, specId);
    const violations: SpecViolation[] = [];

    // Load forge-spec.yaml
    const forgeSpecPath = path.join(specDir, "forge-spec.yaml");
    const rawSpec = await readYaml<unknown>(forgeSpecPath);
    if (!rawSpec) {
      results.push({
        id: specId,
        status: "unknown",
        violations: [{ rule: "SPEC-02", message: "forge-spec.yaml not found" }],
      });
      continue;
    }

    // SPEC-02: Schema
    const spec = checkSchema(rawSpec, violations);
    if (!spec) {
      results.push({ id: specId, status: "unknown", violations });
      continue;
    }

    // SPEC-01: Integrity
    await checkIntegrity(specDir, violations);

    // SPEC-03: Cycles
    checkCycles(spec, violations);

    // SPEC-04: References
    checkReferences(spec, violations);

    // SPEC-05: Wave coverage
    checkWaveCoverage(spec, violations);

    // SPEC-06: Duplicates
    checkDuplicates(spec, violations);

    // SPEC-07: materializedAs
    await checkMaterializedAs(spec, workspaceRoot, rfcDir, violations);

    // SPEC-08..11: Amendments (RFC-0397)
    const amendments = await loadAmendments(specDir);
    checkAmendments(spec, amendments, violations);

    results.push({
      id: spec.id,
      status: spec.status,
      violations,
    });
  }

  const hasFailures = results.some((r) => r.violations.length > 0);

  if (outputFormat === "pretty") {
    if (results.length === 0) {
      logger.info("No vendored specs found.");
    } else {
      for (const result of results) {
        if (result.violations.length === 0) {
          logger.success(`spec.validate: ${result.id} — pass`);
        } else {
          logger.error(`spec.validate: ${result.id} — ${result.violations.length} violation(s)`);
          for (const v of result.violations) {
            logger.error(`  ${v.rule}: ${v.message}`);
          }
        }
      }
    }
  }

  return {
    data: {
      command: "spec.validate",
      status: hasFailures ? "fail" : "pass",
      specs: results,
    },
    exitCode: hasFailures ? 1 : 0,
    summary: hasFailures
      ? `spec.validate: ${results.filter((r) => r.violations.length > 0).length} spec(s) with violations`
      : `spec.validate: all ${results.length} spec(s) pass`,
  };
}
