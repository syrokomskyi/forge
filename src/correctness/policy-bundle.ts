/*
<MODULE_CONTRACT>
<purpose>RFC-1616: the forge/policy-bundle@1 attestation artifact — a canonical
sha256 over the declared policy surface (policy:-frozen forge.yaml keys,
freezeFiles contents, .forge/pinned.yaml, hooks/, .github/workflows/) plus the
attestation metadata a CODEOWNERS rule can own. policy.digest --write emits it;
--verify recomputes and compares.</purpose>
<non-goals>
  <item>Does not read forge.yaml or the filesystem — the os/ handler gathers the surface and calls canonicalPolicyDigest.</item>
  <item>Does not define the gate's judged-diff vocabulary — that is os/correctness/gate.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Digest input is a canonical JSON form (sorted keys at every level, LF-normalized file text) so a digest is reproducible across platforms and YAML spellings — the digest covers parsed content, never raw bytes of forge.yaml.</item>
  <item>covers[] records which surface parts contributed so a reviewer sees the digest's scope without recomputing.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1616: initial contract — policyBundleSchema, canonicalJson, canonicalPolicyDigest, PolicySurface types.</item>
  <item>RFC-1616: step 1 — policy-bundle schema + adversarial types

forge/policy-bundle@1 zod contract, canonicalJson + canonicalPolicyDigest (stable-key sha256 over parsed doc + file contents), forge/adversarial-scenario@1 fixture schema and result types.</item>
  <item>RFC-1616: close verifier r1 counterexamples for the RFC-1616 trust boundary</item>
  <item>RFC-1616: close RFC-1616 r2 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";
import { z } from "zod";

/** forge/policy-bundle@1 — the committed attestation artifact `.forge/policy.digest`. */
export const policyBundleSchema = z.object({
  schema: z.literal("forge/policy-bundle@1"),
  /** canonical sha256 of the declared policy surface */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** "human:<handle>" or "operator:<id>" — who attested this digest */
  attestedBy: z.string().min(1),
  /** ISO date of attestation */
  attestedAt: z.string().min(1),
  /** normalized list of digested paths/keys — the digest's declared scope */
  covers: z.array(z.string()),
});
export type PolicyBundle = z.infer<typeof policyBundleSchema>;

export const POLICY_DIGEST_PATH = ".forge/policy.digest";

/** One digested file: repo-root-relative path + git-style mode + LF-normalized content. */
export interface PolicySurfaceFile {
  path: string;
  content: string;
  /** git file mode ("100644"/"100755"/"120000") — mode changes advance the surface (CX-13) */
  mode?: string;
}

/** The normalized policy surface the digest covers. */
export interface PolicySurface {
  /** canonical (parsed) forge.yaml content restricted to frozen-key semantics — the full parsed doc, policy-frozen or not */
  forgeDoc: unknown;
  /** file contents keyed by repo-relative path — freezeFiles matches, .forge/pinned.yaml, hooks/, .github/workflows/ */
  files: PolicySurfaceFile[];
}

/**
 * Stable-key canonical form: object keys sorted (UTF-16 code-unit order,
 * matching JS sort()), arrays preserved, LF line endings, no insignificant
 * whitespace. Determinism is the contract — two YAML spellings of the same
 * parsed doc digest identically. Scalar TYPE distinctions the gate's `canon`
 * keeps use the SAME unquoted tagged forms here: `.inf`/`.nan`/`-0` never
 * collapse to `~` (JSON null), a `!!timestamp` Date never equals its own ISO
 * string, and tagged containers (Map/Set/binary views) never read as plain
 * arrays or strings (CX-59). The tags are unquoted deliberately — a quoted
 * `"int:9007…"` string leaf would collide with the `int:9007…` bigint tag,
 * while no JSON serialization of a plain scalar/object emits the unquoted
 * tag bytes. Cycles hit the same `<cycle>` sentinel the gate uses — a YAML
 * alias cycle (`a: &x {b: *x}`) must not recurse forever (same CX-128 guard).
 */
export function canonicalJson(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  // intAsBigInt parses every YAML int as BigInt — serialize the tagged form
  // so 9007199254740993 and 9007199254740992 stay distinct (CX-43).
  if (typeof value === "bigint") return `int:${value.toString()}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `num:${value}`;
    if (Object.is(value, -0)) return "num:-0"; // `-0` ≠ `0` (CX-22 parity)
    return JSON.stringify(value);
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (seen.has(value)) return "<cycle>";
  seen.add(value);
  try {
    if (value instanceof Date) return `date:${value.getTime()}`;
    if (value instanceof Map) {
      const entries = [...value.entries()].map(
        ([k, v]) => [canonicalJson(k, seen), canonicalJson(v, seen)] as const,
      );
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `map:{${entries.map(([k, v]) => `${k}:${v}`).join(",")}}`;
    }
    if (value instanceof Set) {
      return `set:{${[...value.values()]
        .map((v) => canonicalJson(v, seen))
        .sort()
        .join(",")}}`;
    }
    if (ArrayBuffer.isView(value)) {
      return `bin:${Array.from(value as Uint8Array).join(",")}`;
    }
    if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, seen)).join(",")}]`;
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * RFC-1616 (CX-58): leaf paths carved out of every `policy.mutable` grant —
 * trust-surface pointers a session must never rebind by granting their
 * container. `project.owner` binds the CODEOWNERS handle; `paths.skillsDir`
 * is the agent's own instruction surface, `paths.specsDir`/`paths.auditsDir`
 * resolve vendored contracts and audit records; `bindings.commands.*`
 * oracle-runner templates (`verifyReproduction`/`outcomeBuild`/`outcomeServe`)
 * spawn code exactly like `checkRun`; `bindings.paths.correctnessLedger` is
 * the survival-ledger pointer.
 *
 * The carve deliberately covers ONLY leaves `diffWeakenings` does not already
 * judge: the RFC-1580 binding set (`bindings.commands.checkRun`,
 * `bindings.paths.{correctnessManifest,oracleReviewsDir,invariantsFile,
 * compassDocs}`, `paths.rfcsDir`) keeps its documented semantics — released
 * under a `mutable` grant in `--policy-only`, judged in full mode (RFC-1615
 * "the double-judged subset"). Record-output pointers that are no verdict
 * input today (`bindings.paths.{reviewsDir,handoffsDir,sessionsDir}`,
 * `paths.{plansDir,adrsDir,sessionsDir}`) stay grant-eligible — `adrsDir`
 * under `mutable:[paths]` is exercised by the P-C9 isolation regression, and
 * additive additions of record leaves under `additive:[bindings]` are the
 * documented AC-2 feature.
 */
export const CARVED_POLICY_PATHS: ReadonlyArray<readonly string[]> = [
  ["project", "owner"],
  ["paths", "skillsDir"],
  ["paths", "specsDir"],
  ["paths", "auditsDir"],
  ["bindings", "commands", "verifyReproduction"],
  ["bindings", "commands", "outcomeBuild"],
  ["bindings", "commands", "outcomeServe"],
  ["bindings", "paths", "correctnessLedger"],
];

/** `doc[path[0]][path[1]]…` walked segment by segment — undefined when any step is absent or non-object. */
export function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let cur = value;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** True when every segment of `path` exists as an own key — presence-aware (a `key:` null leaf still counts). */
export function hasPath(value: unknown, path: readonly string[]): boolean {
  let cur = value;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, seg)) return false;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return true;
}

/** sha256 over the canonical policy surface. */
export function canonicalPolicyDigest(surface: PolicySurface): string {
  const h = createHash("sha256");
  h.update(canonicalJson(surface.forgeDoc));
  for (const f of [...surface.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    h.update("\0");
    h.update(f.path);
    h.update("\0");
    h.update(f.mode ?? "");
    h.update("\0");
    h.update(f.content.replace(/\r\n/g, "\n"));
  }
  return h.digest("hex");
}

/** The scope list recorded in covers[] — sorted, deduped. */
export function coversOf(surface: PolicySurface, extra: string[] = []): string[] {
  return [...new Set(["forge.yaml", ...surface.files.map((f) => f.path), ...extra])].sort();
}
