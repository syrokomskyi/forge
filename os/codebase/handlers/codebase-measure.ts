/*
<MODULE_CONTRACT>
<purpose>
RFC-1581: codebase.measure handler — measures project scale over the
git-tracked file set. Enumerates `git ls-files`, applies the hardcoded
exclusion contour, classifies categories, counts code/comment/blank lines
per language, and returns totals + per-language + top-dir measures.
Read-only by default; `--out <path>` writes an explicit snapshot.
</purpose>
<non-goals>
  <item>Does not count untracked files — the contour is the tracked tree.</item>
  <item>Does not estimate symbols with regexes — AST pass lives in
    codebase-measure-symbols.ts and degrades honestly.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1581: initial codebase.measure handler.</item>
  <item>RFC-1581: add codebase.measure project-scale measurement command</item>
</CHANGE_SUMMARY>
*/

import { basename, dirname, extname, join, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";

import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import { hasGeneratedMarker } from "../../../src/utils/generated-marker.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import type {
  CodebaseCategory,
  CodebaseMeasure,
  LanguageMeasure,
  TopDirMeasure,
} from "../types.ts";
import { measureSymbols } from "./codebase-measure-symbols.ts";

// ---------------------------------------------------------------------------
// Exclusion contour — paths dropped from the measurement entirely.
// ---------------------------------------------------------------------------

const EXCLUDED_PATHS: RegExp[] = [
  /(^|\/)dist\//,
  /(^|\/)\.turbo\//,
  /(^|\/)\.cache\//,
  /(^|\/)\.coverage\//,
  /(^|\/)\.astro\//,
  /^\.agents\/skills\//,
  /^missions\//,
  /^docs\/specs\//,
  /^docs\/metrics\//,
  /^docs\/rfcs\/archive\//,
  /^docs\/plans\/archive\//,
  /^docs\/audits\//,
  /(^|\/)node_modules\//,
];

const GENERATED_NAME = /\.generated\./;
const GENERATED_TOKEN = "@generated";

const TEST_PATH = /(^|\/)(__tests__|tests|e2e)\//;
const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;

// ---------------------------------------------------------------------------
// Language + comment syntax
// ---------------------------------------------------------------------------

interface CommentSpec {
  line: string[];
  block: Array<[string, string]>;
}

const LANGUAGES: Record<string, { language: string; comments: CommentSpec }> = {
  ".ts": { language: "TypeScript", comments: { line: ["//"], block: [["/*", "*/"]] } },
  ".tsx": { language: "TSX", comments: { line: ["//"], block: [["/*", "*/"]] } },
  ".mts": { language: "TypeScript", comments: { line: ["//"], block: [["/*", "*/"]] } },
  ".cts": { language: "TypeScript", comments: { line: ["//"], block: [["/*", "*/"]] } },
  ".js": { language: "JavaScript", comments: { line: ["//"], block: [["/*", "*/"]] } },
  ".mjs": { language: "JavaScript", comments: { line: ["//"], block: [["/*", "*/"]] } },
  ".cjs": { language: "JavaScript", comments: { line: ["//"], block: [["/*", "*/"]] } },
  ".jsx": { language: "JSX", comments: { line: ["//"], block: [["/*", "*/"]] } },
  ".astro": {
    language: "Astro",
    comments: {
      line: ["//"],
      block: [
        ["<!--", "-->"],
        ["/*", "*/"],
      ],
    },
  },
  ".md": { language: "Markdown", comments: { line: [], block: [["<!--", "-->"]] } },
  ".mdx": {
    language: "MDX",
    comments: {
      line: ["//"],
      block: [
        ["<!--", "-->"],
        ["/*", "*/"],
      ],
    },
  },
  ".yaml": { language: "YAML", comments: { line: ["#"], block: [] } },
  ".yml": { language: "YAML", comments: { line: ["#"], block: [] } },
  ".json": { language: "JSON", comments: { line: [], block: [] } },
  ".jsonc": { language: "JSONC", comments: { line: ["//"], block: [["/*", "*/"]] } },
  ".css": { language: "CSS", comments: { line: [], block: [["/*", "*/"]] } },
  ".scss": { language: "SCSS", comments: { line: ["//"], block: [["/*", "*/"]] } },
  ".html": { language: "HTML", comments: { line: [], block: [["<!--", "-->"]] } },
  ".xml": { language: "XML", comments: { line: [], block: [["<!--", "-->"]] } },
  ".svg": { language: "SVG", comments: { line: [], block: [["<!--", "-->"]] } },
  ".py": { language: "Python", comments: { line: ["#"], block: [] } },
  ".rs": { language: "Rust", comments: { line: ["//"], block: [["/*", "*/"]] } },
  ".go": { language: "Go", comments: { line: ["//"], block: [["/*", "*/"]] } },
  ".sh": { language: "Shell", comments: { line: ["#"], block: [] } },
  ".bash": { language: "Shell", comments: { line: ["#"], block: [] } },
  ".toml": { language: "TOML", comments: { line: ["#"], block: [] } },
  ".sql": { language: "SQL", comments: { line: ["--"], block: [["/*", "*/"]] } },
  ".vue": {
    language: "Vue",
    comments: {
      line: ["//"],
      block: [
        ["<!--", "-->"],
        ["/*", "*/"],
      ],
    },
  },
  ".svelte": {
    language: "Svelte",
    comments: {
      line: ["//"],
      block: [
        ["<!--", "-->"],
        ["/*", "*/"],
      ],
    },
  },
  ".txt": { language: "Text", comments: { line: [], block: [] } },
};

const TS_FAMILY = new Set(["TypeScript", "TSX", "JavaScript", "JSX"]);

const BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".mov",
  ".wasm",
]);

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function isExcluded(path: string): boolean {
  return EXCLUDED_PATHS.some((re) => re.test(path));
}

export function languageFor(path: string): { language: string; comments: CommentSpec } {
  const base = basename(path);
  if (base === "Dockerfile" || base.startsWith("Dockerfile.")) {
    return { language: "Dockerfile", comments: { line: ["#"], block: [] } };
  }
  const spec = LANGUAGES[extname(base).toLowerCase()];
  return spec ?? { language: "Other", comments: { line: [], block: [] } };
}

// First-match-wins order: generated → tests → docs → code.
export function categoryFor(
  path: string,
  generated: boolean,
): "code" | "tests" | "docs" | "generated" {
  const base = basename(path);
  const ext = extname(base).toLowerCase();
  if (generated) return "generated";
  if (TEST_NAME.test(base) || TEST_PATH.test(path)) return "tests";
  if (ext === ".md" || ((ext === ".yaml" || ext === ".yml") && path.startsWith("docs/"))) {
    return "docs";
  }
  if (base === "LICENSE" || base.startsWith("LICENSE.")) return "docs";
  return "code";
}

export function isBinaryName(path: string): boolean {
  return BINARY_EXTS.has(extname(path).toLowerCase());
}

/** Count code / comment / blank lines. A line with code + comment counts as code. */
export function countLines(
  content: string,
  comments: CommentSpec,
): { code: number; comments: number; blanks: number } {
  let code = 0;
  let commentLines = 0;
  let blanks = 0;
  let inBlock: string | null = null;
  const lines = content.split("\n");
  // A terminal newline produces a phantom empty tail element — not a real line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      commentLines++;
      if (line.includes(inBlock)) inBlock = null;
      continue;
    }
    if (line.length === 0) {
      blanks++;
      continue;
    }
    const lineHit = comments.line.some((p) => line.startsWith(p));
    if (lineHit) {
      commentLines++;
      continue;
    }
    const blockHit = comments.block.find(([open]) => line.startsWith(open));
    if (blockHit) {
      commentLines++;
      if (!line.slice(blockHit[0].length).includes(blockHit[1])) inBlock = blockHit[1];
      continue;
    }
    // Inline block end inside a code line still counts as code (handled above by
    // the startsWith checks); nothing else to do.
    code++;
  }
  return { code, comments: commentLines, blanks };
}

function topDirOf(path: string): string {
  const dir = dirname(path);
  if (dir === ".") return ".";
  const segs = dir.split("/");
  return segs.length >= 2 ? `${segs[0]}/${segs[1]}` : segs[0]!;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function runCodebaseMeasure(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<CodebaseMeasure>> {
  const io = resolveIo(context.io) ?? ambientIo;
  const { workspaceRoot } = context;
  const outPath = input.flags["out"] as string | undefined;

  if (typeof io.exec !== "function") {
    return {
      exitCode: 1,
      summary: "[codebase.measure] failed — exec capability unavailable",
      nextSteps: [
        {
          action:
            "Run codebase.measure through an io adapter that provides exec (ambient CLI or kernel io).",
          kind: "required",
        },
      ],
    };
  }

  const listed = await io.exec("git", ["ls-files", "-z"], { cwd: workspaceRoot });
  if (listed.exitCode !== 0) {
    return {
      exitCode: 1,
      summary: `[codebase.measure] failed — git ls-files exited ${listed.exitCode}`,
      nextSteps: [
        {
          action: `Run inside a Git repository with tracked files (${listed.stderr.trim() || "git ls-files failed"}).`,
          kind: "required",
        },
      ],
    };
  }

  const tracked = listed.stdout.split("\0").filter((p) => p.length > 0 && !isExcluded(p));

  const totals: Record<CodebaseCategory, { files: number; code: number }> = {
    code: { files: 0, code: 0 },
    tests: { files: 0, code: 0 },
    docs: { files: 0, code: 0 },
    generated: { files: 0, code: 0 },
  };
  const languages = new Map<string, LanguageMeasure>();
  const dirCode = new Map<string, number>();
  const symbolsSkipped: string[] = [];
  const tsFiles: Array<{ path: string; language: string; content: string }> = [];
  let binaryFiles = 0;
  let totalFiles = 0;
  let totalCode = 0;

  for (const rel of tracked) {
    const abs = join(workspaceRoot, rel);
    const base = basename(rel);
    if (isBinaryName(rel)) {
      binaryFiles++;
      totalFiles++;
      totals.code.files++;
      continue;
    }
    let content: string;
    try {
      content = await io.readFile(abs);
    } catch {
      totalFiles++;
      totals.code.files++;
      symbolsSkipped.push(`unreadable:${rel}`);
      continue;
    }
    const bytes = await io
      .readFileBytes(abs)
      .then((b) => b.subarray(0, 8192).includes(0))
      .catch(() => false);
    if (bytes) {
      binaryFiles++;
      totalFiles++;
      totals.code.files++;
      continue;
    }

    const generated =
      GENERATED_NAME.test(base) ||
      hasGeneratedMarker(content.slice(0, 4096)) ||
      content.slice(0, 4096).includes(GENERATED_TOKEN);
    const category = categoryFor(rel, generated);
    const { language, comments } = languageFor(rel);
    const counts = countLines(content, comments);

    totalFiles++;
    totalCode += counts.code;
    totals[category].files++;
    totals[category].code += counts.code;

    let lm = languages.get(language);
    if (!lm) {
      lm = {
        language,
        files: 0,
        code: 0,
        comments: 0,
        blanks: 0,
        classes: 0,
        functions: 0,
        methods: 0,
      };
      languages.set(language, lm);
    }
    lm.files++;
    lm.code += counts.code;
    lm.comments += counts.comments;
    lm.blanks += counts.blanks;

    const dir = topDirOf(rel);
    dirCode.set(dir, (dirCode.get(dir) ?? 0) + counts.code);

    if (TS_FAMILY.has(language) || language === "Astro") {
      tsFiles.push({ path: rel, language, content });
    }
  }

  const symbols = await measureSymbols(tsFiles, workspaceRoot);
  symbolsSkipped.push(...symbols.skipped);
  for (const [path, s] of symbols.byFile) {
    const lang = languages.get(languageFor(path).language);
    if (!lang) continue;
    lang.classes += s.classes;
    lang.functions += s.functions;
    lang.methods += s.methods;
  }

  const languageRows = [...languages.values()].sort(
    (a, b) => b.code - a.code || a.language.localeCompare(b.language),
  );
  const topDirs: TopDirMeasure[] = [...dirCode.entries()]
    .map(([dir, code]) => ({ dir, code }))
    .sort((a, b) => b.code - a.code || a.dir.localeCompare(b.dir))
    .slice(0, 10);

  const data: CodebaseMeasure = {
    command: "codebase.measure",
    status: "ok",
    totals,
    languages: languageRows,
    topDirs,
    binaryFiles,
    symbolsSkipped,
  };

  if (outPath) {
    const target = resolve(workspaceRoot, outPath);
    try {
      await io.writeFile(target, yamlStringify({ measuredAt: new Date().toISOString(), ...data }));
    } catch (error) {
      return {
        exitCode: 1,
        data,
        summary: `[codebase.measure] measured but failed to write --out ${outPath}`,
        nextSteps: [
          {
            action: `Ensure the --out parent directory exists and is writable (${error instanceof Error ? error.message : String(error)}).`,
            kind: "required",
          },
        ],
      };
    }
  }

  if (context.outputFormat === "pretty") {
    context.logger.info(`[codebase.measure] ${totalFiles} files, ${totalCode} code lines`);
    for (const cat of ["code", "tests", "docs", "generated"] as const) {
      context.logger.info(
        `  ${cat.padEnd(10)} ${totals[cat].files} files, ${totals[cat].code} code`,
      );
    }
    for (const row of languageRows) {
      const sym =
        row.classes + row.functions + row.methods > 0
          ? ` | ${row.classes} classes, ${row.functions + row.methods} functions`
          : "";
      context.logger.info(
        `  ${row.language.padEnd(12)} ${row.files} files, ${row.code} code, ${row.comments} comments, ${row.blanks} blanks${sym}`,
      );
    }
    if (topDirs.length > 0) {
      context.logger.info("  top dirs:");
      for (const d of topDirs) context.logger.info(`    ${d.code} ${d.dir}`);
    }
    if (symbolsSkipped.length > 0) {
      context.logger.info(`  symbolsSkipped: ${symbolsSkipped.join(", ")}`);
    }
  }

  return {
    data,
    exitCode: 0,
    summary:
      `[codebase.measure] ${totalFiles} files, ${totalCode} code lines ` +
      `(code ${totals.code.code}, tests ${totals.tests.code}, docs ${totals.docs.code}, generated ${totals.generated.code})`,
  };
}
