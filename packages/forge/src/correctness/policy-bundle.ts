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
 * Stable-key JSON: object keys sorted (UTF-16 code-unit order, matching JS
 * sort()), arrays preserved, LF line endings, no insignificant whitespace.
 * Determinism is the contract — two YAML spellings of the same parsed doc
 * digest identically.
 */
export function canonicalJson(value: unknown): string {
  // intAsBigInt parses every YAML int as BigInt — serialize the tagged form
  // so 9007199254740993 and 9007199254740992 stay distinct (CX-43).
  if (typeof value === "bigint") return JSON.stringify(`int:${value.toString()}`);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value instanceof Map) {
    return canonicalJson([...value.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  if (value instanceof Set) {
    return canonicalJson([...value.values()].sort());
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`;
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
