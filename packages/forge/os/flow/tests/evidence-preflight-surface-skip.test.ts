/*
<MODULE_CONTRACT>
<purpose>RFC-1644: the per-spawn evidence preflight skips the CX-r38-W1
worktree-surface capture exactly when `consultReadsWorktreeSurface(args)`
is false — the same predicate `resolveWorktreeArm` branches on — so the
skip can never weaken an arm: object-only argv arm `wtPlan: null` with or
without a surface, and a worktree-consulting argv armed against a skipped
preflight refuses (null). Default/cached preflights still capture.</purpose>
<non-goals>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
  <item>No CX-r38..r42 drift coverage — those suites live in os/correctness/gate/trust-boundary-cx3*.test.ts and stay unchanged.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { readdirSync, readFileSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeEvidenceIndex,
  consultReadsWorktreeSurface,
  evidenceRepoPreflight,
  resolveWorktreeArm,
  type EvidencePreflight,
} from "../../../src/utils/verifier-git.ts";
import { evidencePreflight, gitEvidence, preflightProbe } from "../git.ts";
import { gitExec, initRepo } from "./helpers.ts";

const dirs: string[] = [];
const held: Array<EvidencePreflight | null> = [];
afterEach(async () => {
  preflightProbe.current = null;
  for (const p of held.splice(0)) closeEvidenceIndex(p);
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fixture(): Promise<string> {
  const repo = await initRepo({ prefix: "rfc1644-" });
  dirs.push(repo);
  await writeFile(join(repo, ".gitignore"), "ignored/\n");
  await gitExec(repo, ["add", ".gitignore"]);
  await gitExec(repo, ["commit", "-m", "ignore"]);
  return repo;
}

/** Object-only argv: their worktree arm consumes no surface. */
const OBJECT_ONLY: string[][] = [
  ["log", "-1", "--format=%s", "HEAD"],
  ["log", "--format=%x1e%H%x00%s", "main"],
  ["rev-list", "main"],
  ["rev-parse", "--verify", "--quiet", "main"],
  ["show", "HEAD:seed.txt"],
  ["cat-file", "-t", "HEAD"],
  ["merge-base", "--is-ancestor", "HEAD", "main"],
  ["for-each-ref", "--format=%(refname)"],
  ["ls-tree", "HEAD"],
  ["config", "--local", "--list"],
];

/** Worktree-consulting argv: their arm consumes the surface. */
const WORKTREE: string[][] = [
  ["status", "--porcelain"],
  ["status", "--porcelain", "--untracked-files=no"],
  ["diff", "--quiet"],
  ["ls-files", "-o"],
  ["check-ignore", "-q", "ignored/x"],
];

/** Resolver-only worktree argv (`add` is not an evidence-channel query). */
const WORKTREE_ARM: string[][] = [...WORKTREE, ["add", "-n", "seed.txt"]];

async function preflightWith(repo: string, skip: boolean): Promise<EvidencePreflight> {
  const p = await evidencePreflight(
    repo,
    undefined,
    skip ? { worktreeSurface: "skip" } : undefined,
  );
  held.push(p);
  expect(p).not.toBeNull();
  return p!;
}

describe("RFC-1644 worktree-surface skip", () => {
  it("AC-1: an object-only judged consult skips the capture and still answers", async () => {
    const repo = await fixture();
    const seen: Array<EvidencePreflight | null> = [];
    preflightProbe.current = (p) => seen.push(p);
    const r = await gitEvidence(repo, ["log", "-1", "--format=%s", "HEAD"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("ignore");
    // The consult's own preflight (the internal enumeration reads run
    // with preflight:false and never reach evidencePreflight).
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) {
      expect(p?.worktreeSurfaceSkipped).toBe(true);
      expect(p?.worktreeSurface).toBeUndefined();
    }
  });

  it("AC-3: worktree-consulting judged consults still capture the surface", async () => {
    const repo = await fixture();
    for (const args of WORKTREE) {
      const seen: Array<EvidencePreflight | null> = [];
      preflightProbe.current = (p) => seen.push(p);
      const r = await gitEvidence(repo, args);
      expect(r.stderr, args.join(" ")).not.toContain("EVIDENCE-REFUSED");
      expect(seen.length, args.join(" ")).toBeGreaterThan(0);
      for (const p of seen) {
        expect(p?.worktreeSurfaceSkipped, args.join(" ")).toBeUndefined();
        expect(p?.worktreeSurface, args.join(" ")).toBeDefined();
      }
    }
  });

  it("AC-2: every object-only corpus argv classifies false and arms wtPlan: null without a surface", async () => {
    const repo = await fixture();
    const skipped = await preflightWith(repo, true);
    const captured = await preflightWith(repo, false);
    for (const args of OBJECT_ONLY) {
      expect(consultReadsWorktreeSurface(args), args.join(" ")).toBe(false);
      const onSkipped = resolveWorktreeArm(args, skipped, undefined);
      const onCaptured = resolveWorktreeArm(args, captured, undefined);
      expect(onSkipped, args.join(" ")).not.toBeNull();
      expect(onSkipped!.wtPlan, args.join(" ")).toBeNull();
      // Equivalence: the captured surface changes nothing for these argv.
      expect(onSkipped, args.join(" ")).toEqual(onCaptured);
    }
  });

  it("AC-4: a worktree-consulting argv armed against a skipped preflight refuses", async () => {
    const repo = await fixture();
    const skipped = await preflightWith(repo, true);
    const captured = await preflightWith(repo, false);
    for (const args of WORKTREE_ARM) {
      expect(consultReadsWorktreeSurface(args), args.join(" ")).toBe(true);
      expect(resolveWorktreeArm(args, skipped, undefined), args.join(" ")).toBeNull();
      const ok = resolveWorktreeArm(args, captured, undefined);
      expect(ok?.wtPlan, args.join(" ")).not.toBeNull();
    }
  });

  it("AC-5: both preflights capture the surface when called without options", async () => {
    const repo = await fixture();
    const a = await evidencePreflight(repo);
    const b = await evidenceRepoPreflight(repo);
    held.push(a, b);
    for (const p of [a, b]) {
      expect(p?.worktreeSurfaceSkipped).toBeUndefined();
      expect(p?.worktreeSurface?.dirs.size).toBeGreaterThan(0);
    }
    const c = await evidenceRepoPreflight(repo, undefined, { worktreeSurface: "skip" });
    held.push(c);
    expect(c?.worktreeSurfaceSkipped).toBe(true);
    expect(c?.worktreeSurface).toBeUndefined();
  });

  it("AC-8: worktreeArmPlan is the sole reader of worktreeSurface, from the pinned caller set", () => {
    const forgeRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
        const abs = join(d, name);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !abs.includes("/tests/")) {
          files.push(abs);
        }
      }
    };
    for (const top of ["src", "os", "bin"]) walk(join(forgeRoot, top));
    const readers: string[] = [];
    const callers: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "");
        if (/^\s*\*/.test(line)) return; // doc-comment line
        const where = `${relative(forgeRoot, f)}:${i + 1}`;
        // Reads: any `.worktreeSurface` access that is not the producer's assignment.
        // (`options?.worktreeSurface` is the RFC-1644 option, not the surface.)
        if (
          /(?<!options\?)\.worktreeSurface\b(?!Skipped)/.test(code) &&
          !/\.worktreeSurface\s*=[^=]/.test(code)
        ) {
          readers.push(`${where} ${code.trim()}`);
        }
        // Destructuring / bracket reads would dodge the property regex.
        if (
          /\{[^}]*\bworktreeSurface\b[^}]*\}\s*=|\[\s*["'`]worktreeSurface["'`]\s*\]/.test(code)
        ) {
          readers.push(`${where} ${code.trim()}`);
        }
        if (/\bworktreeArmPlan\(/.test(code) && !/function worktreeArmPlan\(/.test(code)) {
          callers.push(relative(forgeRoot, f));
        }
      });
    }
    expect(readers).toHaveLength(1);
    expect(readers[0]).toMatch(
      /src\/utils\/verifier-git\.ts:\d+ const baseline = preflight\.worktreeSurface;/,
    );
    // resolveWorktreeArm (2 calls, behind consultReadsWorktreeSurface), the
    // anchored `add` path and `unprovenIgnoredPaths` (both on cached
    // "capture" preflights). A new caller must be classified first.
    expect(callers.sort()).toEqual([
      "src/utils/verifier-git.ts",
      "src/utils/verifier-git.ts",
      "src/utils/verifier-git.ts",
      "src/utils/verifier-git.ts",
    ]);
  });
});
