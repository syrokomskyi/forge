/*
<MODULE_CONTRACT>
<purpose>Memory layer scaffold and health check (RFC-0664). Creates .agents/memory/MEMORY.md, .agents/memory/daily/.gitkeep, and a marker-delimited .gitignore block. Reports health for forge.doctor.</purpose>
<non-goals>
  <item>Do not overwrite existing MEMORY.md or daily/ files — idempotent only.</item>
  <item>Do not enforce the read discipline — that is advisory, via AGENTS.md rules.</item>
  <item>Do not change doctor's exit code — memory-layer warnings are advisory only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0664: initial memory layer scaffold and health check.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { loadForgeConfig } from "../config/forge-config.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MEMORY_GITIGNORE_START = "# forge-agent-memory";
export const MEMORY_GITIGNORE_END = "# /forge-agent-memory";

export const DEFAULT_MEMORY_BUDGET = 4096;

const MEMORY_DIR = ".agents/memory";
const DAILY_DIR = "daily";
const MEMORY_MD = "MEMORY.md";
const GITKEEP = ".gitkeep";

const MEMORY_MD_TEMPLATE = `# Project Memory

Curated project context (RFC-0664). This file is versioned — daily logs in \`daily/\` are git-ignored.

## Current focus

<!-- What is being worked on right now. One to three bullets max. -->

## Decisions in flight

<!-- Decisions under discussion but not yet final. -->

## Environment notes

<!-- Tool versions, environment quirks, known issues. -->
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryScaffoldResult {
  created: string[];
  gitignoreUpdated: boolean;
  skipped: string[];
}

export interface MemoryLayerHealth {
  memoryMdChars: number;
  budget: number;
  gitignoreCoversDaily: boolean;
  dailyFileCount: number;
  memoryMdExists: boolean;
}

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

function hasGitignoreBlock(content: string): boolean {
  return content.includes(MEMORY_GITIGNORE_START) && content.includes(MEMORY_GITIGNORE_END);
}

function insertGitignoreBlock(existingContent: string): string {
  const block = `${MEMORY_GITIGNORE_START}\n${MEMORY_DIR}/${DAILY_DIR}/\n${MEMORY_GITIGNORE_END}`;

  if (existingContent.length === 0) {
    return block + "\n";
  }

  // Ensure existing content ends with a newline before appending
  const trimmed = existingContent.endsWith("\n") ? existingContent : existingContent + "\n";
  return trimmed + "\n" + block + "\n";
}

export function scaffoldMemoryLayer(workspaceRoot: string): MemoryScaffoldResult {
  const created: string[] = [];
  const skipped: string[] = [];
  let gitignoreUpdated = false;

  const memoryDir = path.join(workspaceRoot, MEMORY_DIR);
  const dailyDirPath = path.join(memoryDir, DAILY_DIR);
  const memoryMdPath = path.join(memoryDir, MEMORY_MD);
  const gitkeepPath = path.join(dailyDirPath, GITKEEP);

  // Create .agents/memory/ directory
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(dailyDirPath, { recursive: true });

  // MEMORY.md — create only if absent
  if (fs.existsSync(memoryMdPath)) {
    skipped.push(MEMORY_MD);
  } else {
    fs.writeFileSync(memoryMdPath, MEMORY_MD_TEMPLATE, "utf8");
    created.push(`${MEMORY_DIR}/${MEMORY_MD}`);
  }

  // daily/.gitkeep — create only if absent
  if (fs.existsSync(gitkeepPath)) {
    skipped.push(`${DAILY_DIR}/${GITKEEP}`);
  } else {
    fs.writeFileSync(gitkeepPath, "", "utf8");
    created.push(`${MEMORY_DIR}/${DAILY_DIR}/${GITKEEP}`);
  }

  // .gitignore — add marker block if absent
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const existing = fs.readFileSync(gitignorePath, "utf8");
    if (hasGitignoreBlock(existing)) {
      // Block already present — no update needed
    } else {
      const updated = insertGitignoreBlock(existing);
      fs.writeFileSync(gitignorePath, updated, "utf8");
      gitignoreUpdated = true;
    }
  } else {
    fs.writeFileSync(gitignorePath, `${MEMORY_GITIGNORE_START}\n${MEMORY_DIR}/${DAILY_DIR}/\n${MEMORY_GITIGNORE_END}\n`, "utf8");
    gitignoreUpdated = true;
  }

  return { created, gitignoreUpdated, skipped };
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

function resolveMemoryBudget(workspaceRoot: string): number {
  try {
    const config = loadForgeConfig(workspaceRoot);
    if (config.bindings?.memory?.budget !== undefined && config.bindings?.memory?.budget !== null) {
      return config.bindings.memory.budget;
    }
  } catch {
    // forge.yaml not loadable — use default
  }
  return DEFAULT_MEMORY_BUDGET;
}

export function checkMemoryLayerHealth(workspaceRoot: string): MemoryLayerHealth {
  const memoryDir = path.join(workspaceRoot, MEMORY_DIR);
  const dailyDirPath = path.join(memoryDir, DAILY_DIR);
  const memoryMdPath = path.join(memoryDir, MEMORY_MD);
  const gitignorePath = path.join(workspaceRoot, ".gitignore");

  // MEMORY.md char count
  let memoryMdChars = 0;
  const memoryMdExists = fs.existsSync(memoryMdPath);
  if (memoryMdExists) {
    memoryMdChars = fs.readFileSync(memoryMdPath, "utf8").length;
  }

  // Daily file count (exclude .gitkeep)
  let dailyFileCount = 0;
  if (fs.existsSync(dailyDirPath)) {
    const entries = fs.readdirSync(dailyDirPath);
    dailyFileCount = entries.filter((e) => e !== GITKEEP).length;
  }

  // Gitignore coverage
  let gitignoreCoversDaily = false;
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf8");
    gitignoreCoversDaily = hasGitignoreBlock(content);
  }

  const budget = resolveMemoryBudget(workspaceRoot);

  return {
    memoryMdChars,
    budget,
    gitignoreCoversDaily,
    dailyFileCount,
    memoryMdExists,
  };
}
