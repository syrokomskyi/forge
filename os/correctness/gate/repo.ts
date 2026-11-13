/*
<MODULE_CONTRACT>
<purpose>RFC-1580: git reads the gate needs — files and blob ids at a
revision, last commit touching a path, changed paths in a range — through
the RFC-1330 origin git port (argv exec, DNA-89).</purpose>
<non-goals>
  <item>No writes, no checkout.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: initial git reads.</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";

import {
  createOriginGit,
  hasVerifierTrailers,
  type OriginGit,
} from "../../rfc/verification-origin.ts";

export class GateRepo {
  readonly git: OriginGit;
  private readonly blobCache = new Map<string, string | null>();

  readonly root: string;

  // No parameter properties: the forge CLI runs under node's strip-only TypeScript mode.
  constructor(root: string) {
    this.root = root;
    this.git = createOriginGit(root);
  }

  async show(rev: string, rel: string): Promise<string | null> {
    return this.git.run(["show", `${rev}:${rel}`]);
  }

  /** Blob id of `rel` at `rev`, null when absent. */
  async blob(rev: string, rel: string): Promise<string | null> {
    const key = `${rev}:${rel}`;
    if (this.blobCache.has(key)) return this.blobCache.get(key)!;
    const out = await this.git.run(["rev-parse", "--verify", "--quiet", `${rev}:${rel}`]);
    const sha = out?.trim() || null;
    this.blobCache.set(key, sha);
    return sha;
  }

  async files(rev: string): Promise<string[]> {
    const out = await this.git.run(["ls-tree", "-r", "-z", "--name-only", rev]);
    return (out ?? "").split("\0").filter((l) => l.length > 0);
  }

  async changedPaths(base: string, head: string): Promise<string[]> {
    const out = await this.git.run(["diff", "--name-only", "-z", `${base}..${head}`]);
    return (out ?? "").split("\0").filter((l) => l.length > 0);
  }

  /** Body of the last commit (≤ head) touching `rel`, or null. */
  async lastCommitBody(head: string, rel: string): Promise<{ sha: string; body: string } | null> {
    const out = await this.git.run(["log", "-1", "--format=%H%x1f%B", head, "--", rel]);
    if (!out || !out.includes("\x1f")) return null;
    const [sha, body] = out.split("\x1f");
    return { sha: sha!.trim(), body: body ?? "" };
  }

  /** True when the last commit touching `rel` carries the RFC-1333 verifier trailer pair. */
  async lastTouchIsVerifier(head: string, rel: string): Promise<boolean> {
    const last = await this.lastCommitBody(head, rel);
    return last !== null && hasVerifierTrailers(last.body);
  }

  async revParse(ref: string): Promise<string | null> {
    const out = await this.git.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    const sha = out?.trim() ?? "";
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  }

  async commonDir(): Promise<string | null> {
    const out = await this.git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return out?.trim() || null;
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Path part of an RFC-1390 binding reference (`test:a/b.ts` → `a/b.ts`); null for `lint:`. */
export function checkTarget(check: string): string | null {
  const idx = check.indexOf(":");
  if (idx === -1) return null;
  const kind = check.slice(0, idx).trim();
  if (kind !== "test" && kind !== "type" && kind !== "proof") return null;
  return check
    .slice(idx + 1)
    .trim()
    .replace(/^\.\//, "");
}
