/*
<MODULE_CONTRACT>
<purpose>Discovery and parsing for program manifests and packet files.
Reads YAML frontmatter from program.yaml and packet .md files, validates
against schemas, and computes normative source hashes.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — forge must remain dependency-free.</item>
  <item>Do not mutate files — discovery is read-only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0856: initial program/packet discovery and parsing.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import {
  programManifestSchema,
  programPacketSchema,
  type ProgramManifest,
  type ProgramPacket,
  type ProgramPacketIndexEntry,
} from "./schemas.ts";

// ---------------------------------------------------------------------------
// Program discovery
// ---------------------------------------------------------------------------

export interface ProgramLocation {
  programDir: string;
  manifestPath: string;
  manifest: ProgramManifest;
}

/**
 * Discover a program by RFC id. Scans docs/plans/ for a program.yaml whose
 * `program` field matches the given RFC id.
 */
export function discoverProgram(workspaceRoot: string, programRfc: string): ProgramLocation | null {
  const plansDir = path.join(workspaceRoot, "docs", "plans");
  if (!fs.existsSync(plansDir)) return null;

  for (const entry of fs.readdirSync(plansDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(plansDir, entry.name, "program.yaml");
    if (!fs.existsSync(manifestPath)) continue;

    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    if (parsed.program !== programRfc) continue;

    const result = programManifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `PROGRAM-PACKET-01: malformed program manifest at ${manifestPath}: ${result.error.message}`,
      );
    }

    return {
      programDir: path.join(plansDir, entry.name),
      manifestPath,
      manifest: result.data,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Packet parsing
// ---------------------------------------------------------------------------

/**
 * Parse a packet .md file: extract YAML frontmatter and validate against
 * the forge/program-packet@1 schema.
 */
export function parsePacketFile(packetPath: string): ProgramPacket {
  const raw = fs.readFileSync(packetPath, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error(`PROGRAM-PACKET-01: missing frontmatter in ${packetPath}`);
  }

  const fm = parseYaml(match[1]) as Record<string, unknown>;
  const result = programPacketSchema.safeParse(fm);
  if (!result.success) {
    throw new Error(
      `PROGRAM-PACKET-01: malformed packet at ${packetPath}: ${result.error.message}`,
    );
  }

  return result.data;
}

/**
 * Find a packet by packetId within a program.
 */
export function findPacketEntry(
  manifest: ProgramManifest,
  packetId: string,
): ProgramPacketIndexEntry | null {
  return manifest.packets.find((p) => p.packetId === packetId) ?? null;
}

/**
 * Resolve the full path to a packet file.
 */
export function resolvePacketPath(programDir: string, entry: ProgramPacketIndexEntry): string {
  return path.join(programDir, entry.file);
}

// ---------------------------------------------------------------------------
// Normative source hashing
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hex digest of a file's bytes.
 */
export function fileSha256(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verify normative source hashes for a packet. Returns violations.
 */
export function verifyNormativeSources(
  workspaceRoot: string,
  packet: ProgramPacket,
): Array<{ path: string; expected: string; actual: string }> {
  const violations: Array<{ path: string; expected: string; actual: string }> = [];

  for (const source of packet.normativeSources) {
    const fullPath = path.join(workspaceRoot, source.path);
    if (!fs.existsSync(fullPath)) {
      violations.push({
        path: source.path,
        expected: source.sha256,
        actual: "<missing>",
      });
      continue;
    }
    const actual = fileSha256(fullPath);
    if (actual !== source.sha256) {
      violations.push({
        path: source.path,
        expected: source.sha256,
        actual,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Git helpers (read-only)
// ---------------------------------------------------------------------------

export function gitHead(workspaceRoot: string): string {
  return execSync("git rev-parse HEAD", {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function gitBranch(workspaceRoot: string): string {
  return execSync("git branch --show-current", {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function gitIsClean(workspaceRoot: string): boolean {
  const status = execSync("git status --porcelain", {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  return status.length === 0;
}

export function gitAncestorOf(
  workspaceRoot: string,
  ancestor: string,
  descendant: string,
): boolean {
  try {
    const result = execSync(`git merge-base --is-ancestor ${ancestor} ${descendant}`, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function gitChangedFilesBetween(
  workspaceRoot: string,
  base: string,
  head: string,
): string[] {
  try {
    const output = execSync(`git diff --name-only ${base}..${head}`, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return output.length === 0 ? [] : output.split("\n");
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Path matching (cross-platform)
// ---------------------------------------------------------------------------

/**
 * Normalize a path to forward slashes for cross-platform comparison.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Resolve ".." and "." segments in a path without touching the filesystem.
 * Returns the lexical normalization (e.g. "a/b/../c" → "a/c").
 */
function resolveLexical(p: string): string {
  const segments = p.split("/");
  const result: string[] = [];
  for (const seg of segments) {
    if (seg === "..") {
      result.pop();
    } else if (seg !== "." && seg !== "") {
      result.push(seg);
    }
  }
  return result.join("/");
}

/**
 * Check if a path matches a glob pattern. Supports:
 * - `**` for recursive directory matching
 * - `*` for single-level wildcard
 * - exact prefix matching with trailing `/**`
 */
export function pathMatchesGlob(filePath: string, pattern: string): boolean {
  const normalized = resolveLexical(normalizePath(filePath));
  const glob = resolveLexical(normalizePath(pattern));

  // Exact match
  if (normalized === glob) return true;

  // /** suffix — prefix match
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return normalized === prefix || normalized.startsWith(prefix + "/");
  }

  // * wildcard matching (simplified)
  const regexStr = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*");
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(normalized);
}

/**
 * Check if a file path is within the allowed files list.
 */
export function isPathAllowed(filePath: string, allowedFiles: string[]): boolean {
  const normalized = resolveLexical(normalizePath(filePath));
  return allowedFiles.some((pattern) => pathMatchesGlob(normalized, pattern));
}

/**
 * Check if a file path matches any forbidden pattern.
 */
export function isPathForbidden(filePath: string, forbiddenFiles: string[]): boolean {
  const normalized = resolveLexical(normalizePath(filePath));
  return forbiddenFiles.some((pattern) => pathMatchesGlob(normalized, pattern));
}
