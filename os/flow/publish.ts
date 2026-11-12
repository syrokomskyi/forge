/*
<MODULE_CONTRACT>
<purpose>Generated-artifact publication for one release tag (RFC-1491):
repo-extract the package line's extract repo at the tag, run the
extract-verify hook, push the destination once — reconciling with a single
ours-merge only on a non-fast-forward rejection, never force-pushing —
and return the RFC publications[] row for the journal.</purpose>
<non-goals>
  <item>No push orchestration — handlers/flow-push.ts owns preflight and the atomic push.</item>
  <item>No real repo-extract in tests — fixtures install a fake node_modules/.bin/repo-extract.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Destination resolution mirrors the retired publish-forge.mjs (RFC-1499) resolveDest(): destBase/destName parsed from extract.config.yaml, anchored at dirname(primary), destBase default "packages".</item>
  <item>Reconcile only on non-fast-forward (the same regex as the retired publish-forge.mjs, RFC-1499) — auth, hook and transient failures never trigger an ours-merge.</item>
  <item>verifyLineAtRef (RFC-1502) extracts into an mkdtemp scratch via `--dest` — the configured destination is never touched — and a spawn failure of the repo-extract binary reports as a verification failure, not a crash.</item>
  <item>preflight-extract-gates (RFC-1517) reads CHANGELOG.md and package.json AT `ref` via `git show` — never the working tree: during flow.cut the freshly-written version section lives only in the release commit, so a working-tree read would false-refuse every legitimate publish.</item>
  <item>preflight fails open on unreadable git objects (missing CHANGELOG, unparseable package.json, unresolvable ref) — mirroring the post-extract gate's parity-note contract; a preflight must never block a publish it cannot judge.</item>
  <item>RFC-1517 r1: the fixture scan enumerates `../` candidates AT `ref` via one `git grep -nI --full-name` — the extract materializes the ref's tree, so an untracked dist/ or a post-tag fix can't false-refuse or evade the way a working-tree walk did. Each candidate path is then judged by the same isShippedEntry/literalEscapesInLine core PKG-HEALTH-10 uses.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1502: step 7 — remediation entries, docs, deviations, generated indexes</item>
  <item>RFC-1502: review r1 — fix-cut rollback on FLOW-CUT-12/13, populated steps[], hook validation, GIT_* env scrub</item>
  <item>RFC-1517: add preflight-extract-gates — FLOW-PUB-01 changelog check at ref plus shared PKG-HEALTH-10 fixture-path scan for RFC-1517</item>
  <item>ADR-0131: pkg-health-10 suppression on the line above the literal

literalEscapesInLine accepts a // pkg-health-10: comment directly above the literal (one-line reach); the publish at-ref scan fetches that line via git show only for candidate lines; bin/cli.ts drops its prettier-ignore lines.</item>
  <item>RFC-1574: close review REVIEW-CODE-2026-11-12-05 findings

Step (3b) judges only paths the owner run changed, validates before staging, skips owners not runnable without an engine build, runs ecosystem.manifest.generate last; e2e log write guarded and run-stamped; Unhandled Errors rule out timeout-only; lost-run wait test; publish pre-filter comment. RFC-1574/1575/1576 record DEV-1..8.</item>
  <history>RFC-1491, RFC-1499, RFC-1502</history>
</CHANGE_SUMMARY>
*/

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { WorkspaceIO } from "../../src/types.ts";
import {
  fixtureScanSkipped,
  isShippedEntry,
  literalEscapesInLine,
  parseHealthScanConfig,
  type FixtureEscape,
} from "../core/handlers/package-health.ts";
import { git, gitCommit } from "./git.ts";
import { runFlowScript, type FlowScriptResult } from "./scripts.ts";
import type { ReleaseLine } from "./release-lines.ts";

export interface PublicationRow {
  tag: string;
  line: string;
  status: "published" | "failed" | "skipped-baseline" | "pending";
  dest: string | null;
  verify: FlowScriptResult | null;
  reconciled: boolean;
  destHead: string | null;
  /** FLOW-PUSH-05 detail when status === "failed". */
  error?: string;
}

/** `destBase`/`destName` from extract.config.yaml, anchored at dirname(primary) (resolveDest parity). */
export async function resolveExtractDest(
  primary: string,
  io: WorkspaceIO,
  line: ReleaseLine,
): Promise<string | null> {
  const dir = line.paths[0];
  if (dir === undefined) return null;
  const configPath = join(primary, dir, "extract.config.yaml");
  if (!(await io.exists(configPath))) return null;
  const raw = await io.readFile(configPath);
  const unquote = (v: string | undefined): string | undefined =>
    v?.replace(/^["']|["']$/g, "");
  const destBase = unquote(raw.match(/^destBase:\s*(\S+)\s*$/m)?.[1]);
  const destName = unquote(raw.match(/^destName:\s*(\S+)\s*$/m)?.[1]);
  if (destName === undefined) return null;
  return resolve(
    dirname(primary),
    destBase ?? "packages",
    destName,
  );
}

/** The annotation's `level:` field — baseline tags are never published. */
export async function tagAnnotationLevel(
  repoRoot: string,
  io: WorkspaceIO,
  tag: string,
): Promise<string | null> {
  const result = await git(repoRoot, io, [
    "for-each-ref",
    `refs/tags/${tag}`,
    "--format=%(contents)",
  ]);
  if (result.exitCode !== 0) return null;
  return result.stdout.match(/^level:\s*(\S+)\s*$/m)?.[1] ?? null;
}

interface PreflightFailure {
  step: "preflight-extract-gates";
  ruleId: "FLOW-PUB-01" | "PKG-HEALTH-10";
  detail: string;
}

const REGEXP_META = /[.*+?^${}()|[\]\\]/g;

/**
 * Keep-a-Changelog emits both `## [v]` release headings AND bare `[v]: <url>`
 * link references at the file's foot — a substring `[v]` check passes a
 * changelog that only links the version. The gate therefore anchors on a
 * heading line (`## [v]` or `## v`); a missing file has no section.
 */
export function hasChangelogSection(changelog: string | null, version: string): boolean {
  if (changelog === null) return false;
  const v = version.replace(REGEXP_META, "\\$&");
  return new RegExp(`^#{1,6}\\s+(?:\\[${v}\\]|${v})(?=\\s|$)`, "m").test(changelog);
}

/**
 * RFC-1517 `preflight-extract-gates`: refuse publish-blocking defects that are
 * decidable on the source repository before any repo-extract spawn (F-0064,
 * F-0072). Both checks fail open on unreadable inputs — the post-extract
 * changelog gate in scripts/verify-extract.mjs stays as defense in depth.
 *
 * - changelog gate — the line's `CHANGELOG.md` AT `ref` must contain
 *   `[<version>]` for the package.json version AT `ref` (the working tree
 *   lags a just-created release commit; git object reads are the correct
 *   source). Refusal FLOW-PUB-01 names file, expected section, ordering rule.
 * - fixture-path scan — every file the extract ships (derived from the same
 *   extract.config.yaml keys repo-extract consumes) is scanned for `../`
 *   literals escaping the package root through the shared
 *   `scanFixturePathEscapes` literal core; each escape refuses PKG-HEALTH-10
 *   at file:line.
 */
async function preflightExtractGates(
  primary: string,
  io: WorkspaceIO,
  opts: { line: ReleaseLine; ref: string },
): Promise<PreflightFailure | null> {
  const { line, ref } = opts;
  const dir = line.paths[0];
  if (dir === undefined) return null;

  const configPath = join(primary, dir, "extract.config.yaml");
  let configRaw: string | null = null;
  try {
    configRaw = await io.readFile(configPath);
  } catch {
    configRaw = null;
  }
  const projectDirRel =
    configRaw?.match(/^projectDir:\s*(\S+)\s*$/m)?.[1]?.replace(/^["']|["']$/g, "") ?? dir;
  const projectRoot = resolve(primary, projectDirRel);

  // Changelog gate — read both files at `ref` so the checked content is
  // exactly what the extract will ship.
  const show = async (rel: string): Promise<string | null> => {
    const res = await git(primary, io, ["show", `${ref}:${rel}`]);
    return res.exitCode === 0 ? res.stdout : null;
  };
  const pkgJsonRaw = await show(`${projectDirRel}/package.json`);
  let version: string | null = null;
  if (pkgJsonRaw !== null) {
    try {
      const parsed = JSON.parse(pkgJsonRaw) as { version?: unknown };
      version = typeof parsed.version === "string" ? parsed.version : null;
    } catch {
      version = null;
    }
  }
  const changelogRaw = await show(`${projectDirRel}/CHANGELOG.md`);
  // Parity with the post-extract gate: an absent CHANGELOG.md is a parity-note
  // skip, not a refusal; an unreadable/non-string version cannot yield the
  // expected section, so the same blind spot the post-extract gate carries is
  // preserved rather than diverged.
  if (version !== null && changelogRaw !== null && !hasChangelogSection(changelogRaw, version)) {
    return {
      step: "preflight-extract-gates",
      ruleId: "FLOW-PUB-01",
      detail:
        `${projectDirRel}/CHANGELOG.md has no [${version}] release section; ` +
        `write the version section before publishing (packages/AGENTS.md publish-order rule). repo-extract was NOT spawned.`,
    };
  }

  // Fixture-path scan — enumerate `../` candidates AT `ref` via one
  // `git grep` (the extract materializes the ref's tree, so the scan sees
  // exactly what ships: untracked dist/ output and post-tag fixes are both
  // handled correctly). `-I` skips binary files; each matched path is then
  // judged by the same shipped-entry predicate + literal matcher
  // PKG-HEALTH-10 uses on the working tree.
  const scanCfg = parseHealthScanConfig(configRaw);
  const grep = await git(primary, io, [
    "grep",
    "-n",
    "-I",
    "--full-name",
    "-e",
    "\\.\\./",
    ref,
    "--",
    projectDirRel,
  ]);
  const escapes: FixtureEscape[] = [];
  const atRefLines = new Map<string, string[]>();
  if (grep.exitCode === 0) {
    for (const row of grep.stdout.split("\n")) {
      if (!row.startsWith(`${ref}:`)) continue;
      const rest = row.slice(ref.length + 1);
      const m = rest.match(/^(.+?):(\d+):(.*)$/);
      if (!m) continue;
      const [, relPath, lineNo, text] = m;
      const rel = relPath!.slice(projectDirRel.length + 1);
      const name = rel.split("/").pop()!;
      if (
        scanCfg.suppressions.has(rel) ||
        fixtureScanSkipped(rel) ||
        !isShippedEntry(rel, name, false, scanCfg)
      ) {
        continue;
      }
      const fileDir = dirname(join(projectRoot, rel));
      // Cheap pre-filter: most grep hits are suppressed or in-root on their own
      // line — only real candidates pay for the at-ref previous-line fetch.
      const sameLine = literalEscapesInLine(rel, text!, Number(lineNo), fileDir, projectRoot);
      if (sameLine.length === 0) continue;
      // ADR-0131: the suppression may sit on the line above — fetched from
      // the ref only for candidate lines (rare), cached per file.
      let lines = atRefLines.get(relPath!);
      if (lines === undefined) {
        const shown = await git(primary, io, ["show", `${ref}:${relPath}`]);
        lines = shown.exitCode === 0 ? shown.stdout.split("\n") : [];
        atRefLines.set(relPath!, lines);
      }
      escapes.push(
        ...literalEscapesInLine(
          rel,
          text!,
          Number(lineNo),
          fileDir,
          projectRoot,
          lines[Number(lineNo) - 2],
        ),
      );
    }
  }
  escapes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  if (escapes.length > 0) {
    const listed = escapes
      .slice(0, 5)
      .map(
        (e) =>
          `${projectDirRel}/${e.file}:${e.line} fixture path "${e.literal}" ` +
          `resolves outside ${projectDirRel}`,
      )
      .join("; ");
    const more = escapes.length > 5 ? ` (+${escapes.length - 5} more)` : "";
    return {
      step: "preflight-extract-gates",
      ruleId: "PKG-HEALTH-10",
      detail:
        `${listed}${more}; shipped files must reference paths inside the package root (same-line "// pkg-health-10:" suppression or pkgHealth10Suppressions in extract.config.yaml for justified non-path literals). ` +
        `repo-extract was NOT spawned.`,
    };
  }
  return null;
}

/**
 * Publish one package-line tag: extract at the tag ref, verify via the hook,
 * push the destination. A non-fast-forward rejection reconciles once with
 * fetch + ours-merge (local tree is the authoritative export), never force.
 */
export async function publishTag(
  primary: string,
  io: WorkspaceIO,
  opts: { line: ReleaseLine; tag: string },
): Promise<PublicationRow> {
  const { line, tag } = opts;
  const row: PublicationRow = {
    tag,
    line: line.id,
    status: "published",
    dest: null,
    verify: null,
    reconciled: false,
    destHead: null,
  };

  const dir = line.paths[0];
  if (dir === undefined) {
    row.status = "failed";
    row.error = `line ${line.id} has no package directory`;
    return row;
  }

  const level = await tagAnnotationLevel(primary, io, tag);
  if (level === "baseline") {
    row.status = "skipped-baseline";
    return row;
  }

  // 0. preflight-extract-gates (RFC-1517) — refuse source-derivable
  // publish-blocking defects before the repo-extract spawn.
  const preflight = await preflightExtractGates(primary, io, { line, ref: tag });
  if (preflight !== null) {
    row.status = "failed";
    row.error = `${preflight.step}: ${preflight.ruleId} — ${preflight.detail}`;
    return row;
  }

  // 1. Extract — the binary lives in the adopting repository's own install.
  // node_modules/.bin/repo-extract is a POSIX sh shim even on Windows (the
  // package ships one file), so the extract runs through `sh` — same seam
  // flow scripts already use — rather than spawning the shim as an exec.
  const extract = await io.exec(
    "sh",
    [
      join(primary, "node_modules", ".bin", "repo-extract"),
      "--config", `${dir}/extract.config.yaml`, "--ref", tag, "--no-push",
    ],
    { cwd: primary },
  );
  if (extract.exitCode !== 0) {
    row.status = "failed";
    row.error = `repo-extract failed (exit ${extract.exitCode}): ${extract.stderr.trim().split("\n").slice(-1)[0] ?? ""}`;
    return row;
  }

  // 2. Destination — same resolution as the retired publish-forge.mjs (RFC-1499).
  const dest = await resolveExtractDest(primary, io, line);
  row.dest = dest;
  if (dest === null || !(await io.exists(join(dest, ".git")))) {
    row.status = "failed";
    row.error = `extract destination could not be resolved for ${tag} (destName in ${dir}/extract.config.yaml)`;
    return row;
  }

  // 3. Verify hook — absent script reports skipped, a failure stops here.
  const verify = await runFlowScript(io, "extract-verify", {
    primary,
    cwd: primary,
    env: {
      FORGE_FLOW_EXTRACT_DEST: dest,
      FORGE_FLOW_TAG: tag,
      FORGE_FLOW_LINE: line.id,
    },
  });
  row.verify = verify;
  if (verify.status === "failed") {
    row.status = "failed";
    row.error = `extract-verify failed (exit ${verify.exitCode}): ${verify.stderrTail}`;
    return row;
  }

  // 4. Push the extract destination — `branch --show-current` first, the
  // rev-parse fallback keeps a detached export HEAD pushable.
  const branchShown = await git(dest, io, ["branch", "--show-current"]);
  const branch =
    branchShown.stdout.trim() ||
    (await git(dest, io, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const firstPush = await git(dest, io, ["push", "-u", "origin", branch]);
  if (firstPush.exitCode !== 0) {
    const out = `${firstPush.stdout}\n${firstPush.stderr}`;
    if (!/non-fast-forward|\(fetch first\)/i.test(out)) {
      row.status = "failed";
      row.error = `destination push failed: ${out.trim().split("\n").slice(-1)[0] ?? ""}`;
      return row;
    }
    // Reconcile once — the exported tree is authoritative; remote history
    // is preserved. Never force-push.
    row.reconciled = true;
    await git(dest, io, ["fetch", "origin"]);
    const merge = await gitCommit(
      dest,
      io,
      [
        "merge",
        "-s",
        "ours",
        "--allow-unrelated-histories",
        "-m",
        "merge: reconcile remote export history (local tree is authoritative export)",
        `origin/${branch}`,
      ],
      "publish",
    );
    if (merge.exitCode !== 0) {
      row.status = "failed";
      row.error = `reconcile merge failed: ${merge.stderr.trim().split("\n").slice(-1)[0] ?? ""}`;
      return row;
    }
    const retry = await git(dest, io, ["push", "-u", "origin", branch]);
    if (retry.exitCode !== 0) {
      row.status = "failed";
      row.error = `destination push failed after reconcile: ${retry.stderr.trim().split("\n").slice(-1)[0] ?? ""}`;
      return row;
    }
  }

  row.destHead = (await git(dest, io, ["rev-parse", "HEAD"])).stdout.trim();
  return row;
}

export interface LineVerifyResult {
  ok: boolean;
  /** True when the line carries no extract.config.yaml — nothing to verify. */
  skipped: boolean;
  /** FLOW-CUT-13 detail when ok === false. */
  detail: string;
}

/**
 * Pre-tag extract verification (RFC-1502): extract the line at `ref` into a
 * scratch directory under os.tmpdir() — `--dest` redirects the output, the
 * configured destination is never written — then run the extract-verify
 * hook against the scratch. The scratch is always removed. A line without
 * an extract.config.yaml is skipped (nothing publishable to verify).
 */
export async function verifyLineAtRef(
  primary: string,
  io: WorkspaceIO,
  opts: { line: ReleaseLine; ref: string },
): Promise<LineVerifyResult> {
  const { line, ref } = opts;
  const dir = line.paths[0];
  if (dir === undefined || !(await io.exists(join(primary, dir, "extract.config.yaml")))) {
    return { ok: true, skipped: true, detail: "" };
  }
  // preflight-extract-gates (RFC-1517) — source-derivable refusals before
  // the scratch extract: changelog section at ref, fixture-path escapes.
  const preflight = await preflightExtractGates(primary, io, { line, ref });
  if (preflight !== null) {
    return {
      ok: false,
      skipped: false,
      detail: `${preflight.step}: ${preflight.ruleId} — ${preflight.detail}`,
    };
  }
  const scratch = await mkdtemp(join(tmpdir(), "flow-extract-"));
  try {
    const extractBin = join(primary, "node_modules", ".bin", "repo-extract");
    let extract;
    try {
      // The .bin shim is a POSIX sh script — exec it through sh so the
      // verification extract works on Windows runners as well as POSIX.
      extract = await io.exec(
        "sh",
        [
          extractBin,
          "--config", `${dir}/extract.config.yaml`, "--ref", ref, "--dest", scratch, "--no-push",
        ],
        { cwd: primary },
      );
    } catch (error) {
      return {
        ok: false,
        skipped: false,
        detail: `repo-extract could not run at ${extractBin}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (extract.exitCode !== 0) {
      const last = extract.stderr.trim().split("\n").filter((l) => l.length > 0).slice(-1)[0] ?? "";
      return { ok: false, skipped: false, detail: `repo-extract failed (exit ${extract.exitCode}): ${last}` };
    }
    const verify = await runFlowScript(io, "extract-verify", {
      primary,
      cwd: primary,
      env: {
        FORGE_FLOW_EXTRACT_DEST: scratch,
        FORGE_FLOW_REF: ref,
        FORGE_FLOW_LINE: line.id,
      },
    });
    if (verify.status === "failed") {
      return { ok: false, skipped: false, detail: `extract-verify failed (exit ${verify.exitCode}): ${verify.stderrTail}` };
    }
    return { ok: true, skipped: false, detail: "" };
  } finally {
    // Scratch removal is best-effort — a removal failure must not mask a
    // computed verification result (nor crash the cut after ok was decided).
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
