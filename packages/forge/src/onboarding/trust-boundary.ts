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
  <item>RFC-1616: close verifier r1 counterexamples for the RFC-1616 trust boundary</item>
  <item>RFC-1616: close RFC-1616 r2 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
  <item>RFC-1616: keep an unconfigured scaffold owner from rewriting real CODEOWNERS ownership</item>
  <item>RFC-1616: close RFC-1616 r4 trust-boundary counterexamples</item>
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
    // GitHub CODEOWNERS is narrower than a glob: `?`, `[…]`, `!`, `{}`,
    // `()` and `\` are LITERAL text there (no negation, no char classes,
    // no escaping) while picomatch reads them as pattern syntax — a
    // `?orge.yaml` line would match for us and own nothing on GitHub
    // (CX-69). Escape every glob metacharacter except `*`/`**`/`/` so the
    // matcher applies GitHub's literal semantics exactly.
    pattern = pattern.replace(/[\\?[\](){}!+@^|]/g, "\\$&");
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
 * True when an `if:` condition is provably satisfied — the trigger/step
 * actually executes. Absent/empty counts as true; literal `false` (or an
 * expression that reduces to it) never runs; `success()`/`always()`/
 * `!cancelled()` are the status checks that cannot statically veto. Any
 * other expression — `github.*`, `vars.*`, comparisons — is unprovable, so
 * the guarded line does not count (CX-68: a gate behind `if: false` still
 * enforced nothing).
 */
function conditionRuns(v: unknown): boolean {
  if (v === undefined || v === null || v === true) return true;
  if (v === false) return false;
  if (typeof v !== "string") return false;
  const s = v
    .trim()
    .replace(/^\$\{\{/, "")
    .replace(/\}\}\s*$/, "")
    .trim();
  return /^(?:success|always|!cancelled)\(\)$|^true$/i.test(s);
}

/**
 * True when a workflow event's filters still let it fire for the
 * integration branches — `branches:`/`tags:`/`paths:` filters can scope a
 * `push` trigger down to nothing while the key's presence still counts
 * (CX-67). `push`/`pull_request` bare or as a list entry carry no filter;
 * a map must include BOTH integration branches after its `branches`/
 * `branches-ignore` patterns, may not be tags- or paths-scoped (a push
 * that changes only files outside `paths:` never triggers), and may not
 * coexist filters GitHub would reject.
 */
function eventFiresOnIntegration(cfg: unknown): boolean {
  if (cfg === undefined || cfg === null) return true; // bare `push:` / `pull_request:`
  if (typeof cfg !== "object" || Array.isArray(cfg)) return false; // malformed — cannot run
  const m = cfg as Record<string, unknown>;
  const includes = m["branches"];
  const ignores = m["branches-ignore"];
  if (includes !== undefined && ignores !== undefined) return false; // GitHub rejects the pair
  if (m["paths"] !== undefined || m["paths-ignore"] !== undefined) return false;
  if (
    includes === undefined &&
    ignores === undefined &&
    (m["tags"] !== undefined || m["tags-ignore"] !== undefined)
  ) {
    return false; // tags-only: branch pushes never fire
  }
  const branchMatches = (pats: unknown, branch: string): boolean => {
    if (!Array.isArray(pats)) return false;
    let matched = false;
    for (const p of pats) {
      if (typeof p !== "string") continue;
      const neg = p.startsWith("!");
      const glob = neg ? p.slice(1) : p;
      try {
        if (picomatch(glob, { dot: true })(branch)) matched = !neg;
      } catch {
        /* an unparseable pattern matches nothing on GitHub either */
      }
    }
    return matched;
  };
  if (includes !== undefined) {
    return ["develop", "main"].every((b) => branchMatches(includes, b));
  }
  if (ignores !== undefined) {
    return !["develop", "main"].some((b) => branchMatches(ignores, b));
  }
  return true;
}

/**
 * CX-57: the workflow counts only when it TRIGGERS on `push` in a way
 * that actually fires for the integration branches — the boundary's job
 * is re-judging what lands on them, and a `pull_request`-only or
 * `branches: [never]` workflow enforces nothing on the push path
 * (CX-67). It must also invoke each policy-surface command on a
 * `run:` line led by a real runner (`forge`/`werkstatt`/`pnpm exec
 * forge`/… — an `echo` of the names is not an invocation). `policy.digest`
 * additionally needs `--verify` — a bare print attests nothing. Steps and
 * jobs gated by an unprovable `if:` or wearing `continue-on-error: true`
 * contribute nothing (CX-68), and a `run:` line carrying a `||` tail is an
 * OR-list — under `bash -e` the fallback still swallows the gate's failure
 * (CX-66).
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
  // Enforcement must cover the PUSH path — commits land on the
  // integration branches by pushing, and a `pull_request`-only workflow
  // never fires on a direct push (CX-67).
  let pushOk = false;
  if (typeof on === "string") {
    pushOk = on === "push";
  } else if (Array.isArray(on)) {
    for (const t of on) if (t === "push") pushOk = true;
  } else if (on !== null && typeof on === "object") {
    // braces mandatory — a bare `for` here would rebind the whole else-if
    // chain inside the array branch's inner `if` (dangling else).
    const m = on as Record<string, unknown>;
    if ("push" in m) pushOk = eventFiresOnIntegration(m["push"]);
  }
  if (!pushOk) return false;
  const jobs = (doc as Record<string, unknown>)["jobs"];
  const runs: string[] = [];
  if (jobs !== null && typeof jobs === "object" && !Array.isArray(jobs)) {
    for (const job of Object.values(jobs as Record<string, unknown>)) {
      const j = job as Record<string, unknown> | null;
      if (j === null || !conditionRuns(j["if"]) || j["continue-on-error"] === true) continue;
      const steps = j.steps;
      if (!Array.isArray(steps)) continue;
      for (const step of steps) {
        const s = step as Record<string, unknown> | null;
        if (s === null || !conditionRuns(s["if"]) || s["continue-on-error"] === true) continue;
        const run = s.run;
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
            ).test(line) &&
            // `||` inside a ${{ }} GitHub expression is evaluated by the
            // runner, not the shell — strip the expression spans before
            // looking for a shell-level OR tail (CX-66).
            !/\|\|/.test(line.replace(/\$\{\{[^}]*\}\}/g, "")) &&
            (extra === undefined || extra.test(line)),
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
