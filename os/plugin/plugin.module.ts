/*
<MODULE_CONTRACT>
<purpose>forgePluginModule — registers forge.plugin.validate and forge.plugin.discover commands for pack manifest validation (RFC-0941).</purpose>
<non-goals>
  <item>Do not implement skill discovery logic — delegate to discoverPackSkills in registry.ts.</item>
  <item>Do not modify forge.yaml — this module reads config only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0941: initial forgePluginModule with forge.plugin.validate and forge.plugin.discover commands.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ForgeModule } from "../../src/forge-module.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";
import { loadForgeConfig } from "../../src/config/forge-config.ts";
import { forgePluginManifestSchema } from "../../src/plugin/ForgePluginManifest.ts";

export interface PluginValidateResult {
  command: "forge.plugin.validate";
  status: "pass" | "fail";
  packs: Array<{
    prefix: string;
    dir: string;
    manifestPath: string;
    valid: boolean;
    errors: string[];
  }>;
}

export interface PluginDiscoverResult {
  command: "forge.plugin.discover";
  packs: Array<{
    prefix: string;
    dir: string;
    manifestPath: string;
    id: string;
    version: string;
  }>;
  count: number;
}

function runPluginValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): ForgeCommandResult<PluginValidateResult> {
  const workspaceRoot = context.workspaceRoot;
  const packs: PluginValidateResult["packs"] = [];
  let allValid = true;

  try {
    const config = loadForgeConfig(workspaceRoot);

    if (!config.skillPacks || config.skillPacks.length === 0) {
      return {
        data: {
          command: "forge.plugin.validate",
          status: "pass",
          packs: [],
        },
        summary: "[forge.plugin.validate] OK — 0 packs declared",
      };
    }

    for (const pack of config.skillPacks) {
      const packDir = path.resolve(workspaceRoot, pack.dir);
      const manifestPath = path.join(packDir, "forge.plugin.yaml");

      if (!fs.existsSync(manifestPath)) {
        allValid = false;
        packs.push({
          prefix: pack.prefix,
          dir: pack.dir,
          manifestPath,
          valid: false,
          errors: ["forge.plugin.yaml not found at pack root"],
        });
        continue;
      }

      let raw: string;
      try {
        raw = fs.readFileSync(manifestPath, "utf-8");
      } catch (err) {
        allValid = false;
        packs.push({
          prefix: pack.prefix,
          dir: pack.dir,
          manifestPath,
          valid: false,
          errors: [`Failed to read manifest: ${(err as Error).message}`],
        });
        continue;
      }

      let parsed: unknown;
      try {
        parsed = parseYaml(raw);
      } catch (err) {
        allValid = false;
        packs.push({
          prefix: pack.prefix,
          dir: pack.dir,
          manifestPath,
          valid: false,
          errors: [`YAML parse error: ${(err as Error).message}`],
        });
        continue;
      }

      const result = forgePluginManifestSchema.safeParse(parsed);
      if (!result.success) {
        allValid = false;
        packs.push({
          prefix: pack.prefix,
          dir: pack.dir,
          manifestPath,
          valid: false,
          errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        });
        continue;
      }

      packs.push({
        prefix: pack.prefix,
        dir: pack.dir,
        manifestPath,
        valid: true,
        errors: [],
      });
    }
  } catch (err) {
    return {
      data: {
        command: "forge.plugin.validate",
        status: "fail",
        packs: [],
      },
      exitCode: 1,
      summary: `[forge.plugin.validate] FAIL — ${(err as Error).message}`,
    };
  }

  const status = allValid ? "pass" : "fail";
  return {
    data: {
      command: "forge.plugin.validate",
      status,
      packs,
    },
    ...(status === "fail" ? { exitCode: 1 } : {}),
    summary:
      status === "pass"
        ? `[forge.plugin.validate] OK — ${packs.length} pack(s) valid`
        : `[forge.plugin.validate] FAIL — ${packs.filter((p) => !p.valid).length} pack(s) with errors`,
  };
}

function runPluginDiscover(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): ForgeCommandResult<PluginDiscoverResult> {
  const workspaceRoot = context.workspaceRoot;
  const packs: PluginDiscoverResult["packs"] = [];

  try {
    const config = loadForgeConfig(workspaceRoot);

    if (!config.skillPacks || config.skillPacks.length === 0) {
      return {
        data: {
          command: "forge.plugin.discover",
          packs: [],
          count: 0,
        },
        summary: "[forge.plugin.discover] 0 packs discovered",
      };
    }

    for (const pack of config.skillPacks) {
      const packDir = path.resolve(workspaceRoot, pack.dir);
      const manifestPath = path.join(packDir, "forge.plugin.yaml");

      if (!fs.existsSync(manifestPath)) continue;

      let raw: string;
      try {
        raw = fs.readFileSync(manifestPath, "utf-8");
      } catch {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = parseYaml(raw);
      } catch {
        continue;
      }

      const result = forgePluginManifestSchema.safeParse(parsed);
      if (!result.success) continue;

      packs.push({
        prefix: pack.prefix,
        dir: pack.dir,
        manifestPath,
        id: result.data.id,
        version: result.data.version,
      });
    }
  } catch {
    // Config not found or invalid — return empty
  }

  return {
    data: {
      command: "forge.plugin.discover",
      packs,
      count: packs.length,
    },
    summary: `[forge.plugin.discover] ${packs.length} pack(s) discovered`,
  };
}

export const forgePluginModule: ForgeModule = {
  name: "forge-plugin",
  version: "0.1.0",
  async register(registry) {
    registry.registerCommand({
      name: "forge.plugin.validate",
      description:
        "Validate forge.plugin.yaml manifests for all declared skill packs (RFC-0941). Checks manifest schema (id: kebab-case, version: semver) and reports missing or invalid manifests.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {},
      reads: ["forge.yaml", "**/forge.plugin.yaml"],
      cacheable: false,
      execute: runPluginValidate,
    });

    registry.registerCommand({
      name: "forge.plugin.discover",
      description:
        "Enumerate all project-declared skill packs with valid forge.plugin.yaml manifests (RFC-0941). Returns pack id, version, prefix, and directory.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {},
      reads: ["forge.yaml", "**/forge.plugin.yaml"],
      cacheable: false,
      execute: runPluginDiscover,
    });
  },
};
