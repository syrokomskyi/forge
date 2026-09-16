/*
<MODULE_CONTRACT>
<purpose>TsWorkspaceModel — single workspace scan feeding all ts.*.validate rules.
Expands package globs, walks each package once, parses package.json/tsconfig*.json
and the workspace-root tsconfig.base.json, and extracts AST facts per source file
via ts.createSourceFile (syntactic parse only, no ts.Program).</purpose>

<non-goals>
  <item>Does not emit diagnostics — rules consume facts and decide.</item>
  <item>Does not parse pnpm-workspace.yaml — package globs come from the caller (default packages + services dirs).</item>
  <item>Does not follow symlinked directories — prevents cycles and double-scans.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1099: initial workspace model — one deep module owns workspace discovery and AST fact extraction for all six ts.*.validate commands.</item>
  <item>RFC-1099: steps 7+9 — self-application green + review fixes</item>
</CHANGE_SUMMARY>
*/

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";
import { EXCLUDE_DIRS, EXCLUDE_SUFFIXES } from "@warpgogol/werkstatt-shared/share/import-scan";

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
}

export interface TsconfigJson {
  compilerOptions?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ImportKind = "static" | "dynamic" | "side-effect" | "type-only" | "require";

export interface ImportFact {
  specifier: string;
  kind: ImportKind;
  line: number;
}

export interface ReExportFact {
  specifier: string;
  line: number;
}

export interface AnyRefFact {
  kind: "annotation" | "as-cast";
  line: number;
  /** True when the any's line carries an eslint-disable or @ts-expect-error comment. */
  suppressed: boolean;
}

export interface SuppressionFact {
  directive: "ts-ignore" | "ts-expect-error";
  line: number;
  justified: boolean;
}

export interface ExportedFunctionFact {
  name: string;
  hasReturnType: boolean;
  paramsTyped: boolean;
  line: number;
}

export interface ParsedSourceFile {
  path: string;
  imports: ImportFact[];
  reExports: ReExportFact[];
  anyRefs: AnyRefFact[];
  suppressions: SuppressionFact[];
  exportedFunctions: ExportedFunctionFact[];
}

export interface TsWorkspacePackage {
  dir: string;
  packageJson: PackageJson;
  tsconfig: TsconfigJson | null;
  /** True when tsconfig.json exists on disk but failed to parse. */
  tsconfigMalformed: boolean;
  /** All file paths under the package dir (relative to workspaceRoot), excluding node_modules. */
  existingFiles: Set<string>;
  sourceFiles: ParsedSourceFile[];
}

export interface TsWorkspaceModel {
  packages: TsWorkspacePackage[];
  baseTsconfig: TsconfigJson | null;
  scannedFiles: number;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

function isSourceFile(name: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function isExcludedFile(name: string): boolean {
  return EXCLUDE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/** tsconfig.json is JSONC — comments and trailing commas are legal. Parse via the TS config parser. */
async function readTsconfigFile(path: string): Promise<TsconfigJson | null> {
  try {
    const content = await readFile(path, "utf8");
    const parsed = ts.parseConfigFileTextToJson(path, content);
    if (parsed.error) return null;
    return (parsed.config ?? null) as TsconfigJson | null;
  } catch {
    return null;
  }
}

async function expandPackageGlobs(workspaceRoot: string, globs: string[]): Promise<string[]> {
  const dirs: string[] = [];
  for (const glob of globs) {
    const trimmed = glob.trim();
    if (!trimmed) continue;
    if (trimmed.endsWith("/*")) {
      const parent = join(workspaceRoot, trimmed.slice(0, -2));
      const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          dirs.push(join(parent, entry.name));
        }
      }
    } else {
      dirs.push(join(workspaceRoot, trimmed));
    }
  }
  return dirs;
}

function lineOf(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function commentText(text: string, range: ts.CommentRange): string {
  return text.slice(range.pos, range.end);
}

function extractSuppressions(sourceFile: ts.SourceFile, text: string): SuppressionFact[] {
  const facts: SuppressionFact[] = [];
  const seen = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (node === sourceFile) {
      ts.forEachChild(node, visit);
      return;
    }
    const leading = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
    const trailing = ts.getTrailingCommentRanges(text, node.getEnd()) ?? [];
    for (const range of [...leading, ...trailing]) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const body = commentText(text, range);
      const match = /@(ts-ignore|ts-expect-error)/.exec(body);
      if (!match) continue;
      const afterDirective = body.slice(match.index + match[0].length).trim();
      // Justified when the directive comment carries text beyond the directive
      // itself, or a separate comment sits directly above it in the same group.
      const idx = leading.indexOf(range);
      const justified = afterDirective.length > 0 || idx > 0;
      facts.push({
        directive: match[1] as SuppressionFact["directive"],
        line: lineOf(sourceFile, range.pos),
        justified,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return facts;
}

function extractFacts(sourceFile: ts.SourceFile, text: string): Omit<ParsedSourceFile, "path"> {
  const imports: ImportFact[] = [];
  const reExports: ReExportFact[] = [];
  const anyRefs: AnyRefFact[] = [];
  const exportedFunctions: ExportedFunctionFact[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const kind: ImportKind = !node.importClause
        ? "side-effect"
        : node.importClause.isTypeOnly
          ? "type-only"
          : "static";
      imports.push({
        specifier: node.moduleSpecifier.text,
        kind,
        line: lineOf(sourceFile, node.getStart()),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      reExports.push({
        specifier: node.moduleSpecifier.text,
        line: lineOf(sourceFile, node.getStart()),
      });
    } else if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (expr.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          imports.push({
            specifier: arg.text,
            kind: "dynamic",
            line: lineOf(sourceFile, node.getStart()),
          });
        }
      } else if (ts.isIdentifier(expr) && expr.text === "require") {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          imports.push({
            specifier: arg.text,
            kind: "require",
            line: lineOf(sourceFile, node.getStart()),
          });
        }
      }
    }

    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const parent = node.parent;
      const line = lineOf(sourceFile, node.getStart());
      const lineText = text.split("\n")[line - 1] ?? "";
      const suppressed =
        lineText.includes("eslint-disable") || lineText.includes("@ts-expect-error");
      if (parent && ts.isAsExpression(parent)) {
        anyRefs.push({ kind: "as-cast", line, suppressed });
      } else {
        anyRefs.push({ kind: "annotation", line, suppressed });
      }
    }

    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const isExported = modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
    );

    if (isExported && ts.isFunctionDeclaration(node)) {
      exportedFunctions.push({
        name: node.name?.text ?? "<default>",
        hasReturnType: node.type !== undefined,
        paramsTyped: node.parameters.every((p) => p.type !== undefined),
        line: lineOf(sourceFile, node.getStart()),
      });
    } else if (isExported && ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          const fn = decl.initializer;
          exportedFunctions.push({
            name: ts.isIdentifier(decl.name) ? decl.name.text : "<destructured>",
            hasReturnType: fn.type !== undefined,
            paramsTyped: fn.parameters.every((p) => p.type !== undefined),
            line: lineOf(sourceFile, decl.getStart()),
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    imports,
    reExports,
    anyRefs,
    suppressions: extractSuppressions(sourceFile, text),
    exportedFunctions,
  };
}

interface WalkResult {
  sourceFiles: { absPath: string; relPath: string }[];
  existingFiles: Set<string>;
}

async function walkPackageDir(pkgDir: string, workspaceRoot: string): Promise<WalkResult> {
  const result: WalkResult = { sourceFiles: [], existingFiles: new Set() };
  await walkPackageFiltered(pkgDir, workspaceRoot, pkgDir, result);
  return result;
}

async function walkPackageFiltered(
  dir: string,
  workspaceRoot: string,
  pkgDir: string,
  result: WalkResult,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      await walkPackageFiltered(fullPath, workspaceRoot, pkgDir, result);
    } else if (entry.isFile()) {
      const relPath = relative(workspaceRoot, fullPath);
      result.existingFiles.add(relPath);
      const relToPkg = relative(pkgDir, fullPath);
      const underExcludedDir = relToPkg
        .split("/")
        .slice(0, -1)
        .some((segment) => EXCLUDE_DIRS.has(segment));
      if (!underExcludedDir && isSourceFile(entry.name) && !isExcludedFile(entry.name)) {
        result.sourceFiles.push({ absPath: fullPath, relPath });
      }
    }
  }
}

export async function buildWorkspaceModel(
  workspaceRoot: string,
  globs: string[] = ["packages/*", "services/*"],
): Promise<TsWorkspaceModel> {
  const pkgDirs = await expandPackageGlobs(workspaceRoot, globs);
  const packages: TsWorkspacePackage[] = [];
  let scannedFiles = 0;

  for (const pkgDir of pkgDirs) {
    const packageJson = await readJsonFile<PackageJson>(join(pkgDir, "package.json"));
    if (!packageJson) continue;

    const tsconfig = await readTsconfigFile(join(pkgDir, "tsconfig.json"));
    const { sourceFiles, existingFiles } = await walkPackageDir(pkgDir, workspaceRoot);
    const tsconfigMalformed =
      tsconfig === null && existingFiles.has(`${relative(workspaceRoot, pkgDir)}/tsconfig.json`);

    const parsed: ParsedSourceFile[] = [];
    for (const file of sourceFiles) {
      const text = await readFile(file.absPath, "utf8").catch(() => "");
      const sourceFile = ts.createSourceFile(
        file.relPath,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      parsed.push({ path: file.relPath, ...extractFacts(sourceFile, text) });
      scannedFiles++;
    }

    packages.push({
      dir: relative(workspaceRoot, pkgDir),
      packageJson,
      tsconfig,
      tsconfigMalformed,
      existingFiles,
      sourceFiles: parsed,
    });
  }

  const baseTsconfig = await readTsconfigFile(join(workspaceRoot, "tsconfig.base.json"));

  return { packages, baseTsconfig, scannedFiles };
}
