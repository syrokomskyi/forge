/*
<MODULE_CONTRACT>
<purpose>
Input fingerprinting for the contract-evidence graph (Werkstatt RFC-1646) —
canonical serialization, per-input-kind digest computation against a frozen
evaluation context, and the command-output deny-list. Nodes never read live
mutable state: git-ref inputs resolve exclusively from the change unit's
frozen values.
</purpose>
<non-goals>
  <item>No scheduler logic — digests only; cone computation lives in the evaluator.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1646 (WP-3): initial fingerprinting machinery.</item>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import picomatch from "picomatch";

import type { ChangeUnit, InputDecl, InputFingerprint } from "./types.ts";

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Canonical JSON — sorted object keys recursively, the only legal digest substrate. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Commands banned as command-output inputs: time-dependent, random, or
 * network-dependent without sealed inputs. Registration refuses them
 * fail-closed (CG-REG-07). The list is deliberately conservative — a command
 * not on it is still only legal when declared deterministic.
 */
export const BANNED_COMMAND_INPUTS = new Set([
  "date",
  "curl",
  "wget",
  "ping",
  "ssh",
  "shuf",
  "uuidgen",
  "openssl",
  "nc",
  "dig",
  "nslookup",
  "npm",
  "pnpm",
  "yarn",
  "git",
]);

/** Resolution context — everything a digest computation may legally read. */
export interface FingerprintContext {
  /** Filesystem root of the frozen tree under evaluation. */
  treeRoot: string;
  changeUnit: ChangeUnit;
  /** Environment read — injectable for determinism in tests. */
  env: Record<string, string | undefined>;
  /** Deterministic command execution — injectable; returns stdout bytes. */
  execCommand: (command: string, args: string[], cwd: string) => string;
  /** Digests of dependency verdicts, keyed by node id — filled in topological order. */
  verdictDigests: Record<string, string>;
}

function walkFiles(root: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      walkFiles(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
}

function digestFileGlob(pattern: string, ctx: FingerprintContext): string {
  const all: string[] = [];
  walkFiles(ctx.treeRoot, all);
  const isMatch = picomatch(pattern, { dot: true });
  const matched = all
    .map((abs) => relative(ctx.treeRoot, abs).split(sep).join("/"))
    .filter((rel) => isMatch(rel))
    .sort();
  const entries = matched.map((rel) => {
    const content = readFileSync(join(ctx.treeRoot, rel));
    return { path: rel, digest: sha256Hex(content) };
  });
  return sha256Hex(canonicalJson({ kind: "file-glob", pattern, entries }));
}

function digestOne(input: InputDecl, ctx: FingerprintContext): string {
  switch (input.kind) {
    case "file-glob":
      return digestFileGlob(input.pattern, ctx);
    case "file-content": {
      const content = readFileSync(join(ctx.treeRoot, input.path));
      return sha256Hex(canonicalJson({ kind: "file-content", path: input.path, digest: sha256Hex(content) }));
    }
    case "git-ref": {
      // Snapshot isolation: the frozen unit value is the only legal source.
      const frozen = ctx.changeUnit.frozenRefs[input.ref];
      if (frozen === undefined) {
        throw new Error(`git-ref input '${input.ref}' has no frozen value in change unit ${ctx.changeUnit.id}`);
      }
      return sha256Hex(canonicalJson({ kind: "git-ref", ref: input.ref, value: frozen }));
    }
    case "node-verdict": {
      const digest = ctx.verdictDigests[input.nodeId];
      if (digest === undefined) {
        throw new Error(`node-verdict input '${input.nodeId}' has no verdict digest — topological order broken`);
      }
      return sha256Hex(canonicalJson({ kind: "node-verdict", nodeId: input.nodeId, verdictDigest: digest }));
    }
    case "command-output": {
      if (BANNED_COMMAND_INPUTS.has(input.command)) {
        throw new Error(`banned command-output input '${input.command}' reached fingerprinting — registration is fail-closed, this is a bug`);
      }
      const out = ctx.execCommand(input.command, input.args, ctx.treeRoot);
      return sha256Hex(canonicalJson({ kind: "command-output", command: input.command, args: input.args, digest: sha256Hex(out) }));
    }
    case "environment": {
      const values = input.keys.map((k) => ({ key: k, value: ctx.env[k] ?? null }));
      return sha256Hex(canonicalJson({ kind: "environment", values }));
    }
  }
}

/**
 * Compute the input fingerprint of a node. Throws on unreadable files or
 * unresolvable inputs — the caller treats this as a scheduling-time blocking
 * error, never a cache-miss.
 */
export function computeInputFingerprint(
  nodeId: string,
  inputs: InputDecl[],
  ctx: FingerprintContext,
): InputFingerprint {
  const perInput: Record<string, string> = {};
  inputs.forEach((input, i) => {
    perInput[String(i)] = digestOne(input, ctx);
  });
  const digest = sha256Hex(canonicalJson({ nodeId, inputs: perInput }));
  return {
    nodeId,
    digest,
    inputs: perInput,
    computedAt: new Date().toISOString(),
  };
}

/** sha256(nodeId + inputDigest + executorVersion) — the evidence key, verbatim per RFC. */
export function evidenceKey(nodeId: string, inputDigest: string, executorVersion: string): string {
  return sha256Hex(`${nodeId}${inputDigest}${executorVersion}`);
}

/** Digest of a verdict serialization — the substrate of node-verdict edges. */
export function verdictDigest(verdict: unknown): string {
  return sha256Hex(canonicalJson(verdict));
}
