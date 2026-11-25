/*
<MODULE_CONTRACT>
<purpose>
Static-scan executors (Werkstatt RFC-1648) — the honesty of capability declarations
is itself enforceable: plugin code bypassing SDK ports with raw capability imports
is a blocking violation. Dependency direction: plugins may depend on the core SDK
and other plugins — never consumer internals, core internals outside the SDK, or
scopeless shared packages.
</purpose>
<non-goals><item>No runtime sandboxing — auditability only, by design.</item></non-goals>
<CHANGE_SUMMARY><item>RFC-1648 (WP-5): initial scan executors.</item></CHANGE_SUMMARY>
*/

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

export interface ScanViolation {
  ruleId: string;
  message: string;
  severity: "blocking" | "advisory";
  file?: string;
  line?: number;
}

/** Raw capability imports that bypass SDK ports. */
const RAW_IMPORTS: Array<{ pattern: RegExp; capability: string; ruleId: string }> = [
  { pattern: /from\s+["']node:child_process["']|require\(["']child_process["']\)/, capability: "processSpawn", ruleId: "CAP-SCAN-01" },
  { pattern: /from\s+["']node:fs\/promises["']|from\s+["']node:fs["']|require\(["']fs["']\)/, capability: "filesystem", ruleId: "CAP-SCAN-02" },
  { pattern: /from\s+["']node:net["']|from\s+["']node:https?["']|require\(["']https?["']\)/, capability: "network", ruleId: "CAP-SCAN-03" },
  { pattern: /(?<![\w.])fetch\s*\(/, capability: "network", ruleId: "CAP-SCAN-04" },
  { pattern: /from\s+["']node:os["'].*\bexec\b/, capability: "processSpawn", ruleId: "CAP-SCAN-05" },
];

function* walkSources(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    try {
      if (statSync(p).isDirectory()) yield* walkSources(p);
      else if ([".ts", ".js", ".mts", ".mjs"].includes(extname(entry))) yield p;
    } catch {
      // unreadable entries are not evidence
    }
  }
}

function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

/**
 * CAP-SCAN: scan plugin sources for raw capability imports bypassing the SDK.
 * Import statements survive comment/string stripping because import specifiers
 * are the syntax under test — strip only bodies, keep the import lines.
 */
export function scanPluginForRawImports(pluginDir: string): ScanViolation[] {
  const violations: ScanViolation[] = [];
  for (const file of walkSources(pluginDir)) {
    const src = readFileSync(file, "utf8");
    const importLines = src.split("\n").filter((l) => /^\s*(import|export\s+.*from|const\s+\w+\s*=\s*require)/.test(l));
    const bodyStripped = stripCommentsAndStrings(src);
    const lines = src.split("\n");

    for (const { pattern, capability, ruleId } of RAW_IMPORTS) {
      // Raw import detection against import lines.
      if (ruleId !== "CAP-SCAN-04") {
        for (const line of importLines) {
          if (pattern.test(line)) {
            violations.push({
              ruleId,
              message: `raw ${capability} import bypasses SDK ports — capability honesty is enforceable`,
              severity: "blocking",
              file,
              line: lines.indexOf(line) + 1,
            });
          }
        }
      } else {
        // Raw fetch() call detection against the stripped body — a bare fetch not
        // reached through ctx.network. ctx.network.fetch( is exempt by receiver shape.
        const withoutCtxFetch = bodyStripped.replace(/\bctx\s*\.\s*network\s*\.\s*fetch\s*\(/g, "");
        if (pattern.test(withoutCtxFetch)) {
          violations.push({
            ruleId,
            message: `raw fetch() bypasses the network port — use ctx.network.fetch`,
            severity: "blocking",
            file,
          });
        }
      }
    }
  }
  return violations;
}

/** FORGE-PLUG-DEP: dependency-direction scan over a plugin's package.json. */
export function scanPluginDependencyDirection(pluginDir: string): ScanViolation[] {
  const pkgPath = join(pluginDir, "package.json");
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
  const violations: ScanViolation[] = [];
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    // Allowed: the core SDK, other forge plugins.
    if (dep === "@warpgogol/forge" || dep.startsWith("@warpgogol/forge-")) continue;
    // Forbidden: consumer internals and legacy v9 internals.
    if (dep.startsWith("@warpgogol/werkstatt") || dep.includes("consumer") || dep.includes("internal")) {
      violations.push({
        ruleId: "PLUG-DEP-01",
        message: `plugin depends on forbidden internal/consumer package: ${dep}`,
        severity: "blocking",
        file: pkgPath,
      });
      continue;
    }
    // Forbidden: scopeless shared packages — none may exist (utility packages are the SDK anti-pattern).
    if (!dep.startsWith("@")) {
      violations.push({
        ruleId: "PLUG-DEP-02",
        message: `plugin depends on scopeless package "${dep}" — shared capability belongs in the SDK, never a utility package`,
        severity: "blocking",
        file: pkgPath,
      });
    }
  }
  return violations;
}
