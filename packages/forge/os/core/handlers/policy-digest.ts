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
  <item>RFC-1616: external verification trust boundary

policy.digest (canonical SHA-256 over the frozen surface), adversarial.run
with a 12-scenario catalog replayed through the real gate in a scratch
clone, flow.push verifier-trailer hard stop (fail-closed on unreadable
forge.yaml), project.owner + push.requireVerifierReview config, trust-boundary
scaffold (CODEOWNERS + forge-policy workflow) and reference docs.</item>
  <item>RFC-1616: close verifier r1 counterexamples for the RFC-1616 trust boundary</item>
  <item>RFC-1616: close RFC-1616 r2 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r7 trust-boundary counterexamples

Independent clean-context verification (round 7, candidate d2f270ad6)
returned REFUTED with eleven live counterexamples against the
r6-hardened evidence channel — this commit closes all nine root causes.

- remote.<name>.fetch is value-judged: only the clone-default
  +?refs/heads/*:refs/remotes/<name>/* shape stays KEEP, because git
  UNIONs configured refspecs with the pinned fetch argv and a session
  spec writes arbitrary local refs inside the trusted fetch (CX-94).
  remote.<name>.tagopt|promirror|followremotehead|prunetags|
  skipfetchall|mirror move to REFUSE for the same reason.
- Alternates/shape comment lexing is col-0 `#` only — git's parser does
  not treat whitespace-led `#` as a comment, so `   # forged` is a real
  alternates path the shape check must count (CX-95).
- config reads forbid the alternate-source selectors --file/-f, --blob,
  --worktree (reaches config.worktree even under the disabled-extension
  pin), --system/--global, --default and --includes, plus the
  write-action spellings, on both the evidence and shared read-only
  tables (CX-96).
- verifierGit judges fabrication argv on the runner/policy channel:
  @{...}, -g, --reflog, --walk-reflogs and --fork-point return
  EVIDENCE-REFUSED before the spawn — policy.digest --base 'HEAD@{0}'
  can no longer verify an unattested advance (CX-97).
- --use-bitmap-index/--test-bitmap are forbidden on rev-list/log in
  both tables — the flag opts the trusted walk into the session-
  writable pack bitmap cache the commitGraph/MIDX pins closed (CX-98).
- for-each-ref/show-ref/ls-remote forbid --stdin and --exclude-existing
  on both tables — they block on input the no-stdin spawn never
  supplies (CX-101).
- The workflow-adoption heredoc lexer is bash-faithful: openers are
  scanned on the raw line before the # comment strip (quoted-#
  delimiters, CX-99a), bare delimiters accept digits/./- (CX-99b), and
  the terminator match is strict — << wants the delimiter alone, <<-/
  <<~ skip leading tabs only (CX-100).
- Trailer scans read %e beside %(trailers): a commit declaring a
  non-UTF-8 encoding header recodes every trusted message read, so the
  digest trail and the push-time scan flag it as unverifiable and the
  policy attestation scan skips it (CX-102).

Probe premise updates for the tightened contract: CX-61's decoy
remote.origin.fetch (cx4 and cx5 R5-R1) now asserts the wholesale
EVIDENCE-REFUSED plus FLOW-PUSH-13 refuse — strictly stronger than the
decoy-namespace guard it replaces. The independent r7 probe file and
acceptance report land in the follow-up port commit.</item>
  <history>RFC-1616</history>
</CHANGE_SUMMARY>
*/

import { existsSync, lstatSync } from "node:fs";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import {
  CARVED_POLICY_PATHS,
  POLICY_DIGEST_PATH,
  canonicalPolicyDigest,
  coversOf,
  hasPath,
  policyBundleSchema,
  valueAtPath,
  type PolicySurface,
} from "../../../src/correctness/policy-bundle.ts";
import { verifierGit } from "../../../src/utils/verifier-git.ts";

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
 * Top-level keys the digest always attests even when a declaration grants
 * them — `policy` governs the freeze itself (a `mutable:["policy"]` grant
 * must not self-exclude the meta-policy from attestation, CX-11) and
 * `push`/`correctness` configure the judging surface (review switch, gate
 * mode/budget). The gate keeps the same set never-free in `policyWeakenings`
 * (CX-35/36/45) — the attestation and the gate must judge identically or the
 * digest attests a surface the gate cannot enforce. `bindings`/`paths` stay
 * grant-eligible, matching the gate's documented grant semantics.
 */
const ALWAYS_JUDGED = new Set(["policy", "push", "correctness"]);

/**
 * forge.yaml reduced to the policy-judged surface: every key except mutable —
 * except ALWAYS_JUDGED keys and the CARVED_POLICY_PATHS leaves, which stay
 * digested even under a `mutable` container grant so a trust-anchor rebind
 * always advances the attestation (CX-32/CX-58). The gate's `policyWeakenings`
 * carves the same leaf list — the two arbiters must judge identically.
 */
function judgedDoc(doc: Record<string, unknown>, policy: PolicyDecl): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(doc)) {
    if (ALWAYS_JUDGED.has(k) || !policy.mutable.includes(k)) out[k] = doc[k];
  }
  for (const p of CARVED_POLICY_PATHS) {
    const top = p[0]!;
    const sub = p.slice(1);
    // Only merge under a mutable container — a non-mutable top-level key is
    // digested whole already, and re-copying the leaf would be a no-op.
    if (!policy.mutable.includes(top) || !hasPath(doc[top], sub)) continue;
    // The leaf's presence is itself judged — a planted pointer attests too.
    let node = (out[top] ??= {}) as Record<string, unknown>;
    for (const seg of sub.slice(0, -1)) {
      node = (node[seg] ??= {}) as Record<string, unknown>;
    }
    node[sub[sub.length - 1]!] = valueAtPath(doc[top], sub);
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
  // Boundary evidence channel — session GIT_* variables and refs/replace must
  // not redirect or substitute what the attestation reads (CX-46..CX-50).
  const result = await verifierGit(root, ["-C", root, ...args]);
  return result.exitCode === 0 ? result.stdout : null;
}

async function gatherBaseSurface(
  root: string,
  base: string,
): Promise<{ surface: PolicySurface; policy: PolicyDecl } | null> {
  const raw = await git(root, ["show", `${base}:forge.yaml`]);
  if (raw === null) return null;
  // intAsBigInt — the gate's canon parses with it; a digest that rounds
  // 9007199254740993 → 9007199254740992 attests a change the gate refuses
  // (CX-43). The two arbiters must see the same parsed doc.
  const doc = parseYaml(raw, { intAsBigInt: true }) as Record<string, unknown>;
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
  const doc = parseYaml(await readFile(forgeYamlPath, "utf8"), {
    intAsBigInt: true,
  }) as Record<string, unknown>;
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
      // Attestation trailers come through git's OWN `%(trailers:)` parser —
      // per-commit reads carry no record separator a message byte can forge,
      // and `x-policy-digest:`/`X-Policy-Digest :` spellings count exactly as
      // `git interpret-trailers` counts them (CX-33/CX-60 parity).
      const list = await git(workspaceRoot, ["rev-list", `${base}..HEAD`]);
      let attested = false;
      for (const sha of (list ?? "").split("\n").filter(Boolean)) {
        // `%e` rides along: a declared non-UTF-8 `encoding:` header
        // recodes %(trailers) output — stored bytes can decode into a
        // forged trailer line no -c pin can strip (CX-102). An encoded
        // commit's trailers cannot attest.
        const values = await git(workspaceRoot, [
          "log",
          "-1",
          "--format=%(trailers:key=X-Policy-Digest,valueonly,separator=%x00)%x00%e",
          sha,
        ]);
        const parts = (values ?? "").split("\x00");
        const declaredEncoding = (parts.pop() ?? "").trim();
        if (declaredEncoding.length > 0 && !/^utf-?8$/i.test(declaredEncoding)) continue;
        if (parts.some((v) => v.trim() === sha256)) {
          attested = true;
          break;
        }
      }
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
