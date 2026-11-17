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
  <item>RFC-1616: scaffold templates as shipped files + AC-6 probe name alignment

Extract forge-policy.template.yml and CODEOWNERS.template into
src/scaffold/github/ (shipped in package files[]) so the AC-7/AC-8
file-contains probes verify the real artifacts; rename the push-trailer
suite to the RFC-bound flow-push-verifier-review.test.ts.</item>
  <item>RFC-1616: close verifier r1 counterexamples for the RFC-1616 trust boundary</item>
  <item>RFC-1616: close RFC-1616 r2 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
  <item>RFC-1616: keep an unconfigured scaffold owner from rewriting real CODEOWNERS ownership</item>
  <history>RFC-1616</history>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
import { sanitizeOwnerHandle } from "../config/forge-config.ts";

export { sanitizeOwnerHandle };

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
  // sanitizeOwnerHandle never returns control characters — a newline-bearing
  // owner cannot inject an extra ownership rule (CX-40); an unparseable one
  // keeps the documented placeholder rather than expanding to a weaker owner.
  const who = sanitizeOwnerHandle(owner) ?? "@OWNER";
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

/**
 * The trust-anchor paths CODEOWNERS must own for the scaffold to count as
 * adopted — checked as EFFECTIVE rules, never substring presence (CX-56):
 * `forge.yaml.bak` / `docs/forge.yaml-owners.md` own nothing, and a session-
 * owned anchor is not the operator's boundary. Directory entries probe a
 * representative path inside the dir.
 */
const REQUIRED_OWNED: Record<string, string> = {
  "forge.yaml": "forge.yaml",
  ".forge/": ".forge/pinned.yaml",
  "hooks/": "hooks/integration-gate.sh",
  ".github/workflows/": ".github/workflows/forge-policy.yml",
  ".github/CODEOWNERS": ".github/CODEOWNERS",
};

/**
 * CODEOWNERS last-match-wins ownership: the owner list of the LAST rule whose
 * pattern matches `relPath`, or null when no effective rule covers it.
 * Gitignore-style mapping — bare names match the basename anywhere, a
 * slash-bearing pattern anchors at the repo root, a trailing `/` covers the
 * directory's contents. `!`/char-class escapes are not CODEOWNERS syntax.
 */
function effectiveOwners(body: string, relPath: string): string[] | null {
  let owners: string[] | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    let pattern = parts[0]!;
    if (pattern.endsWith("/")) pattern = `${pattern}**`;
    pattern = pattern.startsWith("/") ? pattern.slice(1) : pattern;
    const glob = pattern.includes("/") ? pattern : `**/${pattern}`;
    if (picomatch(glob, { dot: true })(relPath)) owners = parts.slice(1);
  }
  return owners;
}

/**
 * CX-56: adopted only when EVERY boundary path resolves to an effective rule
 * whose owner list includes the configured anchor handle — a session-owned or
 * suffix-spoofed or doc-named line never counts. An unconfigured owner
 * renders the `@OWNER` placeholder, and a write under it can never claim
 * the boundary — overwriting a real owner's rules with the placeholder
 * would regress ownership, and skipping a planted file loses nothing the
 * placeholder could have fixed, so any effective coverage already standing
 * counts as adopted until `project.owner` is set.
 */
function codeownersAdopted(body: string, who: string): boolean {
  const unconfigured = who === "@OWNER";
  return Object.values(REQUIRED_OWNED).every((rel) => {
    const owners = effectiveOwners(body, rel) ?? [];
    return unconfigured ? owners.length > 0 : owners.includes(who);
  });
}

/**
 * CX-57: the workflow counts only when it both TRIGGERS on `push` or
 * `pull_request` (a `workflow_dispatch`-only no-op enforces nothing) and
 * invokes each policy-surface command on a `run:` line led by a real runner
 * (`forge`/`werkstatt`/`pnpm exec forge`/… — an `echo` of the names is not an
 * invocation). `policy.digest` additionally needs `--verify` — a bare print
 * attests nothing.
 */
function workflowAdopted(body: string): boolean {
  let doc: unknown;
  try {
    doc = parseYaml(body);
  } catch {
    return false;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return false;
  const on = (doc as Record<string, unknown>)["on"];
  const triggers = new Set<string>();
  if (typeof on === "string") {
    triggers.add(on);
  } else if (Array.isArray(on)) {
    for (const t of on) if (typeof t === "string") triggers.add(t);
  } else if (on !== null && typeof on === "object") {
    // braces mandatory — a bare `for` here would rebind the whole else-if
    // chain inside the array branch's inner `if` (dangling else).
    for (const k of Object.keys(on as Record<string, unknown>)) triggers.add(k);
  }
  if (!triggers.has("push") && !triggers.has("pull_request")) return false;
  const jobs = (doc as Record<string, unknown>)["jobs"];
  const runs: string[] = [];
  if (jobs !== null && typeof jobs === "object" && !Array.isArray(jobs)) {
    for (const job of Object.values(jobs as Record<string, unknown>)) {
      const steps = (job as { steps?: unknown } | null)?.steps;
      if (!Array.isArray(steps)) continue;
      for (const step of steps) {
        const run = (step as { run?: unknown } | null)?.run;
        if (typeof run === "string") runs.push(run);
      }
    }
  }
  const invokes = (cmd: string, extra?: RegExp): boolean =>
    runs.some((run) =>
      run
        .split("\n")
        .some(
          (line) =>
            new RegExp(
              `^\\s*(?:pnpm\\s+exec\\s+|npx\\s+|yarn\\s+exec\\s+|bunx?\\s+)?(?:forge|werkstatt)\\s+(?:run\\s+)?${cmd}\\b`,
            ).test(line) && (extra === undefined || extra.test(line)),
        ),
    );
  return (
    invokes("correctness\\.gate") &&
    invokes("policy\\.digest", /--verify\b/) &&
    invokes("pinned\\.validate")
  );
}

/** Per-file adoption verdict — structural, never substring (CX-56/CX-57). */
function isAdopted(rel: string, body: string, who: string): boolean {
  if (rel.endsWith("CODEOWNERS")) return codeownersAdopted(body, who);
  return workflowAdopted(body);
}

/**
 * `sanitizeOwnerHandle` — a GitHub handle (`@user`/`@org/team`) extracted
 * from a raw owner string, or undefined when nothing handle-shaped leads it —
 * lives in forge-config.ts so `loadForgeConfig` and the scaffold sanitize the
 * same trust anchor (CX-40: a newline-bearing owner must never inject
 * ownership rules into CODEOWNERS).
 */

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
  const who = sanitizeOwnerHandle(owner) ?? "@OWNER";
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
        /* unreadable existing file — replace it like an unadopted one */
      }
      if (isAdopted(rel, body, who)) {
        skipped.push(`${rel} (already exists)`);
        continue;
      }
      if (rel.endsWith("CODEOWNERS")) {
        const kept = body
          .split("\n")
          .map((l) => l.trimEnd())
          .filter((l) => l && !content.split("\n").some((c) => c.trimEnd() === l))
          .join("\n");
        // GitHub CODEOWNERS is last-match-wins — the boundary block MUST land
        // after every kept line or a planted `* @session` rule shadows the
        // trust-anchor ownership it was planted to defeat (CX-38).
        fs.writeFileSync(
          dest,
          `${kept}${kept ? "\n" : ""}# --- forge trust boundary (added by scaffold) ---\n${content}`,
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
