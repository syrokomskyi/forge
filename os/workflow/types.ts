/*
<MODULE_CONTRACT>
<purpose>Defines the RFC-0075 workflow frontmatter contract and command result types.</purpose>
<non-goals>
  <item>Do not execute workflows or mutate onboarding artifacts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0075: Add workflow command type contracts.</item>
</CHANGE_SUMMARY>
*/

export const WORKFLOW_PHASES = [
  "prepare",
  "synthesize",
  "scaffold",
  "compose",
  "author",
  "audit",
  "handoff",
] as const;

export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export interface WorkflowScope {
  allowedWriteRoots: string[];
  forbiddenWriteRoots: string[];
}

export interface WorkflowRecoveryRule {
  on: string;
  do: string;
}

export interface WorkflowSelfOrchestration {
  autoRun: boolean;
  pauseFor: string[];
}

export interface WorkflowFrontmatter {
  id: string;
  title: string;
  phase: WorkflowPhase;
  reads: string[];
  writes: string[];
  scope: WorkflowScope;
  runs: string[];
  recoveryRules: WorkflowRecoveryRule[];
  agentInvariants: string[];
  selfOrchestration: WorkflowSelfOrchestration;
  checkpoints: string[];
  nextWorkflow?: string;
}

export interface WorkflowListEntry {
  id: string;
  title: string;
  phase: WorkflowPhase;
  file: string;
  reads: string[];
  writes: string[];
  runs: string[];
  nextWorkflow?: string;
}

export interface WorkflowLintViolation {
  file: string;
  code: string;
  message: string;
}

export interface WorkflowLintResult {
  command: "workflow.lint";
  workflowDirectory: string;
  filesChecked: number;
  violations: WorkflowLintViolation[];
}
