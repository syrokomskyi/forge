/*
<MODULE_CONTRACT>
<purpose>
Shared RFC frontmatter file I/O — extracted from handlers.ts so both
handlers.ts and acceptance.ts (RFC-0268) can read RFC files without a
circular import between the two.
</purpose>
<non-goals>
  <item>Do not validate frontmatter shape — that is handlers.ts / acceptance.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0521: added getRfcStatusById and loadRfcStatusMap helpers for plan/audit archive commands.</item>
  <item>RFC-0755: readAndParseRfc now returns { fileName, error } on YAML parse failure instead of undefined.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
  <item>RFC-1489: batch test probes through one instrumented Vitest run + frontmatter corpus reads

runProbeSet is the single shared execution point: barrier-free segments of test probes sharing one effective bound run in one vitest --reporter=json --outputFile process with per-(file,testName) attribution; missing files/reports yield unverified. run/page/proof and all non-test kinds are barriers. --no-batch escapes to the legacy path on acceptance.run, verification.emit and verification.refresh. rfc.validate reads non-target corpus files frontmatter-only via readRfcFrontmatter (64 KiB bound, full-parse fallback); emit/refresh/acceptance corpus scans use the same accessor. Corpus map slimmed to RfcCorpusEntry {fileName, frontmatter}.</item>
  <item>RFC-1534: frontmatterSource captured on both parse paths (probe-meta marker scan); mergeFrontmatterListEntry / appendRfcFrontmatterListEntry — line-level list merge preserving comments and key order (F-0056 discipline, never a YAML.stringify round-trip).</item>
  <history>RFC-0268</history>
</CHANGE_SUMMARY>
*/

import { ambientIo as fs } from "../../src/utils/io.ts";
import { writeFileAtomic } from "../../src/utils/fs-atomic.ts";
import path from "node:path";
import { open as fsOpen } from "node:fs/promises";
import YAML from "yaml";

export interface ParsedRfc {
  frontmatter: Record<string, unknown>;
  body: string;
  /** RFC-1534: raw YAML frontmatter text — marker scans (probe-meta) need the
   * un-parsed source because YAML comments never reach the parsed map. */
  frontmatterSource?: string;
}

export function parseRfcFile(source: string): ParsedRfc {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: source };
  }
  return {
    frontmatter: (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>,
    body: match[2] ?? "",
    frontmatterSource: match[1]!,
  };
}

/**
 * RFC-1534: merges `ids` into a frontmatter list `key` by line-level edit —
 * preserves comments, key order, and existing entries (F-0056 discipline;
 * a YAML.stringify round-trip would strip the template's comment lines).
 * Returns the rewritten source plus the ids actually added; `undefined` when
 * every id was already present.
 */
export function mergeFrontmatterListEntry(
  source: string,
  key: string,
  ids: string[],
): { content: string; added: string[] } | undefined {
  const match = source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/);
  if (!match) return undefined;
  const [, open, fm, close, body] = match;
  const lines = fm!.split("\n");
  const keyRe = new RegExp(`^${key}:(.*)$`);
  const keyIdx = lines.findIndex((l) => keyRe.test(l));
  const existing = new Set<string>();
  let insertAt = -1;

  if (keyIdx !== -1) {
    const inline = keyRe.exec(lines[keyIdx]!)![1]!.trim();
    if (inline.startsWith("[")) {
      for (const m of inline.replace(/^\[/, "").replace(/\]$/, "").split(",")) {
        const item = m.trim().replace(/^["']|["']$/g, "");
        if (item) existing.add(item);
      }
      lines[keyIdx] = `${key}:`;
      insertAt = keyIdx + 1;
    } else {
      insertAt = keyIdx + 1;
      while (insertAt < lines.length && /^\s+-\s+/.test(lines[insertAt]!)) {
        existing.add(lines[insertAt]!.replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, ""));
        insertAt++;
      }
    }
  } else {
    // No key — anchor after amends:/amendedBy:/supersededBy: block when one
    // exists so relationship keys stay adjacent, else end of frontmatter.
    let anchor = lines.length;
    for (const anchorKey of ["amends", "amendedBy", "supersededBy", "supersedes"]) {
      const idx = lines.findIndex((l) => new RegExp(`^${anchorKey}:`).test(l));
      if (idx !== -1) {
        anchor = idx + 1;
        while (anchor < lines.length && /^\s+-\s+/.test(lines[anchor]!)) anchor++;
        break;
      }
    }
    lines.splice(anchor, 0, `${key}:`);
    insertAt = anchor + 1;
  }

  const added = ids.filter((id) => !existing.has(id));
  if (added.length === 0) return undefined;
  lines.splice(insertAt, 0, ...added.map((id) => `  - ${id}`));
  return { content: `${open}${lines.join("\n")}${close}${body}`, added };
}

/**
 * RFC-1534: re-reads the file immediately before merging (never a
 * blind-append over a cached parse — the counterpart write races a parallel
 * edit of the amended file). Returns `{ added }`; `undefined` when the file
 * was unreadable or every id was already present.
 */
export async function appendRfcFrontmatterListEntry(
  filePath: string,
  key: string,
  ids: string[],
): Promise<{ added: string[] } | undefined> {
  let source: string;
  try {
    source = await fs.readFile(filePath);
  } catch {
    return undefined;
  }
  const merged = mergeFrontmatterListEntry(source, key, ids);
  if (!merged) return undefined;
  await writeFileAtomic(filePath, merged.content);
  return { added: merged.added };
}

export async function listRfcFiles(rfcDirPath: string): Promise<string[]> {
  const results: string[] = [];

  async function scanDir(dirPath: string, relativePrefix: string): Promise<void> {
    try {
      const entries = await fs.readdir(dirPath);
      for (const entry of entries) {
        const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory) {
          await scanDir(path.join(dirPath, entry.name), relativePath);
        } else if (
          entry.isFile &&
          entry.name.endsWith(".md") &&
          !entry.name.startsWith("rfc-0000") &&
          !entry.name.endsWith(".generated.md") &&
          entry.name !== "README.md"
        ) {
          results.push(relativePath);
        }
      }
    } catch {
      // Directory doesn't exist or is unreadable — return empty
    }
  }

  await scanDir(rfcDirPath, "");
  return results.sort();
}

export function rfcFileMatchesId(fileName: string, targetId: string): boolean {
  return path.basename(fileName).toLowerCase().startsWith(targetId.toLowerCase());
}

export type ReadAndParseRfcResult =
  { fileName: string; parsed: ParsedRfc } | { fileName: string; error: string };

/**
 * RFC-1489: slim corpus entry — non-target files carry frontmatter only.
 * A rule that needs a non-target `body` is a design smell to escalate, never
 * to accommodate by re-widening this type.
 */
export interface RfcCorpusEntry {
  fileName: string;
  frontmatter: Record<string, unknown>;
}

function parseErrorResult(fileName: string, e: unknown): { fileName: string; error: string } {
  if (e instanceof Error) {
    const linePos = (e as Error & { linePos?: Array<{ line: number; col: number }> }).linePos;
    if (linePos?.length) {
      const pos = linePos[0]!;
      return {
        fileName,
        error: `YAML parse error at line ${pos.line}, column ${pos.col}: ${e.message}`,
      };
    }
    return { fileName, error: `YAML parse error: ${e.message}` };
  }
  return { fileName, error: `YAML parse error: ${String(e)}` };
}

export async function readAndParseRfc(
  rfcDirPath: string,
  fileName: string,
): Promise<ReadAndParseRfcResult | undefined> {
  try {
    const filePath = path.join(rfcDirPath, fileName);
    const content = await fs.readFile(filePath);
    return { fileName, parsed: parseRfcFile(content) };
  } catch (e) {
    return parseErrorResult(fileName, e);
  }
}

const FRONTMATTER_READ_BOUND = 64 * 1024;
const FRONTMATTER_HEAD_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * RFC-1489: reads only the YAML frontmatter block of an RFC file — a bounded
 * 64 KiB head read instead of the whole body. Returns `{ frontmatter, body: "" }`;
 * `body` is never populated through this path. Falls back to the full
 * `readAndParseRfc` when the closing `---` fence is not found within the bound
 * (a frontmatter block larger than the cap is pathological, not forbidden).
 * A <64 KiB file without a closing fence yields `{ frontmatter: {}, body: "" }`,
 * matching `parseRfcFile`'s frontmatter for such files.
 */
export async function readRfcFrontmatter(
  rfcDirPath: string,
  fileName: string,
): Promise<ReadAndParseRfcResult | undefined> {
  const filePath = path.join(rfcDirPath, fileName);
  let head: string;
  let hitBound = false;
  try {
    const handle = await fsOpen(filePath, "r");
    try {
      const buffer = Buffer.alloc(FRONTMATTER_READ_BOUND);
      const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_READ_BOUND, 0);
      hitBound = bytesRead === FRONTMATTER_READ_BOUND;
      head = buffer.subarray(0, bytesRead).toString("utf-8");
    } finally {
      await handle.close();
    }
  } catch (e) {
    return parseErrorResult(fileName, e);
  }

  const match = head.match(FRONTMATTER_HEAD_RE);
  if (!match) {
    // No closing fence in what was read. Small file → the head IS the whole
    // file and there is nothing more to find; large file → full-parse fallback.
    if (!hitBound) return { fileName, parsed: { frontmatter: {}, body: "" } };
    return readAndParseRfc(rfcDirPath, fileName);
  }
  try {
    const frontmatter = (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>;
    return { fileName, parsed: { frontmatter, body: "", frontmatterSource: match[1]! } };
  } catch (e) {
    return parseErrorResult(fileName, e);
  }
}

export async function getRfcStatusById(
  rfcDirPath: string,
  rfcId: string,
): Promise<string | undefined> {
  const files = await listRfcFiles(rfcDirPath);
  for (const fileName of files) {
    if (rfcFileMatchesId(fileName, rfcId)) {
      const result = await readAndParseRfc(rfcDirPath, fileName);
      if (result && "parsed" in result) {
        const status = String(result.parsed.frontmatter["status"] ?? "").trim();
        if (status) return status;
      }
    }
  }
  return undefined;
}

export async function loadRfcStatusMap(rfcDirPath: string): Promise<Map<string, string>> {
  const files = await listRfcFiles(rfcDirPath);
  const statusMap = new Map<string, string>();
  for (const fileName of files) {
    const result = await readAndParseRfc(rfcDirPath, fileName);
    if (result && "parsed" in result) {
      const id = String(result.parsed.frontmatter["id"] ?? "").trim();
      const status = String(result.parsed.frontmatter["status"] ?? "").trim();
      if (id && status) {
        statusMap.set(id, status);
      }
    }
  }
  return statusMap;
}
