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
  <item>RFC-1615: round-4 acceptance counterexamples CX-21..CX-26

Operator-granted fourth fix round. policyLeaves unwinds the cycle guard
after each walk so aliased (anchor-shared) nodes leaf normally — an anchor
re-point is now visible. canon() distinguishes BigInt/non-finite numbers
(intAsBigInt parse, num:/int: tags). isPolicyWellFormed mirrors the
negation-glob malformed rule so forge.upgrade heals !-prefixed freezeFiles.
The isolation strip drops policy:/correctness unconditionally — a
meaningless mutable membership can no longer dead-end the accept path.
Deletions of frozen files honor the verifier trailer pair like any other
touch. lastCommitBody uses :(literal) pathspecs so glob-metachar filenames
cannot borrow a sibling's verifier commit (also closes the same hole in
origin.ts).</item>
  <item>RFC-1615: close RFC-1615 round-10 counterexamples (CX-56..60)</item>
  <item>RFC-1615: close RFC-1615 round-11 counterexamples (CX-61..67)</item>
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

  /**
   * Listing reads that returned null (spawn failure, timeout, corrupt object).
   * A failed `ls-tree`/`diff`/`grep` is NOT an empty result — mapping it to
   * `[]` silently empties the frozen set or launders foreign files through
   * `--accept-weakening`; the gate must fail closed instead
   * (RFC-1615 review CX-59/CX-60).
   */
  readonly unreadableReads: string[] = [];

  readonly root: string;

  // No parameter properties: the forge CLI runs under node's strip-only TypeScript mode.
  constructor(root: string) {
    this.root = root;
    this.git = createOriginGit(root);
  }

  /**
   * A listing read that distinguishes "empty result" from "couldn't read":
   * `okCodes` beyond 0 are successes (git grep exits 1 on zero matches — a
   * legitimate empty listing, not a failure). Failures record in
   * `unreadableReads` and return null (CX-59/60/67).
   */
  async listing(
    args: string[],
    label: string,
    okCodes: readonly number[] = [0],
  ): Promise<string | null> {
    const flag = (out: string): string => {
      // A path decoding to U+FFFD cannot round-trip through UTF-8 argv
      // pathspecs — every later literal read misses it (CX-64).
      const bad = out.split("\0").find((l) => l.includes("�"));
      if (bad) this.unreadableReads.push(`${label}: non-UTF-8 path ${bad.slice(0, 40)}`);
      return out;
    };
    if (this.git.runExit) {
      const res = await this.git.runExit(args);
      if (res !== null && okCodes.includes(res.code)) return flag(res.stdout);
      this.unreadableReads.push(label);
      return null;
    }
    const out = await this.git.run(args);
    if (out === null) {
      this.unreadableReads.push(label);
      return null;
    }
    return flag(out);
  }

  /**
   * Exit-code read for commands whose nonzero status IS the verdict
   * (`merge-base --is-ancestor`: 1 = not an ancestor). `okCodes` are the
   * legitimate verdict codes; spawn failure or any other code records in
   * `unreadableReads` and returns null.
   */
  async exitCode(
    args: string[],
    label: string,
    okCodes: readonly number[] = [0],
  ): Promise<number | null> {
    let code: number | null;
    if (this.git.runExit) {
      code = (await this.git.runExit(args))?.code ?? null;
    } else {
      code = (await this.git.run(args)) !== null ? 0 : null;
    }
    if (code === null || !okCodes.includes(code)) {
      this.unreadableReads.push(label);
      return null;
    }
    return code;
  }

  /**
   * File content at `rev`, or null when absent. "Absent" and "unreadable"
   * are not the same: `git show` fails on a corrupt blob exactly as on a
   * missing path, but `rev-parse` resolves the tree entry without reading
   * blob bytes — an entry that exists yet cannot be shown is a corrupt
   * object, and judging it "absent" would silently inert the surface it
   * carries (RFC-1615 review CX-61/62/63).
   */
  async show(rev: string, rel: string): Promise<string | null> {
    const out = await this.git.run(["show", `${rev}:${rel}`]);
    if (out === null && (await this.blob(rev, rel)) !== null)
      this.unreadableReads.push(`show ${rev}:${rel}`);
    return out;
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
    const out = await this.listing(["ls-tree", "-r", "-z", "--name-only", rev], `ls-tree ${rev}`);
    return (out ?? "").split("\0").filter((l) => l.length > 0);
  }

  async changedPaths(base: string, head: string): Promise<string[]> {
    // --no-renames: a rename emits delete+add — the old path must stay
    // visible or a `git mv`d anchor carrier reads as untouched (CX-65).
    const out = await this.listing(
      ["diff", "--name-only", "-z", "--no-renames", `${base}..${head}`],
      `diff ${base}..${head}`,
    );
    return (out ?? "").split("\0").filter((l) => l.length > 0);
  }

  /**
   * Files containing `pattern` (fixed string) at `rev` — `git grep -l`.
   * Exit 1 (zero matches) is a valid empty listing, not a failure (CX-67).
   */
  async grepList(rev: string, pattern: string): Promise<string[]> {
    const out = await this.listing(
      ["grep", "-l", "-z", "-F", pattern, rev, "--"],
      `grep ${pattern} ${rev}`,
      [0, 1],
    );
    return (out ?? "").split("\0").filter((l) => l.length > 0);
  }

  /** Body of the last commit (≤ head) touching `rel`, or null. */
  async lastCommitBody(head: string, rel: string): Promise<{ sha: string; body: string } | null> {
    // `:(literal)` — a glob-metachar filename (`x[1].sh`, `*.sh`) must not
    // match sibling paths and borrow their verifier commits (RFC-1615
    // review CX-26).
    const out = await this.git.run([
      "log",
      "-1",
      "--format=%H%x1f%B",
      head,
      "--",
      `:(literal)${rel}`,
    ]);
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
