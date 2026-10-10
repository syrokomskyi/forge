/*
<MODULE_CONTRACT>
<purpose>RFC-1253: compass.docs.scaffold kernel handler — materialize the six-document Compass corpus in a consumer workspace from real repository state (workspaces, stack profile, resolved Compass policy), write or merge bindings.paths.compassDocs, and stay byte-stable on reruns.</purpose>
<non-goals>
  <item>Do not invent authored intent — requirements/development-plan/verification-plan ship as TODO skeletons with status draft.</item>
  <item>Do not overwrite existing corpus files — only knowledge-graph.xml gains missing workspace nodes; everything else is skipped verbatim.</item>
  <item>Do not import from @warpgogol/* runtime packages — forge-internal modules only.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Canonical docs map onto binding paths by basename; unmapped docs fall back to docs/&lt;name&gt;.xml — consumer layouts never rewritten.</item>
  <item>Final binding = declared set ∪ resolved doc paths; absent binding gets the default six.</item>
  <item>forge.yaml write goes through applyForgeYamlPatches with the serializeForgeConfig fallback + warning — same comment-preserving contract as forge.upgrade.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1253: created — six-doc scaffold, KG node merge, binding patch, dry-run manifest.</item>
  <item>Derive workspace node id prefixes from directory location (apps/→app-, packages/→pkg-, services/→svc-, dotted elsewhere) — COMPASS-DOC-02 resolves prefixes to paths, so type-derived ids failed validation on apps/ repos (consumer field report).</item>
</CHANGE_SUMMARY>
*/

import { basename, dirname, resolve } from "node:path";
import { readFileSync } from "../../../src/utils/sync-fs.ts";
import {
  applyForgeYamlPatches,
  loadForgeConfig,
  resolveBinding,
  resolveForgePackageRoot,
  serializeForgeConfig,
  type ForgeConfig,
} from "../../../src/config/forge-config.ts";
import { stringify as stringifyYaml } from "yaml";
import { resolveIo } from "../../../src/utils/io.ts";
import { resolveCompassPolicy } from "../policy.ts";
import {
  discoverWorkspaces,
  type WorkspaceDir,
} from "../../../src/onboarding/workspace-discovery.ts";
import {
  CANONICAL_CORPUS_DOCS,
  COMPASS_DOCS_SCHEMA_ID,
  DEFAULT_COMPASS_DOCS_BINDING,
  type CanonicalCorpusDoc,
} from "../../../src/onboarding/compass-docs/constants.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const TEMPLATES_DIR = resolve(
  resolveForgePackageRoot(import.meta.dirname),
  "src",
  "onboarding",
  "templates",
  "compass-docs",
);

export interface ScaffoldFileAction {
  path: string;
  action: "created" | "merged" | "skipped" | "failed";
  detail?: string;
}

export interface CompassDocsScaffoldResult {
  command: "compass.docs.scaffold";
  status: "ok" | "partial" | "fail";
  dryRun: boolean;
  schema: typeof COMPASS_DOCS_SCHEMA_ID;
  files: ScaffoldFileAction[];
  binding: { declared: string[]; final: string[]; written: boolean; fallback: boolean };
}

function loadTemplate(name: CanonicalCorpusDoc): string {
  return readFileSync(resolve(TEMPLATES_DIR, `${name}.xml`), "utf8");
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function render(template: string, slots: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(slots)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

/** <item> list lines at 6-space indent for the scan-policy slots. */
function itemLines(values: readonly string[]): string {
  return values.map((v) => `      <item>${xmlEscape(v)}</item>`).join("\n");
}

interface ScaffoldWorkspace {
  id: string;
  type: string;
  dir: string;
  name: string;
}

/**
 * COMPASS-DOC-02 resolves workspace ids by top-level-directory convention:
 * app-* names apps/<rest>, pkg-* names packages/<rest>, svc-* names
 * services/<rest>. Deriving the prefix from the detected workspace type breaks
 * that contract on repos whose apps/ workspaces miss content detection — a
 * non-astro, non-docker workspace under apps/ detects as "package" and would
 * emit pkg-<name>, which the validator resolves to a packages/<name> path that
 * does not exist. Derive the prefix from the location instead; locations the
 * prefixed convention cannot express (nested deeper than <dir>/<name>, or
 * outside apps/packages/services) fall back to the dotted semantic-id form —
 * DOC-02 resolves it through its first two segments or leaves unmapped
 * prefixes unchecked, and DOC-01 still verifies the real path via <path>.
 */
const WORKSPACE_ID_PREFIX: Record<string, string> = {
  apps: "app",
  packages: "pkg",
  services: "svc",
};

function workspaceNodeId(dir: WorkspaceDir): string {
  const segments = dir.path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.length === 2) {
    const prefix = WORKSPACE_ID_PREFIX[segments[0]!];
    if (prefix) return `${prefix}-${segments[1]}`;
  }
  return segments.join(".");
}

function readPackageName(
  root: string,
  relDir: string,
  ioRead: (p: string) => string | null,
): string {
  const raw = ioRead(resolve(root, relDir, "package.json"));
  if (!raw) return basename(relDir);
  try {
    return String(JSON.parse(raw)["name"] ?? basename(relDir));
  } catch {
    return basename(relDir);
  }
}

function collectWorkspaces(workspaceRoot: string, config: ForgeConfig): ScaffoldWorkspace[] {
  const dirs = discoverWorkspaces(
    workspaceRoot,
    config.profile?.workspaceTypes?.length ? config.profile.workspaceTypes : undefined,
    config.bindings?.workspaces?.skipDirs,
  );
  return dirs.map((dir) => ({
    id: workspaceNodeId(dir),
    type: dir.type,
    dir: dir.path,
    name: readPackageName(workspaceRoot, dir.path, (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    }),
  }));
}

function kgNode(ws: ScaffoldWorkspace): string {
  return [
    `    <node id="${xmlEscape(ws.id)}" type="workspace">`,
    `      <name>${xmlEscape(ws.name)}</name>`,
    `      <path>\`${xmlEscape(ws.dir)}\`</path>`,
    `      <role>${xmlEscape(ws.type)} workspace.</role>`,
    `    </node>`,
  ].join("\n");
}

/**
 * Merge missing workspace <node> entries into an existing knowledge-graph.xml.
 * Returns null when the file lacks a </nodes> anchor — caller treats that as
 * a parse failure and leaves bytes untouched.
 */
function mergeKgNodes(source: string, workspaces: ScaffoldWorkspace[]): string | null {
  const anchor = source.indexOf("</nodes>");
  if (anchor === -1) return null;
  const missing = workspaces.filter((ws) => !source.includes(`id="${ws.id}"`));
  if (missing.length === 0) return source;
  const insertion = missing.map(kgNode).join("\n") + "\n";
  return source.slice(0, anchor) + insertion + source.slice(anchor);
}

function rootPackageJson(root: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function docPaths(declared: readonly string[]): Record<CanonicalCorpusDoc, string> {
  const byName = new Map<string, string>();
  for (const p of declared) {
    byName.set(basename(p), p);
  }
  const out = {} as Record<CanonicalCorpusDoc, string>;
  for (const name of CANONICAL_CORPUS_DOCS) {
    out[name] = byName.get(`${name}.xml`) ?? `docs/${name}.xml`;
  }
  return out;
}

export async function runCompassDocsScaffold(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<CompassDocsScaffoldResult>> {
  const io = resolveIo(context.io);
  const dryRun = context.dryRun || input.flags["dry-run"] === true;
  const { workspaceRoot, logger } = context;

  let config: ForgeConfig;
  try {
    config = loadForgeConfig(workspaceRoot, context.forgeRoot);
  } catch (err) {
    return {
      data: {
        command: "compass.docs.scaffold",
        status: "fail",
        dryRun,
        schema: COMPASS_DOCS_SCHEMA_ID,
        files: [],
        binding: { declared: [], final: [], written: false, fallback: false },
      },
      exitCode: 1,
      summary: `[compass.docs.scaffold] FAIL — forge.yaml missing or invalid: ${(err as Error).message}`,
      nextSteps: [
        {
          action: "Run `forge init` (or `forge create`) to create forge.yaml first.",
          kind: "required",
        },
      ],
    };
  }

  const declaredRaw = resolveBinding(config, "paths.compassDocs");
  const declared = (Array.isArray(declaredRaw) ? declaredRaw : []).filter(
    (p): p is string => typeof p === "string",
  );
  const bindingPaths = declared.length > 0 ? declared : DEFAULT_COMPASS_DOCS_BINDING;
  const targets = docPaths(bindingPaths);
  const workspaces = collectWorkspaces(workspaceRoot, config);
  const policy = resolveCompassPolicy(workspaceRoot, context.forgeRoot);
  const rootPkg = rootPackageJson(workspaceRoot);

  const files: ScaffoldFileAction[] = [];

  const slotsFor = (name: CanonicalCorpusDoc): Record<string, string> => {
    if (name === "knowledge-graph") {
      return {
        rootLinks: workspaces
          .map((ws) => `        <link rel="delegates-to" target="${xmlEscape(ws.id)}" />`)
          .join("\n"),
        workspaceNodes: workspaces.map(kgNode).join("\n"),
      };
    }
    if (name === "technology") {
      const engines = rootPkg["engines"] as Record<string, unknown> | undefined;
      return {
        nodeRange: xmlEscape(String(engines?.["node"] ?? ">=24 <25")),
        packageManager: xmlEscape(
          String(rootPkg["packageManager"] ?? "pnpm").split("@")[0] || "pnpm",
        ),
        profileId: xmlEscape(config.profile?.id ?? "unknown"),
        workspaceRows: workspaces
          .map(
            (ws) =>
              `    <workspace id="${xmlEscape(ws.id)}" type="${xmlEscape(ws.type)}">\n` +
              `      <name>${xmlEscape(ws.name)}</name>\n` +
              `      <path>\`${xmlEscape(ws.dir)}\`</path>\n` +
              `    </workspace>`,
          )
          .join("\n"),
      };
    }
    if (name === "source-markup") {
      return {
        fileExtensions: itemLines([...policy.fileExtensions]),
        scanRoots: itemLines([...policy.scanRoots]),
        testPatterns: itemLines([...policy.testPatterns]),
        ignoredDirs: itemLines([...policy.ignoredDirs]),
        ignoredDirPrefixes: itemLines([...policy.ignoredDirPrefixes]),
        highRiskPaths: itemLines([...policy.highRiskPaths]),
        excludedPaths: policy.excludedPaths
          .map((e) => `      <item pattern="${xmlEscape(e.pattern)}">${xmlEscape(e.reason)}</item>`)
          .join("\n"),
        idPattern: xmlEscape(policy.idPattern.source),
        layerRules: policy.layerRules
          .map(
            (r) =>
              `      <rule pattern="${xmlEscape(r.pattern)}" layer="${xmlEscape(r.layer)}" risk-class="${xmlEscape(r.risk)}" />`,
          )
          .join("\n"),
      };
    }
    return {};
  };

  for (const name of CANONICAL_CORPUS_DOCS) {
    const rel = targets[name];
    const abs = resolve(workspaceRoot, rel);
    if (await io.exists(abs)) {
      if (name === "knowledge-graph") {
        const source = await io.readFile(abs);
        const merged = mergeKgNodes(source, workspaces);
        if (merged === null) {
          files.push({
            path: rel,
            action: "failed",
            detail: "no </nodes> anchor — left untouched",
          });
          continue;
        }
        if (merged === source) {
          files.push({ path: rel, action: "skipped", detail: "all workspace nodes present" });
          continue;
        }
        if (!dryRun) {
          await io.writeFile(abs, merged);
        }
        files.push({
          path: rel,
          action: "merged",
          detail: `appended ${workspaces.filter((ws) => !source.includes(`id="${ws.id}"`)).length} workspace node(s)`,
        });
        continue;
      }
      files.push({ path: rel, action: "skipped", detail: "exists — authored content preserved" });
      continue;
    }
    const content = render(loadTemplate(name), slotsFor(name));
    if (!dryRun) {
      await io.mkdir(dirname(abs));
      await io.writeFile(abs, content);
    }
    files.push({ path: rel, action: "created" });
  }

  // Binding merge: declared set ∪ resolved doc paths (declared order first,
  // canonical order for additions) — subset declarations keep their custom
  // paths and gain only the missing canonical ones.
  const finalBinding = [...new Set([...declared, ...Object.values(targets)])];
  const bindingChanged =
    finalBinding.length !== declared.length || finalBinding.some((p, i) => declared[i] !== p);
  let bindingWritten = false;
  let bindingFallback = false;
  if (bindingChanged) {
    if (!dryRun) {
      const forgeYamlPath = resolve(workspaceRoot, "forge.yaml");
      const raw = await io.readFile(forgeYamlPath).catch(() => null);
      const patched =
        raw === null
          ? null
          : applyForgeYamlPatches(raw, [
              { path: ["bindings", "paths", "compassDocs"], value: finalBinding },
            ]);
      if (patched !== null) {
        await io.writeFile(forgeYamlPath, patched);
      } else {
        bindingFallback = true;
        logger.warn(
          "compass.docs.scaffold: forge.yaml patch failed — falling back to full serialization (schema-unknown keys may be dropped)",
        );
        await io.writeFile(forgeYamlPath, stringifyYaml(serializeForgeConfig(config)));
      }
    }
    bindingWritten = true;
  }

  const failed = files.filter((f) => f.action === "failed");
  const created = files.filter((f) => f.action === "created").length;
  const merged = files.filter((f) => f.action === "merged").length;
  const skipped = files.filter((f) => f.action === "skipped").length;
  const status = failed.length > 0 ? "partial" : "ok";

  return {
    data: {
      command: "compass.docs.scaffold",
      status,
      dryRun,
      schema: COMPASS_DOCS_SCHEMA_ID,
      files,
      binding: {
        declared,
        final: finalBinding,
        written: bindingWritten,
        fallback: bindingFallback,
      },
    },
    exitCode: failed.length > 0 ? 1 : 0,
    summary:
      `[compass.docs.scaffold] ${status} — created=${created} merged=${merged} skipped=${skipped}` +
      `${failed.length > 0 ? ` failed=${failed.length}` : ""}` +
      `${bindingWritten ? ` binding=${declared.length === 0 ? "written" : "merged"}` : ""}` +
      `${dryRun ? " (dry-run)" : ""}`,
    nextSteps: [
      {
        action:
          "Author the three draft skeletons (requirements.xml, development-plan.xml, verification-plan.xml) — TODO markers mark the fill-in surface.",
        kind: "optional",
      },
      {
        action: "Run `forge run compass.docs.validate` to check corpus integrity.",
        kind: "optional",
      },
      {
        action:
          "Run `forge agents.generate` to emit the read-first semantic-layer block into AGENTS.md.",
        kind: "optional",
      },
    ],
  };
}
