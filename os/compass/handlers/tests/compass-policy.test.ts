/*
<MODULE_CONTRACT>
<purpose>Unit tests for RFC-1096 Compass policy externalization — generic
defaults, profile overlay, bindings.compass overrides, merge semantics, and
the named-config-error contract.</purpose>
<non-goals>
  <item>Do not test v2 rule diagnostics — covered by compass-v2-contract.test.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1096: initial coverage for resolveCompassPolicy (AC-1..AC-5).</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  resolveCompassPolicy,
  CompassPolicyConfigError,
  parseGovernanceIdParts,
} from "../../policy.ts";
import { runCompassInventory } from "../compass-inventory-handler.ts";
import type { ForgeRuntimeContext } from "../../../../src/types.ts";

// packages/forge — real forge root so `profile:` resolution finds shipped profiles.
const FORGE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
// os/compass directory — scanned by the AC-4 literal check.
const COMPASS_DIR = fileURLToPath(new URL("../../", import.meta.url));

const FORGE_YAML = (bindings: string) => `
schema: forge/config@1
project:
  name: test-ws
  stack: [typescript]
  packageManager: pnpm
paths:
  rfcsDir: docs/rfcs
  adrsDir: docs/adrs
  plansDir: docs/plans
  auditsDir: docs/audits
  specsDir: docs/specs
  skillsDir: .agents/skills
bindings:
  schema: forge/bindings@1
  commands: {}
  paths: {}
${bindings}`;

const FORGE_YAML_WITH_PROFILE = `
schema: forge/config@1
profile: godot-csharp
project:
  name: test-ws
  stack: [godot]
  packageManager: pnpm
paths:
  rfcsDir: docs/rfcs
  adrsDir: docs/adrs
  plansDir: docs/plans
  auditsDir: docs/audits
  specsDir: docs/specs
  skillsDir: .agents/skills
`;

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    forgeRoot: FORGE_ROOT,
    dryRun: true,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as ForgeRuntimeContext;
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(abs));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

describe("resolveCompassPolicy (RFC-1096)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "compass-policy-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("AC-1: bindings.compass.scanRoots replaces the generic scan roots", () => {
    writeFileSync(join(root, "forge.yaml"), FORGE_YAML("  compass:\n    scanRoots: [src]\n"));
    const policy = resolveCompassPolicy(root, FORGE_ROOT);
    expect(policy.scanRoots).toEqual(["src"]);
    expect(policy.source.overriddenKeys).toContain("scanRoots");
  });

  it("AC-1b: union keys merge and `!` subtracts", () => {
    writeFileSync(
      join(root, "forge.yaml"),
      FORGE_YAML(
        '  compass:\n    fileExtensions: [.ts, .svelte, "!.astro"]\n    ignoredDirs: [spec, "!coverage"]\n',
      ),
    );
    const policy = resolveCompassPolicy(root, FORGE_ROOT);
    expect(policy.fileExtensions.has(".svelte")).toBe(true);
    expect(policy.fileExtensions.has(".ts")).toBe(true);
    expect(policy.fileExtensions.has(".astro")).toBe(false);
    expect(policy.ignoredDirs.has("spec")).toBe(true);
    expect(policy.ignoredDirs.has("coverage")).toBe(false);
    expect(policy.ignoredDirs.has("node_modules")).toBe(true);
  });

  it("AC-1c: consumer layerRules replace the generic set wholesale", () => {
    writeFileSync(
      join(root, "forge.yaml"),
      FORGE_YAML(
        "  compass:\n    layerRules:\n      - pattern: src/pages/**\n        layer: route\n        risk: high\n",
      ),
    );
    const policy = resolveCompassPolicy(root, FORGE_ROOT);
    expect(policy.matchLayer("src/pages/index.astro")?.layer).toBe("route");
    expect(policy.matchLayer("src/pages/index.astro")?.risk).toBe("high");
    // Replace semantics: generic rules are gone when the consumer sets the key.
    expect(policy.matchLayer("src/components/x.ts")).toBeUndefined();
    expect(policy.layerRules).toHaveLength(1);
  });

  it("AC-2: profile compass section applies when forge.yaml declares `profile`", () => {
    writeFileSync(join(root, "forge.yaml"), FORGE_YAML_WITH_PROFILE);
    const policy = resolveCompassPolicy(root, FORGE_ROOT);
    expect(policy.source.profile).toBe("godot-csharp");
    for (const ext of [".cs", ".tscn", ".tres", ".gd"]) {
      expect(policy.fileExtensions.has(ext), `missing ${ext}`).toBe(true);
    }
    expect(policy.source.overriddenKeys).toEqual([]);
  });

  it("AC-3: non-compilable idPattern throws CompassPolicyConfigError naming the key", () => {
    writeFileSync(join(root, "forge.yaml"), FORGE_YAML('  compass:\n    idPattern: "([invalid"\n'));
    expect(() => resolveCompassPolicy(root, FORGE_ROOT)).toThrow(CompassPolicyConfigError);
    try {
      resolveCompassPolicy(root, FORGE_ROOT);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CompassPolicyConfigError);
      expect((err as CompassPolicyConfigError).key).toBe("idPattern");
      expect((err as Error).message).toContain("idPattern");
    }
  });

  it("AC-3b: idPattern that fails the NAMESPACE-NUMBER probe is rejected", () => {
    writeFileSync(join(root, "forge.yaml"), FORGE_YAML('  compass:\n    idPattern: "^\\\\d+$"\n'));
    expect(() => resolveCompassPolicy(root, FORGE_ROOT)).toThrow(CompassPolicyConfigError);
  });

  it("AC-4: no consumer- or stack-specific path literals under os/compass", () => {
    // Constructed dynamically so this test file does not itself carry the literals.
    // Path-literal forms only — historical `@warpgogol/<pkg>` specifiers in
    // CHANGE_SUMMARY comments are package names, not path literals.
    const bannedPathLiterals = [
      "apps/" + "main",
      "DEFAULT_" + "SCAN_" + "ROOTS",
      "werk" + "statt",
      "packages/" + "os/",
      "site-" + "kernel/",
    ];
    // AC-4 names `site-kernel` (bare) as banned inside compass-inventory.ts.
    const bannedInInventory = [...bannedPathLiterals, "site-" + "kernel"];
    const inventoryFile = join(COMPASS_DIR, "handlers", "compass-inventory.ts");

    const offenders: string[] = [];
    for (const file of collectTsFiles(COMPASS_DIR)) {
      const source = readFileSync(file, "utf8");
      const banned = file === inventoryFile ? bannedInInventory : bannedPathLiterals;
      for (const literal of banned) {
        if (source.includes(literal)) {
          offenders.push(`${file}: ${literal}`);
        }
      }
    }
    expect(offenders, `banned literals found:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("AC-5: highRiskPaths from bindings mark matching entries riskClass=high", async () => {
    writeFileSync(
      join(root, "forge.yaml"),
      FORGE_YAML(
        '  compass:\n    scanRoots: [packages]\n    highRiskPaths: ["packages/fixture-pkg/src/kernel/**"]\n',
      ),
    );
    const fixture = join(root, "packages", "fixture-pkg", "src", "kernel");
    mkdirSync(fixture, { recursive: true });
    const body = Array.from({ length: 25 }, (_, i) => `export const line${i} = ${i};`).join("\n");
    writeFileSync(
      join(fixture, "engine.ts"),
      `/*\n<MODULE_CONTRACT>\n<purpose>Fixture kernel engine file for the compass policy high-risk test.</purpose>\n<non-goals>\n  <item>No production logic.</item>\n</non-goals>\n</MODULE_CONTRACT>\n*/\n${body}\n`,
    );

    const result = await runCompassInventory({ flags: {} } as never, makeContext(root));
    const entry = result.data?.entries.find((e) => e.path.endsWith("kernel/engine.ts"));
    expect(entry, "fixture entry must be inventoried").toBeDefined();
    expect(entry!.riskClass).toBe("high");
    expect(result.data?.policySource.overriddenKeys).toContain("highRiskPaths");
  });

  it("excludedPaths mark matching files excluded with the configured reason", async () => {
    writeFileSync(
      join(root, "forge.yaml"),
      FORGE_YAML(
        "  compass:\n    scanRoots: [packages]\n    excludedPaths:\n      - pattern: src/templates/**\n        reason: template-source\n",
      ),
    );
    const dir = join(root, "packages", "fixture-pkg", "src", "templates");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "widget.ts"), "export const t = 1;\n");

    const result = await runCompassInventory({ flags: {} } as never, makeContext(root));
    const entry = result.data?.entries.find((e) => e.path.endsWith("templates/widget.ts"));
    expect(entry).toBeDefined();
    expect(entry!.authoringStatus).toBe("excluded");
    expect(entry!.exclusionReason).toBe("template-source");
  });

  it("missing forge.yaml yields the generic policy", () => {
    const policy = resolveCompassPolicy(root, FORGE_ROOT);
    expect(policy.source.profile).toBeNull();
    expect(policy.source.overriddenKeys).toEqual([]);
    expect(policy.fileExtensions.has(".ts")).toBe(true);
    expect(policy.scanRoots).toEqual(["src", "apps", "packages", "services"]);
    expect(policy.idPattern.test("RFC-1096")).toBe(true);
  });

  it("parseGovernanceIdParts splits on the last dash", () => {
    expect(parseGovernanceIdParts("RFC-1095")).toEqual({ namespace: "RFC", numeric: 1095 });
    expect(parseGovernanceIdParts("COMPASS-CS-07")).toEqual({
      namespace: "COMPASS-CS",
      numeric: 7,
    });
    expect(parseGovernanceIdParts("no-number")).toBeNull();
  });
});
