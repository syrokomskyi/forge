/*
<MODULE_CONTRACT>
<purpose>RFC artifact check handler — validates declared files and feature flags exist on disk.</purpose>
<non-goals>
  <item>Do not introduce app-specific runtime composition or deployment behavior into this reusable package source file.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0303: extracted check handler from handlers.ts into handlers/check.ts.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";

import { listRfcFiles, readAndParseRfc } from "../frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import type { RfcStatus, RfcCheckViolation, RfcCheckResult } from "../types.ts";
import { RFC_DIR } from "../types.ts";
import { isLiteralFsPath } from "./shared.ts";

const RFC_CHECK_DEFAULT_STATUSES: readonly RfcStatus[] = ["accepted", "implemented"];

function extractFileSystemPaths(body: string): string[] {
  const sectionRegex =
    /###?\s+File system responsibilities\s*\n[^\n]*\|[^\n]*Path[^\n]*\|\s*\n\|[-\s|]+\|\s*\n((?:\|[^\n]+\n?)*)/i;
  const sectionMatch = body.match(sectionRegex);
  if (!sectionMatch) return [];

  const tableBody = sectionMatch[1] ?? "";
  const paths: string[] = [];

  for (const line of tableBody.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const rawPath = cells[1];
    if (!rawPath) continue;
    const cleanPath = rawPath.replace(/`/g, "").trim();
    if (!cleanPath || cleanPath === "Path" || cleanPath.startsWith("---")) continue;
    paths.push(cleanPath);
  }

  return paths;
}

function extractFeatureFlagReferences(body: string): string[] {
  const flags = new Set<string>();
  const regex = /\bfeatures\.([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*)\b/g;
  const FILE_EXTENSIONS = new Set(["ts", "js", "css", "astro", "md", "mjs", "cjs", "json"]);

  for (const match of body.matchAll(regex)) {
    const flagPath = match[1]!;
    const segments = flagPath.split(".");

    if (segments.length === 1 && FILE_EXTENSIONS.has(segments[0]!)) continue;
    if (segments.some((s) => /^[A-Z]$/.test(s))) continue;
    if (segments.length < 2) continue;

    flags.add(flagPath);
  }
  return [...flags];
}

function extractDefinedFeatureKeysFromSource(source: string): Set<string> {
  const keys = new Set<string>();
  const startMatch = /export const features\s*=\s*\{/.exec(source);
  if (!startMatch) return keys;

  const lines = source.slice(startMatch.index + startMatch[0].length).split("\n");
  const pathStack: string[] = [];
  let depth = 0;

  for (const line of lines) {
    const openCount = (line.match(/\{/g) ?? []).length;
    const closeCount = (line.match(/\}/g) ?? []).length;

    const leafMatch = /^\s+(\w+)\s*:\s*defineFeature\s*\(/.exec(line);
    const nestedMatch = !line.includes("defineFeature") ? /^\s+(\w+)\s*:\s*\{/.exec(line) : null;

    if (leafMatch) {
      const key = leafMatch[1]!;
      const fullPath = pathStack.length > 0 ? [...pathStack, key].join(".") : key;
      keys.add(fullPath);
    } else if (nestedMatch) {
      pathStack.push(nestedMatch[1]!);
    }

    depth += openCount - closeCount;

    while (pathStack.length > 0 && pathStack.length > Math.max(0, depth)) {
      pathStack.pop();
    }

    if (depth < 0) break;
  }

  return keys;
}

async function loadFeatureKeysForApps(
  workspaceRoot: string,
  appsImpacted: string[],
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();

  for (const siteName of appsImpacted) {
    const featuresPath = path.join(
      workspaceRoot,
      "apps",
      siteName,
      "src",
      "configure",
      "features.ts",
    );
    try {
      const source = await fs.readFile(featuresPath, "utf-8");
      result.set(siteName, extractDefinedFeatureKeysFromSource(source));
    } catch {
      // features.ts not found for this app — skip
    }
  }

  return result;
}

export async function runRfcCheck(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcCheckResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);

  const statusFlag = input.flags["status"];
  const statusFilter: string[] = statusFlag
    ? (Array.isArray(statusFlag) ? statusFlag : [statusFlag]).filter(
        (s): s is string => typeof s === "string",
      )
    : [...RFC_CHECK_DEFAULT_STATUSES];

  const files = await listRfcFiles(rfcDirPath);
  const violations: RfcCheckViolation[] = [];
  let checkedRfcs = 0;

  for (const fileName of files) {
    const result = await readAndParseRfc(rfcDirPath, fileName);
    if (!result || "error" in result) continue;

    const fm = result.parsed.frontmatter;
    const body = result.parsed.body;
    const rfcId = String(fm["id"] ?? "UNKNOWN");
    const status = String(fm["status"] ?? "");
    const relFile = path.join(RFC_DIR, fileName);

    if (!statusFilter.includes(status)) continue;

    checkedRfcs += 1;

    // C-01: Check file existence from File system responsibilities table
    const declaredPaths = extractFileSystemPaths(body);
    for (const declaredPath of declaredPaths) {
      if (!isLiteralFsPath(declaredPath)) continue;
      const absPath = path.join(workspaceRoot, declaredPath);
      try {
        await fs.access(absPath);
      } catch {
        violations.push({
          rfcId,
          file: relFile,
          kind: "missing-file",
          artifact: declaredPath,
          message: `File "${declaredPath}" declared in ${rfcId} does not exist`,
        });
      }
    }

    // C-02: Check feature flag references
    const flagRefs = extractFeatureFlagReferences(body);
    if (flagRefs.length > 0) {
      const appsImpacted = Array.isArray(fm["appsImpacted"])
        ? (fm["appsImpacted"] as string[])
        : [];

      const featureKeysByApp = await loadFeatureKeysForApps(workspaceRoot, appsImpacted);

      for (const flagRef of flagRefs) {
        let definedInAny = false;
        for (const [, keys] of featureKeysByApp) {
          if (keys.has(flagRef)) {
            definedInAny = true;
            break;
          }
        }

        if (!definedInAny && appsImpacted.length > 0) {
          violations.push({
            rfcId,
            file: relFile,
            kind: "missing-feature-flag",
            artifact: flagRef,
            message: `Feature flag "features.${flagRef}" referenced in ${rfcId} is not defined in any impacted app's features.ts`,
          });
        }
      }
    }
  }

  const hasErrors = violations.length > 0;
  const resultStatus = hasErrors ? "fail" : "pass";

  if (outputFormat === "pretty") {
    if (violations.length === 0) {
      logger.success(`All ${checkedRfcs} RFC(s) passed artifact check.`);
    } else {
      logger.section(`RFC Artifact Check (${checkedRfcs} RFC(s))`);
      for (const v of violations) {
        logger.error(`[${v.kind}] ${v.rfcId}: ${v.message}`);
      }
      logger.error(`${violations.length} violation(s) found`);
    }
  }

  return {
    data: {
      command: "rfc.check",
      status: resultStatus,
      checkedRfcs,
      violations,
    },
    exitCode: hasErrors ? 1 : 0,
    summary: hasErrors
      ? `${violations.length} artifact violation(s) found across ${checkedRfcs} RFC(s)`
      : `All ${checkedRfcs} RFC(s) passed artifact check`,
  };
}
