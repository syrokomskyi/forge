/*
<MODULE_CONTRACT>
<purpose>forge policy.digest — the attestation artifact for the declared policy
surface (RFC-1616). Computes a canonical sha256 over the policy:-judged surface
(every forge.yaml top-level key except mutable, the policy: section itself,
freezeFiles matches, .forge/pinned.yaml, hooks/, .github/workflows/) and
verifies it against the committed forge/policy-bundle@1 file at
.forge/policy.digest. --verify --base additionally requires a commit in
base..HEAD carrying X-Policy-Digest: <current sha256> whenever the surface
advanced.</purpose>
<non-goals>
  <item>Does not judge weakening semantics — correctness.gate owns the diff vocabulary.</item>
  <item>Does not write forge.yaml — the digest is a read+verify artifact except --write of .forge/policy.digest.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>mutable keys are excluded — a free change must not churn the attestation file; additive keys are included whole because any leaf change (add or edit) is policy-relevant.</item>
  <item>attestedBy defaults to operator:<user> — the flag --attested-by overrides; the file ownership (CODEOWNERS) is the anchor, the field is informational.</item>
  <item>absent policy: section → exit 1 "no policy surface declared" — the digest anchors the declared surface, nothing declared means nothing to attest.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1616: initial policy.digest — print/--write/--verify/--verify --base surface attestation.</item>
  <item>RFC-1616: external verification trust boundary

policy.digest (canonical SHA-256 over the frozen surface), adversarial.run
with a 12-scenario catalog replayed through the real gate in a scratch
clone, flow.push verifier-trailer hard stop (fail-closed on unreadable
forge.yaml), project.owner + push.requireVerifierReview config, trust-boundary
scaffold (CODEOWNERS + forge-policy workflow) and reference docs.</item>
  <item>RFC-1616: close verifier r1 counterexamples for the RFC-1616 trust boundary</item>
</CHANGE_SUMMARY>
*/

import { existsSync, lstatSync } from "node:fs";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import picomatch from "picomatch";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import {
  POLICY_DIGEST_PATH,
  canonicalPolicyDigest,
  coversOf,
  policyBundleSchema,
  type PolicySurface,
} from "../../../src/correctness/policy-bundle.ts";

const execFileAsync = promisify(execFile);

interface PolicyDecl {
  mutable: string[];
  additive: string[];
  freezeFiles: string[];
}

function parsePolicyDecl(doc: unknown): PolicyDecl | null {
  if (!doc || typeof doc !== "object") return null;
  const p = (doc as Record<string, unknown>)["policy"];
  if (!p || typeof p !== "object") return null;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    mutable: list((p as Record<string, unknown>)["mutable"]),
    additive: list((p as Record<string, unknown>)["additive"]),
    freezeFiles: list((p as Record<string, unknown>)["freezeFiles"]),
  };
}

/**
 * Top-level keys the digest always attests even when a declaration marks them
 * mutable — `policy` governs the freeze itself (a `mutable:["policy"]` grant
 * must not self-exclude the meta-policy from attestation, CX-11) and `push`
 * binds the external review switch.
 */
const ALWAYS_JUDGED = new Set(["policy", "push"]);

/**
 * forge.yaml reduced to the policy-judged surface: every key except mutable —
 * except ALWAYS_JUDGED keys and `project.owner`, which stays digested even
 * under the default `mutable:["project"]` grant so an owner rebind always
 * advances the attestation (CX-32).
 */
function judgedDoc(doc: Record<string, unknown>, policy: PolicyDecl): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(doc)) {
    if (ALWAYS_JUDGED.has(k) || !policy.mutable.includes(k)) out[k] = doc[k];
  }
  const project = doc["project"];
  if (
    policy.mutable.includes("project") &&
    project &&
    typeof project === "object" &&
    "owner" in (project as Record<string, unknown>)
  ) {
    out["project"] = { owner: (project as Record<string, unknown>)["owner"] };
  }
  return out;
}

async function listFilesRecursive(root: string, rel: string): Promise<string[]> {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() || e.isSymbolicLink())
        out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  const st = await readdir(abs, { withFileTypes: true }).catch(() => null);
  if (st === null) {
    if (existsSync(abs)) out.push(rel);
    return out;
  }
  await walk(abs);
  return out;
}

const FIXED_DIRS = [".forge/pinned.yaml", "hooks", ".github/workflows", ".github/CODEOWNERS"];

/** git-style mode for a worktree file: symlink 120000, executable 100755, else 100644. */
function fileMode(abs: string): string {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return "120000";
    return st.mode & 0o111 ? "100755" : "100644";
  } catch {
    return "";
  }
}

async function gatherWorktreeSurface(
  root: string,
  doc: Record<string, unknown>,
  policy: PolicyDecl,
): Promise<PolicySurface> {
  const relSet = new Set<string>();
  for (const fixed of FIXED_DIRS) {
    for (const f of await listFilesRecursive(root, fixed)) relSet.add(f);
  }
  const matchers = policy.freezeFiles.map((g) => picomatch(g, { dot: true }));
  if (matchers.length > 0) {
    const all = await listFilesRecursive(root, ".");
    for (const f of all) {
      if (f.startsWith(".git/") || f.startsWith("node_modules/")) continue;
      if (matchers.some((m) => m(f))) relSet.add(f);
    }
  }
  const files = [];
  for (const rel of [...relSet].sort()) {
    try {
      const abs = path.join(root, rel);
      files.push({ path: rel, content: await readFile(abs, "utf8"), mode: fileMode(abs) });
    } catch {
      /* unreadable file contributes absence — git-side diffing catches it */
    }
  }
  return { forgeDoc: judgedDoc(doc, policy), files };
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

async function gatherBaseSurface(
  root: string,
  base: string,
): Promise<{ surface: PolicySurface; policy: PolicyDecl } | null> {
  const raw = await git(root, ["show", `${base}:forge.yaml`]);
  if (raw === null) return null;
  const doc = parseYaml(raw) as Record<string, unknown>;
  const policy = parsePolicyDecl(doc);
  if (!policy) return null;
  const tree = (await git(root, ["ls-tree", "-r", base])) ?? "";
  const entries = tree
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d+) \S+ [0-9a-f]+\t(.+)$/.exec(line);
      return m ? { mode: m[1]!, name: m[2]! } : null;
    })
    .filter((e): e is { mode: string; name: string } => e !== null);
  const relSet = new Set<string>();
  for (const e of entries) {
    if (
      e.name === ".forge/pinned.yaml" ||
      e.name === ".github/CODEOWNERS" ||
      e.name.startsWith("hooks/") ||
      e.name.startsWith(".github/workflows/")
    )
      relSet.add(e.name);
  }
  const matchers = policy.freezeFiles.map((g) => picomatch(g, { dot: true }));
  for (const e of entries) if (matchers.some((m) => m(e.name))) relSet.add(e.name);
  const modeOf = new Map(entries.map((e) => [e.name, e.mode]));
  const files = [];
  for (const rel of [...relSet].sort()) {
    const content = await git(root, ["show", `${base}:${rel}`]);
    if (content !== null) files.push({ path: rel, content, mode: modeOf.get(rel) ?? "" });
  }
  return { surface: { forgeDoc: judgedDoc(doc, policy), files }, policy };
}

export interface PolicyDigestResult {
  command: "policy.digest";
  status: "pass" | "fail";
  sha256?: string;
  covers?: string[];
  violations: string[];
  wrote?: string;
}

export async function runPolicyDigest(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<PolicyDigestResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const json = input.flags["json"] === true || outputFormat === "json";
  const write = input.flags["write"] === true;
  const verify = input.flags["verify"] === true;
  const base = typeof input.flags["base"] === "string" ? (input.flags["base"] as string) : null;
  const attestedBy =
    (input.flags["attested-by"] as string | undefined) ??
    `operator:${process.env["USER"] ?? process.env["USERNAME"] ?? "unknown"}`;

  const violations: string[] = [];
  const fail = (summary: string, extra: Partial<PolicyDigestResult> = {}) => ({
    data: { command: "policy.digest" as const, status: "fail" as const, violations, ...extra },
    exitCode: 1,
    summary,
  });

  const forgeYamlPath = path.join(workspaceRoot, "forge.yaml");
  if (!existsSync(forgeYamlPath)) return fail("no forge.yaml — nothing to attest");
  const doc = parseYaml(await readFile(forgeYamlPath, "utf8")) as Record<string, unknown>;
  const policy = parsePolicyDecl(doc);
  if (!policy) return fail("no policy surface declared — policy: section absent or malformed");

  const surface = await gatherWorktreeSurface(workspaceRoot, doc, policy);
  const sha256 = canonicalPolicyDigest(surface);
  const covers = coversOf(surface);

  if (!write && !verify) {
    if (!json) logger.info(sha256);
    return {
      data: { command: "policy.digest", status: "pass", sha256, covers, violations },
      exitCode: 0,
      summary: sha256,
    };
  }

  if (write) {
    const bundle = policyBundleSchema.parse({
      schema: "forge/policy-bundle@1",
      sha256,
      attestedBy,
      attestedAt: new Date().toISOString(),
      covers,
    });
    const rel = POLICY_DIGEST_PATH;
    await mkdir(path.dirname(path.join(workspaceRoot, rel)), { recursive: true });
    await writeFile(path.join(workspaceRoot, rel), stringifyYaml(bundle), "utf8");
    if (!json) logger.success(`policy.digest: wrote ${rel} (${sha256.slice(0, 12)}…)`);
    return {
      data: { command: "policy.digest", status: "pass", sha256, covers, violations, wrote: rel },
      exitCode: 0,
      summary: `wrote ${rel}`,
    };
  }

  // --verify
  const digestPath = path.join(workspaceRoot, POLICY_DIGEST_PATH);
  if (!existsSync(digestPath)) {
    return fail(`${POLICY_DIGEST_PATH} absent — run policy.digest --write`, { sha256, covers });
  }
  const committed = policyBundleSchema.safeParse(parseYaml(await readFile(digestPath, "utf8")));
  if (!committed.success) {
    return fail(`${POLICY_DIGEST_PATH} malformed — does not validate forge/policy-bundle@1`);
  }
  if (committed.data.sha256 !== sha256) {
    violations.push(
      `policy surface differs from attested digest ${committed.data.sha256.slice(0, 12)}… — regenerate via policy.digest --write`,
    );
    return fail("policy surface advanced without attestation", { sha256, covers });
  }

  if (base) {
    const atBase = await gatherBaseSurface(workspaceRoot, base);
    const baseDigest = atBase ? canonicalPolicyDigest(atBase.surface) : null;
    if (atBase === null) {
      violations.push(`cannot read policy surface at base ${base}`);
      return fail(`base ${base} unreadable or lacks a policy: section`, { sha256, covers });
    }
    if (baseDigest !== sha256) {
      const log = await git(workspaceRoot, ["log", "--format=%B%x00", `${base}..HEAD`]);
      const attested = (log ?? "")
        .split("\0")
        .some((body) => new RegExp(`^X-Policy-Digest:\\s*${sha256}\\s*$`, "m").test(body));
      if (!attested) {
        violations.push(
          `policy surface advanced since ${base} (${baseDigest?.slice(0, 12)}… → ${sha256.slice(0, 12)}…) without a commit carrying X-Policy-Digest: ${sha256}`,
        );
        return fail("unattested policy advance", { sha256, covers });
      }
    }
  }

  if (!json) logger.success(`policy.digest: verified ${sha256.slice(0, 12)}…`);
  return {
    data: { command: "policy.digest", status: "pass", sha256, covers, violations },
    exitCode: 0,
    summary: `verified ${sha256.slice(0, 12)}…`,
  };
}
