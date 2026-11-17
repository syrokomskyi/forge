/*
<MODULE_CONTRACT>
<purpose>RFC-1616 (O-3, AC-7/AC-8): the external-enforcement scaffold —
`.github/workflows/forge-policy.yml` (policy-only correctness gate + pinned
validation + digest verification on every push/PR) and `.github/CODEOWNERS`
(forge.yaml, .forge/, hooks/, .github/workflows/ owned by project.owner or a
documented placeholder). Write-when-absent: operator-tuned files are never
overwritten — the scaffold lands once and hands the keys to the repo.</purpose>
<non-goals>
  <item>No branch-protection API calls — GitHub-side switches are documented, not flipped.</item>
  <item>No enforcement value without the remote toggles — the files are the in-repo half of the boundary.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1616: initial scaffold — workflow + CODEOWNERS write-when-absent.</item>
  <item>RFC-1616: external verification trust boundary

policy.digest (canonical SHA-256 over the frozen surface), adversarial.run
with a 12-scenario catalog replayed through the real gate in a scratch
clone, flow.push verifier-trailer hard stop (fail-closed on unreadable
forge.yaml), project.owner + push.requireVerifierReview config, trust-boundary
scaffold (CODEOWNERS + forge-policy workflow) and reference docs.</item>
  <item>RFC-1616: scaffold templates as shipped files + AC-6 probe name alignment

Extract forge-policy.template.yml and CODEOWNERS.template into
src/scaffold/github/ (shipped in package files[]) so the AC-7/AC-8
file-contains probes verify the real artifacts; rename the push-trailer
suite to the RFC-bound flow-push-verifier-review.test.ts.</item>
  <item>RFC-1616: close verifier r1 counterexamples for the RFC-1616 trust boundary</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Ascend from this module to the directory holding `package.json` (src or dist layout). */
function packageRoot(from: string = MODULE_DIR): string {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

const SCAFFOLD_DIR = path.join(packageRoot(), "src", "scaffold", "github");

/** AC-7: the protected-CI workflow — policy surface judged on every push/PR. */
export const FORGE_POLICY_WORKFLOW = fs.readFileSync(
  path.join(SCAFFOLD_DIR, "forge-policy.template.yml"),
  "utf8",
);

/** AC-8: CODEOWNERS covering the policy-surface paths. */
export function codeownersTemplate(owner: string | undefined): string {
  const who = owner?.trim() || "@OWNER";
  return fs
    .readFileSync(path.join(SCAFFOLD_DIR, "CODEOWNERS.template"), "utf8")
    .replaceAll("@OWNER", who);
}

export interface TrustBoundaryScaffold {
  created: string[];
  skipped: string[];
  /** Marker-missing pre-existing files rewritten with the boundary content (CX-28). */
  replaced: string[];
}

/** What a file must contain to count as the trust-boundary artifact. */
const REQUIRED_MARKERS: Record<string, string[]> = {
  ".github/workflows/forge-policy.yml": [
    "correctness.gate",
    "policy.digest",
    "pinned.validate",
  ],
  ".github/CODEOWNERS": ["forge.yaml", ".github/CODEOWNERS"],
};

/**
 * Write the trust-boundary files when absent. An existing file CARRYING the
 * required markers counts as adopted and keeps its content verbatim
 * (skipped). An existing file WITHOUT them was never the boundary artifact —
 * a session can pre-plant an inert file to fabricate adoption (CX-28), so the
 * scaffold writes the real content: CODEOWNERS gains the boundary block while
 * keeping the file's own lines verbatim, and a foreign `forge-policy.yml` is
 * preserved as `forge-policy.yml.pre-scaffold` before the template lands.
 */
export function scaffoldTrustBoundary(
  workspaceRoot: string,
  owner: string | undefined,
): TrustBoundaryScaffold {
  const created: string[] = [];
  const skipped: string[] = [];
  const replaced: string[] = [];
  const files: Array<{ rel: string; content: string }> = [
    { rel: ".github/workflows/forge-policy.yml", content: FORGE_POLICY_WORKFLOW },
    { rel: ".github/CODEOWNERS", content: codeownersTemplate(owner) },
  ];
  for (const { rel, content } of files) {
    const dest = path.join(workspaceRoot, rel);
    if (fs.existsSync(dest)) {
      let body = "";
      try {
        body = fs.readFileSync(dest, "utf8");
      } catch {
        /* unreadable existing file — replace it like a marker-missing one */
      }
      const missing = (REQUIRED_MARKERS[rel] ?? []).filter((m) => !body.includes(m));
      if (missing.length === 0) {
        skipped.push(`${rel} (already exists)`);
        continue;
      }
      if (rel.endsWith("CODEOWNERS")) {
        const kept = body
          .split("\n")
          .map((l) => l.trimEnd())
          .filter((l) => l && !content.split("\n").some((c) => c.trimEnd() === l))
          .join("\n");
        fs.writeFileSync(
          dest,
          `${content}\n# --- pre-existing entries (kept verbatim) ---\n${kept}\n`,
          "utf8",
        );
      } else {
        fs.writeFileSync(`${dest}.pre-scaffold`, body, "utf8");
        fs.writeFileSync(dest, content, "utf8");
      }
      created.push(rel);
      replaced.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, "utf8");
    created.push(rel);
  }
  return { created, skipped, replaced };
}
