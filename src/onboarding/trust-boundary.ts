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
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";

/** AC-7: the protected-CI workflow — policy surface judged on every push/PR. */
export const FORGE_POLICY_WORKFLOW = `name: forge-policy

# RFC-1616 — the external half of the trust boundary. Every push and pull
# request re-judges the declared policy surface in the repository's own CI,
# outside the session's write access: the frozen forge.yaml keys, the
# pinned-file set, and the recorded policy digest. A session that weakens a
# gate locally cannot make this job go green — only an accepted, isolated
# weakening (or an operator change to this workflow, which CODEOWNERS
# review-gates) can.

on:
  push:
    branches: [develop, main]
  pull_request:

jobs:
  policy-surface:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          lfs: true
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # The frozen policy surface: forge.yaml policy keys, freezeFiles, the
      # manifest set — judged policy-only so the job does not need the full
      # oracle substrate.
      - name: Correctness gate (policy-only)
        run: pnpm exec forge correctness.gate --policy-only --base \${{ github.event.before || 'HEAD~1' }}
      # The pinned file set must resolve and validate in CI mode.
      - name: Pinned validation
        run: pnpm exec forge pinned.validate --mode ci
      # The recorded digest must match the policy surface as committed.
      - name: Policy digest
        run: pnpm exec forge policy.digest --verify
`;

/** AC-8: CODEOWNERS covering the policy-surface paths. */
export function codeownersTemplate(owner: string | undefined): string {
  const who = owner?.trim() || "@OWNER";
  return `# CODEOWNERS — RFC-1616 trust boundary
#
# The policy surface is owned by the operator, not by sessions: a pull
# request touching any of these paths requires the owner's review before it
# can merge (with GitHub "require review from Code Owners" branch protection
# enabled — see packages/forge/docs/reference/trust-boundary.md).
${owner?.trim() ? "" : "# Set project.owner in forge.yaml to your @user or @org/team handle and\n# re-run forge upgrade, or replace @OWNER here by hand.\n"}
forge.yaml              ${who}
.forge/                 ${who}
hooks/                  ${who}
.github/workflows/      ${who}
`;
}

export interface TrustBoundaryScaffold {
  created: string[];
  skipped: string[];
}

/**
 * Write the trust-boundary files when absent. Never overwrites: an
 * operator-tuned CODEOWNERS or workflow keeps its content verbatim — the
 * file's existence IS the adoption.
 */
export function scaffoldTrustBoundary(
  workspaceRoot: string,
  owner: string | undefined,
): TrustBoundaryScaffold {
  const created: string[] = [];
  const skipped: string[] = [];
  const files: Array<{ rel: string; content: string }> = [
    { rel: ".github/workflows/forge-policy.yml", content: FORGE_POLICY_WORKFLOW },
    { rel: ".github/CODEOWNERS", content: codeownersTemplate(owner) },
  ];
  for (const { rel, content } of files) {
    const dest = path.join(workspaceRoot, rel);
    if (fs.existsSync(dest)) {
      skipped.push(`${rel} (already exists)`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, "utf8");
    created.push(rel);
  }
  return { created, skipped };
}
