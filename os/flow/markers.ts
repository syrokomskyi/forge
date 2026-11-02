/*
<MODULE_CONTRACT>
<purpose>The forge.generated.yaml extract marker (RFC-1491): written into
every package-line directory by flow.install's `markers` step, checked by
flow.check FLOW-10 and flow.push FLOW-PUSH-06. repo-extract copies the
marker into the extract repository, where the top-level presence exempts
that repository from the flow guard.</purpose>
<non-goals>
  <item>No marker creation at the repository root — a root marker would exempt the monorepo itself.</item>
  <item>No npm packaging policy — package `files` lists keep the marker out of tarballs.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>"Valid" is the strict content contract: parseable YAML carrying schema forge/generated@1 and generator repo-extract — the flow.check FLOW-10 wording matches exactly this test.</item>
  <item>`source` accepts only network origins (RFC-1498): http/https/ssh/git schemes or scp form, userinfo stripped; a local path or file:// URL falls back to the directory basename and reports its rejection kind — the path is never written into a marker.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 2 — extract markers (flow.install step, FLOW-10, FLOW-PUSH-06 input)</item>
  <item>RFC-1491: step 2 — pre-push guard mode, install steps pre-push + markers, FLOW-10</item>
  <item>RFC-1498: step 2 — network-only marker source + rejectedOrigin reporting</item>
</CHANGE_SUMMARY>
*/

import { basename, join } from "node:path";

import { parse as yamlParse } from "yaml";

import type { WorkspaceIO } from "../../src/types.ts";

import { git } from "./git.ts";
import { discoverReleaseLines, type ReleaseLine } from "./release-lines.ts";

export const MARKER_FILE = "forge.generated.yaml";
export const MARKER_SCHEMA = "forge/generated@1";
export const MARKER_GENERATOR = "repo-extract";

export interface LineMarker {
  /** Release-line id (the package directory basename). */
  line: string;
  /** The package line directory relative to the repository root. */
  dir: string;
  /** Absolute marker path. */
  file: string;
}

/** Marker file content for one package line directory. */
export function markerContent(source: string): string {
  return `schema: ${MARKER_SCHEMA}\ngenerator: ${MARKER_GENERATOR}\nsource: ${source}\n`;
}

/** Why an origin URL was rejected as a marker source (RFC-1498). */
export type RejectedOriginKind = "local-path" | "file-url";

/**
 * True for origins that can reach a remote: a network scheme
 * (http, https, ssh, git) or the scp form `<user>@<host>:<path>`
 * (RFC-1498). Local paths, `file://` URLs and anything else are not
 * marker sources — they would leak a machine-local path into the
 * extract repository's forge.generated.yaml.
 */
export function isNetworkOriginUrl(url: string): boolean {
  if (/^(https?|ssh|git):\/\//i.test(url)) return true;
  // scp-like syntax — user@host:path (git's shorthand for ssh).
  return /^[^/@\s]+@[^:/\s]+:[^\s]+$/.test(url);
}

/**
 * The marker `source` value for a repository (RFC-1498): the
 * credential-stripped `origin` URL when it is network-shaped, else the
 * repository directory basename with `rejectedOrigin` naming the kind —
 * never the path itself, so no machine-local path is written into an
 * extract repository.
 */
export async function markerSource(
  repoRoot: string,
  io: WorkspaceIO,
): Promise<{ source: string; rejectedOrigin: RejectedOriginKind | null }> {
  const url = await git(repoRoot, io, ["remote", "get-url", "origin"]);
  const raw = url.exitCode === 0 ? url.stdout.trim() : "";
  if (raw.length === 0) {
    return { source: basename(repoRoot), rejectedOrigin: null };
  }
  if (isNetworkOriginUrl(raw)) {
    // Strip userinfo — https://user:pass@host/path → https://host/path.
    return {
      source: raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1"),
      rejectedOrigin: null,
    };
  }
  return {
    source: basename(repoRoot),
    rejectedOrigin: /^file:/i.test(raw) ? "file-url" : "local-path",
  };
}

/** True when marker content parses and carries the schema + generator. */
export function markerContentIsValid(content: string | null): boolean {
  if (content === null) return false;
  let raw: unknown;
  try {
    raw = yamlParse(content);
  } catch {
    return false;
  }
  if (raw === null || typeof raw !== "object") return false;
  const rec = raw as Record<string, unknown>;
  return rec.schema === MARKER_SCHEMA && rec.generator === MARKER_GENERATOR;
}

/** True when `file` parses and carries the marker schema + generator. */
export async function markerIsValid(file: string, io: WorkspaceIO): Promise<boolean> {
  if (!(await io.exists(file))) return false;
  return markerContentIsValid(await io.readFile(file));
}

/**
 * Package lines whose directory lacks a valid marker. The repo line
 * (`paths: []`) never gets one — a root marker would exempt the monorepo.
 */
export async function missingLineMarkers(
  repoRoot: string,
  io: WorkspaceIO,
): Promise<{ markers: LineMarker[]; lines: ReleaseLine[] }> {
  const { lines } = await discoverReleaseLines(repoRoot, io);
  const markers: LineMarker[] = [];
  for (const line of lines) {
    const dir = line.paths[0];
    if (dir === undefined) continue; // repo line — no marker
    const file = join(repoRoot, dir, MARKER_FILE);
    if (!(await markerIsValid(file, io))) {
      markers.push({ line: line.id, dir, file });
    }
  }
  return { markers, lines };
}
