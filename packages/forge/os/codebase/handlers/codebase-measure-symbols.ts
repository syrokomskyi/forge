/*
<MODULE_CONTRACT>
<purpose>
RFC-1581: symbol pass for codebase.measure — counts classes / functions /
methods in the TS/JS family (and .astro frontmatter) via a lazily imported
TypeScript parser. When `typescript` is not importable the pass returns an
empty result with a `typescript-unavailable` skip marker — never a regex
estimate, never a crash.
</purpose>
<non-goals>
  <item>Does not count symbols in non-TS languages — they stay line-only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1581: initial lazy-AST symbol pass.</item>
  <item>RFC-1581: add codebase.measure project-scale measurement command</item>
</CHANGE_SUMMARY>
*/

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface FileSymbols {
  classes: number;
  functions: number;
  methods: number;
}

export interface SymbolPassResult {
  byFile: Map<string, FileSymbols>;
  skipped: string[];
}

interface TsApi {
  createSourceFile(
    fileName: string,
    sourceText: string,
    languageVersion: unknown,
    setParentNodes?: boolean,
    scriptKind?: unknown,
  ): unknown;
  ScriptTarget: { Latest: unknown };
  ScriptKind: { TS: unknown; TSX: unknown; JS: unknown; JSX: unknown };
  SyntaxKind: Record<string, number>;
  isClassDeclaration(node: unknown): boolean;
  isClassExpression(node: unknown): boolean;
  isFunctionDeclaration(node: unknown): boolean;
  isFunctionExpression(node: unknown): boolean;
  isArrowFunction(node: unknown): boolean;
  isMethodDeclaration(node: unknown): boolean;
  forEachChild(node: unknown, cb: (n: unknown) => void): void;
}

/** .astro: extract the frontmatter script (between the first two `---` fences). */
function astroFrontmatter(content: string): string | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") return lines.slice(1, i).join("\n");
  }
  return null;
}

function scriptKindFor(ts: TsApi, path: string): unknown {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (
    path.endsWith(".jsx") ||
    path.endsWith(".mjs") ||
    path.endsWith(".cjs") ||
    path.endsWith(".js")
  ) {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.TS;
}

export async function measureSymbols(
  files: Array<{ path: string; language: string; content: string }>,
  workspaceRoot: string,
): Promise<SymbolPassResult> {
  const byFile = new Map<string, FileSymbols>();
  const skipped: string[] = [];

  if (files.length === 0) return { byFile, skipped };

  let ts: TsApi;
  try {
    // Resolve against the measured workspace, not this package — forge carries
    // no typescript dependency of its own, so a bare import would never find it.
    const requireFromRoot = createRequire(join(workspaceRoot, "package.json"));
    const tsPath = requireFromRoot.resolve("typescript");
    ts = (await import(pathToFileURL(tsPath).href)) as unknown as TsApi;
  } catch {
    skipped.push("typescript-unavailable");
    return { byFile, skipped };
  }

  for (const file of files) {
    const source = file.language === "Astro" ? astroFrontmatter(file.content) : file.content;
    if (source == null || source.trim().length === 0) continue;
    try {
      const sf = ts.createSourceFile(
        file.path,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKindFor(ts, file.path),
      );
      const counts: FileSymbols = { classes: 0, functions: 0, methods: 0 };
      const visit = (node: unknown): void => {
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) counts.classes++;
        else if (ts.isMethodDeclaration(node)) counts.methods++;
        else if (
          ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node)
        ) {
          counts.functions++;
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      byFile.set(file.path, counts);
    } catch {
      skipped.push(`parse-failure:${file.path}`);
    }
  }

  return { byFile, skipped };
}
