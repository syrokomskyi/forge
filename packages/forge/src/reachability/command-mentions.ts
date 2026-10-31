/*
<MODULE_CONTRACT>
<purpose>RFC-1351: shared command doc-mention vocabulary — the file set, exclusions, and match patterns that decide when a documented `werkstatt run <name>`/`forge run <name>`/`forge <verb>` mention counts as a reachability edge. Single source consumed by `command.coverage.validate` (mention scan) and the RFC acceptance `reachable` probe (live-doc edge union).</purpose>
<non-goals>
  <item>Do not import node:* or @warpgogol/* — this module is isomorphic; callers supply file enumeration and reads.</item>
  <item>No structural reachability — pipelines/invokers/coverage edges live in computeCommandReachability; this module is doc mentions only.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Frozen and point-in-time trees (archive/, historical/, sessions/, metrics/, reviews/, RFC/ADR/plan bodies, …) record the past or propose the future — a mention there does not invoke a command today (RFC-1242 live/frozen boundary).</item>
  <item>isMentionCandidate enumerates via picomatch over a caller-supplied file list; the coverage validator enumerates via context.io.glob over the same pattern constants — the vocabulary (files, globs, exclusions, regexes) is identical, the enumerated sets are not: the acceptance probe lists tracked + untracked-non-ignored paths via git ls-files --cached --others --exclude-standard (dotfiles included), while fs.glob skips dotfiles. Only the shared vocabulary is guaranteed equivalent.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1351: step 1 — extracted verbatim from command-coverage-validate.ts so the acceptance reachable probe shares the coverage validator's mention vocabulary (Q-1/A).</item>
  <item>RFC-1351: step 1 — doc-mention reachability edge for the acceptance probe

Extract the RUN_MENTION_* vocabulary into @warpgogol/forge/reachability (Q-1/A): the coverage validator imports it, and probeReachableCommand unions manifest reachableVia edges with live doc mentions over the same surface — committed manifest stays structural-only.</item>
  <item>RFC-1351: review F-1/F-2 — doc-scan fs.glob parity + surfaced scan failure + guarded-initializer note</item>
</CHANGE_SUMMARY>
*/

import picomatch from "picomatch";

/** Files scanned for `werkstatt run <name>` / `forge run <name>` mentions. */
export const RUN_MENTION_FILES = [
  "forge.yaml",
  "package.json",
  "AGENTS.md",
  // Dir-scoped guides — `packages/*|services/*|integrations/*/AGENTS.md` needs
  // an intermediate segment and never matches the top-level dir file.
  "packages/AGENTS.md",
  "services/AGENTS.md",
  "integrations/AGENTS.md",
];

export const RUN_MENTION_GLOBS = [
  ".github/workflows/*.yml",
  ".github/workflows/*.yaml",
  "packages/*/package.json",
  "services/*/package.json",
  "integrations/*/package.json",
  "packages/*/AGENTS.md",
  "services/*/AGENTS.md",
  "integrations/*/AGENTS.md",
  "packages/forge/skills/**/*.md",
  "packages/*/src/domain/skills/**/*.md",
  ".agents/skills/**/*.md",
  "docs/**/*.md",
  "hooks/*",
];

/** Generated docs are projections, not invocation contracts. Frozen and
 * point-in-time trees (archive/, historical/, lagebild-archive/, sessions/,
 * metrics/, reviews/, explorations/, evidence/, audits/, and RFC/ADR/plan
 * bodies) record the past or propose the future — a mention there does not
 * invoke the command today (RFC-1242 live/frozen boundary). */
export const RUN_MENTION_EXCLUDE =
  /(?:^|\/)docs\/COMMANDS\.md$|\.generated\.|(?:^|\/)(?:archive|historical|lagebild-archive|sessions|metrics|reviews|explorations|evidence|audits|rfcs|adrs|plans)\//;

export const RUN_MENTION_RE =
  /\b(?:werkstatt|forge)\s+run\s+([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)/g;

/** `forge <verb>` resolves to `forge.<verb>` in the forge CLI (bare subcommands). */
export const FORGE_VERB_RE = /\bforge\s+([a-z][a-z0-9-]*)\b/g;

const mentionMatchers = RUN_MENTION_GLOBS.map((pattern) => picomatch(pattern, { dot: true }));

/** Whether a workspace-relative posix path belongs to the mention-scan surface. */
export function isMentionCandidate(rel: string): boolean {
  const normalized = rel.replace(/\\/g, "/");
  if (RUN_MENTION_EXCLUDE.test(normalized)) return false;
  if (RUN_MENTION_FILES.includes(normalized)) return true;
  return mentionMatchers.some((match) => match(normalized));
}

/** Registered command names whose `run`/`forge <verb>` mentions appear in `text`. */
export function docMentionsInText(text: string, registered: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(RUN_MENTION_RE)) {
    if (registered.has(match[1]!)) found.add(match[1]!);
  }
  for (const match of text.matchAll(FORGE_VERB_RE)) {
    const qualified = `forge.${match[1]!}`;
    if (registered.has(qualified)) found.add(qualified);
  }
  return found;
}
