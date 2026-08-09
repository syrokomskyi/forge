/*
<MODULE_CONTRACT>
<purpose>Workflow lint/list/amend handlers for forge — validates .agents/workflows frontmatter, command references, and per-chain phase links.</purpose>
<non-goals>
  <item>Do not execute workflow steps.</item>
  <item>Do not edit workflow files to repair violations.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0075: Add agent workflow lint/list handlers.</item>
  <item>RFC-0374: Migrated from packages/os/site-kernel/src/workflow/ to packages/forge/os/workflow/.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";
import {
  WORKFLOW_PHASES,
  WORKFLOW_CHAINS,
  type WorkflowChain,
  type WorkflowFrontmatter,
  type WorkflowLintResult,
  type WorkflowLintViolation,
  type WorkflowListEntry,
} from "./types.ts";

const WORKFLOW_DIR = ".agents/workflows";
const WORKFLOW_AMEND_DIR = ".agents/workflows-amend";

// RFC-0135/RFC-0136 commands (registered in site-kernel-onboarding / site-kernel-checks).
const _PENDING_AMEND_RFC_COMMANDS = new Set([
  "amend.input.validate",
  "amend.atoms.merge",
  "amend.provenance.append",
  "amend.provenance.validate",
  "amend.phase.validate",
  "content.coverage.delta",
  "audit.delta.run",
  "amend-check.author",
  "amend-check.postbuild",
  "amend-check.run",
  "workflow-amend.list",
]);
const PENDING_ACCEPTED_RFC_COMMANDS = new Set([
  "brief.validate",
  "biome.tokens.derive",
  "family.contract.validate",
  "family.list",
  "archetype.registry.validate",
  "cosmic.name.pick",
  "section.scaffold",
  "section.contract.validate",
  "section.similarity.report",
  "system-md.compile",
  "constellation.contract.validate",
  "content.coverage.validate",
  "content.voice.lint",
  "pbp.content.validate",
  "content.references.validate",
  "audit.agent.readiness.validate",
  "seo.technical.validate",
  "seo.structured-data.validate",
  "seo.internal-linking.validate",
  "analytics.config.validate",
  "first-party-data.validate",
  "infra.brief.validate",
  "audit.llm.run",
  "app.qa.validate",
  "kernel.wire",
  "onboarding.scaffold",
  "onboarding.input.validate",
  "onboarding.phase.validate",
  "biome.contract.validate",
  "biome.css.generate",
]);

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readWorkflowFiles(workspaceRoot: string, dir: string) {
  const directory = path.join(workspaceRoot, dir);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function parseMarkdownFrontmatter(source: string): unknown {
  if (!source.startsWith("---\n")) return undefined;
  const end = source.indexOf("\n---", 4);
  if (end === -1) return undefined;
  return YAML.parse(source.slice(4, end));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPlannedWorkflowArtifact(root: string, writes: string[]): boolean {
  return root.startsWith("onboarding/.output/") || writes.includes(root);
}

function validateFrontmatter(file: string, value: unknown): WorkflowFrontmatter {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file}: missing or invalid workflow frontmatter`);
  }
  const candidate = value as WorkflowFrontmatter;
  const valid =
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    WORKFLOW_PHASES.includes(candidate.phase) &&
    (candidate.chain === undefined || WORKFLOW_CHAINS.includes(candidate.chain)) &&
    isStringArray(candidate.reads) &&
    isStringArray(candidate.writes) &&
    Boolean(candidate.scope) &&
    isStringArray(candidate.scope.allowedWriteRoots) &&
    isStringArray(candidate.scope.forbiddenWriteRoots) &&
    isStringArray(candidate.runs) &&
    Array.isArray(candidate.recoveryRules) &&
    candidate.recoveryRules.every(
      (rule) => typeof rule?.on === "string" && typeof rule?.do === "string",
    ) &&
    isStringArray(candidate.agentInvariants) &&
    Boolean(candidate.selfOrchestration) &&
    typeof candidate.selfOrchestration.autoRun === "boolean" &&
    isStringArray(candidate.selfOrchestration.pauseFor) &&
    isStringArray(candidate.checkpoints) &&
    (candidate.nextWorkflow === undefined || typeof candidate.nextWorkflow === "string") &&
    (candidate.branch === undefined ||
      (typeof candidate.branch.on === "string" && isStringArray(candidate.branch.cases)));

  if (!valid) throw new Error(`${file}: invalid workflow frontmatter shape`);
  return candidate;
}

/** Load one chain's workflow files. The chain a file belongs to is fixed by its directory. */
async function loadWorkflows(workspaceRoot: string, chain: WorkflowChain = "greenfield") {
  const dir = chain === "amend" ? WORKFLOW_AMEND_DIR : WORKFLOW_DIR;
  const files = await readWorkflowFiles(workspaceRoot, dir);
  const workflows: Array<{
    relativeFile: string;
    chain: WorkflowChain;
    data: WorkflowFrontmatter;
  }> = [];
  const violations: WorkflowLintViolation[] = [];

  for (const file of files) {
    const relativeFile = path.relative(workspaceRoot, file).replace(/\\/g, "/");
    try {
      const source = await fs.readFile(file, "utf8");
      workflows.push({
        relativeFile,
        chain,
        data: validateFrontmatter(relativeFile, parseMarkdownFrontmatter(source)),
      });
    } catch (error) {
      violations.push({
        file: relativeFile,
        code: "WF002",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { workflows, violations };
}

function toListEntries(
  workflows: Array<{ relativeFile: string; data: WorkflowFrontmatter }>,
): WorkflowListEntry[] {
  return workflows.map(({ relativeFile, data }) => ({
    id: data.id,
    title: data.title,
    phase: data.phase,
    file: relativeFile,
    reads: data.reads,
    writes: data.writes,
    runs: data.runs,
    nextWorkflow: data.nextWorkflow,
  }));
}

export async function runWorkflowList(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<{ command: "workflow.list"; workflows: WorkflowListEntry[] }>> {
  const { workflows } = await loadWorkflows(context.workspaceRoot, "greenfield");
  const entries = toListEntries(workflows);
  return {
    data: { command: "workflow.list", workflows: entries },
    exitCode: 0,
    summary: `workflow.list: ${entries.length} workflow file(s) found`,
  };
}

export async function runWorkflowAmendList(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<{ command: "workflow-amend.list"; workflows: WorkflowListEntry[] }>> {
  const { workflows } = await loadWorkflows(context.workspaceRoot, "amend");
  const entries = toListEntries(workflows);
  return {
    data: { command: "workflow-amend.list", workflows: entries },
    exitCode: 0,
    summary: `workflow-amend.list: ${entries.length} amend workflow file(s) found`,
  };
}

export async function runWorkflowLint(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<WorkflowLintResult>> {
  const workflowDirectory = path.join(context.workspaceRoot, WORKFLOW_DIR);
  const { workflows, violations } = await loadWorkflows(context.workspaceRoot);
  const commandNames = new Set(context.commandRegistry?.listCommandNames() ?? []);
  for (const commandName of [
    "sites-check.run",
    "sites-check.author",
    "sites-check.postbuild",
    "packages-check.run",
    "app.contract.full",
    "workflow.lint",
    "workflow.list",
  ]) {
    commandNames.add(commandName);
  }
  for (const commandName of PENDING_ACCEPTED_RFC_COMMANDS) commandNames.add(commandName);

  const workflowIds = new Set(workflows.map(({ data }) => data.id));

  for (const { relativeFile, data } of workflows) {
    for (const runEntry of data.runs) {
      // RFC-0075: runs entries may carry inline flags (e.g. "onboarding.phase.validate --phase=03-compose").
      // The kernel registry stores bare command names; strip flag tokens before lookup.
      const commandName = runEntry.split(/\s+/, 1)[0] ?? runEntry;
      if (!commandNames.has(commandName)) {
        violations.push({
          file: relativeFile,
          code: "WF003",
          message: `Unknown kernel command in runs: ${commandName}`,
        });
      }
    }

    if (!data.scope.forbiddenWriteRoots.includes("onboarding/.input/")) {
      violations.push({
        file: relativeFile,
        code: "WF004",
        message: "scope.forbiddenWriteRoots must include onboarding/.input/.",
      });
    }

    if (data.nextWorkflow && !workflowIds.has(data.nextWorkflow)) {
      violations.push({
        file: relativeFile,
        code: "WF005",
        message: `nextWorkflow references missing workflow id: ${data.nextWorkflow}`,
      });
    }

    for (const root of [...data.reads, ...data.writes, ...data.scope.allowedWriteRoots]) {
      if (
        !root.includes("<") &&
        !root.includes("*") &&
        !root.endsWith("/") &&
        !isPlannedWorkflowArtifact(root, data.writes) &&
        !(await pathExists(path.join(context.workspaceRoot, root)))
      ) {
        violations.push({
          file: relativeFile,
          code: "WF007",
          message: `Path does not exist and is not a pattern: ${root}`,
        });
      }
    }
  }

  return {
    data: {
      command: "workflow.lint",
      workflowDirectory,
      filesChecked: workflows.length,
      violations,
    },
    exitCode: violations.length > 0 ? 1 : 0,
    summary:
      violations.length > 0
        ? `workflow.lint: ${violations.length} violation(s)`
        : `workflow.lint: ${workflows.length} workflow file(s) valid`,
  };
}
