/*
<MODULE_CONTRACT>
<purpose>Release-line discovery (RFC-1488): the repository line (tag prefix
`v`, root package.json) plus one package line per workspace-glob directory
carrying `extract.config.yaml` (tag prefix `&lt;basename&gt;@`). Discovery reads
pnpm-workspace.yaml, expands each glob's static prefix with readdir to the
glob's depth, matches with picomatch and refuses ambiguous basenames with
FLOW-VER-02.</purpose>
<non-goals>
  <item>No tag reading or version math — release-tags.ts and release-level.ts own those.</item>
  <item>No caching — discovery is a pure function of repository state (DNA-105).</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>extract.config.yaml is the publishability fact (operator decision 2026-11-01) — not independentVersionPackages, which lists only packages/forge.</item>
  <item>Basename collision is an error diagnostic, not a silent merge: two dirs would emit the same tag prefix.</item>
  <item>Return carries `diagnostics` next to `lines` — FLOW-VER-02 must reach flow.version's diagnostic surface; the RFC sketch shows only the line list.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1488: step 1 — release-line discovery via pnpm-workspace globs + extract.config.yaml</item>
  <item>RFC-1488: step 1 — semver helper + release-line discovery (extract.config.yaml workspace globs)</item>
  <item>RFC-1488: review r1 — parse guard, door/rules metadata, id-exact RFC binding, refname precision, FLOW-09 top-level anchor, test cleanup</item>
</CHANGE_SUMMARY>
*/

import { basename, join } from "node:path";

import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";

import type { Diagnostic, WorkspaceIO } from "../../src/types.ts";

export interface ReleaseLine {
  /** "repo" | &lt;package directory basename&gt;, e.g. "forge", "werkstatt-engine". */
  id: string;
  /** "v" | "&lt;id&gt;@". */
  tagPrefix: string;
  /** "package.json" | "&lt;dir&gt;/package.json"; null when the version file is absent. */
  versionFile: string | null;
  /** [] = whole repository; ["packages/forge"] for a package line. */
  paths: string[];
}

export interface ReleaseLinesOutcome {
  lines: ReleaseLine[];
  diagnostics: Diagnostic[];
}

const WORKSPACE_FILE = "pnpm-workspace.yaml";
const EXTRACT_CONFIG = "extract.config.yaml";
const GLOB_CHARS = /[*?[{!]/;

function diagnostic(ruleId: string, severity: "error" | "warning", message: string): Diagnostic {
  return { ruleId, severity, message };
}

/** Split a workspace glob into path segments ("packages/star" → ["packages","*"]). */
function globSegments(glob: string): string[] {
  return glob.split("/").filter((s) => s.length > 0);
}

/**
 * Expand one workspace glob to concrete directory paths under repoRoot.
 * Wildcard segments enumerate subdirectories; literal segments must exist.
 * `node_modules` is never descended into. Negated globs are handled by the
 * caller (their matches are subtracted afterwards).
 */
async function expandGlob(repoRoot: string, glob: string, io: WorkspaceIO): Promise<string[]> {
  const segments = globSegments(glob);
  if (segments.length === 0) return [];
  let candidates = [""];
  for (const segment of segments) {
    const next: string[] = [];
    if (GLOB_CHARS.test(segment)) {
      const matcher = picomatch(segment, { dot: true });
      for (const dir of candidates) {
        const abs = join(repoRoot, dir);
        let entries;
        try {
          entries = await io.readdir(abs);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory) continue;
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          if (!matcher(entry.name)) continue;
          next.push(dir ? `${dir}/${entry.name}` : entry.name);
        }
      }
    } else {
      for (const dir of candidates) {
        const child = dir ? `${dir}/${segment}` : segment;
        if (await io.exists(join(repoRoot, child))) next.push(child);
      }
    }
    candidates = next;
  }
  // Final picomatch over the full glob so braces/classes in earlier segments
  // cannot admit a directory the whole pattern would not.
  const whole = picomatch(glob, { dot: true });
  return candidates.filter((c) => whole(c));
}

/**
 * Discover the release lines of repoRoot. The repository line always exists;
 * package lines come from pnpm-workspace.yaml `packages:` globs where the
 * directory carries `extract.config.yaml`. FLOW-VER-02 names colliding
 * basenames (their tag prefixes would be identical).
 */
export async function discoverReleaseLines(
  repoRoot: string,
  io: WorkspaceIO,
): Promise<ReleaseLinesOutcome> {
  const diagnostics: Diagnostic[] = [];

  const rootPackageJson = join(repoRoot, "package.json");
  const repoLine: ReleaseLine = {
    id: "repo",
    tagPrefix: "v",
    versionFile: (await io.exists(rootPackageJson)) ? "package.json" : null,
    paths: [],
  };

  const globs: string[] = [];
  const negated: string[] = [];
  if (await io.exists(join(repoRoot, WORKSPACE_FILE))) {
    let parsed: { packages?: unknown } | null = null;
    try {
      parsed = parseYaml(await io.readFile(join(repoRoot, WORKSPACE_FILE))) as
        | { packages?: unknown }
        | null;
    } catch {
      diagnostics.push(
        diagnostic(
          "FLOW-VER-02",
          "error",
          `${WORKSPACE_FILE} is not valid YAML — package lines cannot be discovered`,
        ),
      );
    }
    for (const entry of Array.isArray(parsed?.packages) ? parsed?.packages : []) {
      if (typeof entry !== "string") continue;
      if (entry.startsWith("!")) negated.push(entry.slice(1));
      else globs.push(entry);
    }
  }

  const negatedMatchers = negated.map((g) => picomatch(g, { dot: true }));
  const packageDirs = new Set<string>();
  for (const glob of globs) {
    for (const dir of await expandGlob(repoRoot, glob, io)) {
      if (negatedMatchers.some((m) => m(dir))) continue;
      packageDirs.add(dir);
    }
  }

  const lines: ReleaseLine[] = [repoLine];
  const byId = new Map<string, string[]>();
  for (const dir of [...packageDirs].sort()) {
    if (!(await io.exists(join(repoRoot, dir, EXTRACT_CONFIG)))) continue;
    const id = basename(dir);
    const group = byId.get(id) ?? [];
    group.push(dir);
    byId.set(id, group);
  }
  for (const [id, members] of [...byId.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (members.length > 1) {
      diagnostics.push(
        diagnostic(
          "FLOW-VER-02",
          "error",
          `release-line basename '${id}' is claimed by ${members.join(" and ")} — their tag prefixes would collide`,
        ),
      );
      continue;
    }
    const dir = members[0]!;
    lines.push({
      id,
      tagPrefix: `${id}@`,
      versionFile: (await io.exists(join(repoRoot, dir, "package.json")))
        ? `${dir}/package.json`
        : null,
      paths: [dir],
    });
  }

  return { lines, diagnostics };
}

/** The version value a line's version file currently carries, or null. */
export async function readLineVersionFile(
  repoRoot: string,
  line: ReleaseLine,
  io: WorkspaceIO,
): Promise<string | null> {
  if (line.versionFile === null) return null;
  const path = join(repoRoot, line.versionFile);
  if (!(await io.exists(path))) return null;
  try {
    const parsed = JSON.parse(await io.readFile(path)) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

