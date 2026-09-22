/*
<MODULE_CONTRACT>
<purpose>Non-interactive npm-token probe for the private @warpgogol registry scope (RFC-1125) — verifies the token can fetch @warpgogol/werkstatt-engine before pnpm install runs in forge create, and re-verifies post-install in forge.doctor.</purpose>
<keywords>npm, token, registry, onboarding, doctor, site-workshop</keywords>
<responsibilities>
  <item>Parses .npmrc for the @warpgogol scope registry and auth token presence.</item>
  <item>Probes the registry via `npm view @warpgogol/werkstatt-engine version` (injectable for tests).</item>
  <item>Returns a structured NpmTokenCheck with an actionable fixHint on failure.</item>
</responsibilities>
<non-goals>
  <item>Do not prompt the operator — the probe is non-interactive (create.ts forbids prompts).</item>
  <item>Do not accept tokens via CLI flags — tokens must not appear in argv/history.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1125: initial npm-token probe — checkNpmToken + readNpmrcTokenStatus, wired into scaffold-project (pre-install fail-fast) and doctor (post-install re-verify).</item>
</CHANGE_SUMMARY>
*/

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Result of the npm-token probe (RFC-1125). */
export interface NpmTokenCheck {
  /** Registry URL from `.npmrc` `@warpgogol:registry=` (null when undeclared). */
  registry: string | null;
  /** A usable token is configured — NPM_TOKEN env or a real _authToken value. */
  tokenPresent: boolean;
  /** `npm view @warpgogol/werkstatt-engine version` succeeded from workspaceRoot. */
  canFetch: boolean;
  /** Actionable remediation when canFetch is false; null on success. */
  fixHint: string | null;
}

/** Injectable dependencies for testing. */
export interface NpmTokenProbeDeps {
  /** Override the registry probe — return true when the fetch succeeds. */
  fetchVersion?: (cwd: string) => boolean;
  /** Override the environment (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

const WARPGOGOL_SCOPE = "@warpgogol";
const PROBE_PACKAGE = "@warpgogol/werkstatt-engine";
const PROBE_TIMEOUT_MS = 15_000;
const PLACEHOLDER_TOKENS = new Set(["YOUR_NPM_TOKEN", ""]);

/**
 * Parse the workspace `.npmrc` for the @warpgogol scope: registry URL and
 * whether a usable auth token is configured. A token counts as present when
 * NPM_TOKEN is set in the env, or when `_authToken` holds a real value
 * (not the YOUR_NPM_TOKEN placeholder, not an unset ${VAR} reference).
 */
export function readNpmrcTokenStatus(
  workspaceRoot: string,
  env: Record<string, string | undefined> = process.env,
): { registry: string | null; tokenPresent: boolean } {
  const npmrcPath = path.join(workspaceRoot, ".npmrc");
  const npmrc = fs.existsSync(npmrcPath) ? fs.readFileSync(npmrcPath, "utf8") : "";

  const registryMatch = npmrc.match(/^@warpgogol:registry=(\S+)\s*$/m);
  const registry = registryMatch?.[1] ?? null;

  // Token sources, in precedence order:
  // 1. NPM_TOKEN env (agent-driven installs; also satisfies ${NPM_TOKEN} refs)
  if (env.NPM_TOKEN && env.NPM_TOKEN.trim().length > 0) {
    return { registry, tokenPresent: true };
  }

  // 2. Literal _authToken in .npmrc for the scope's registry host.
  // `m` flag required — the token line is never last in a scaffolded .npmrc
  // (dangerously-allow-all-builds + appended ignore-workspace-root-check follow it).
  const tokenMatch = npmrc.match(/_authToken=(\S+)[ \t]*$/m);
  if (tokenMatch) {
    const value = tokenMatch[1];
    // ${VAR} references resolve at install time — count as present only when set
    const varRef = value.match(/^\$\{(\w+)\}$/);
    if (varRef) {
      const envValue = env[varRef[1]];
      return { registry, tokenPresent: !!envValue && envValue.trim().length > 0 };
    }
    return { registry, tokenPresent: !PLACEHOLDER_TOKENS.has(value) };
  }

  return { registry, tokenPresent: false };
}

/**
 * Whether the workspace needs the @warpgogol token at all — true when `.npmrc`
 * declares the scope or any install command pulls `@warpgogol/` packages.
 * Profiles without @warpgogol deps skip the probe entirely.
 */
export function workshopNeedsWarpgogolToken(workspaceRoot: string, installCmds: string[]): boolean {
  const npmrcPath = path.join(workspaceRoot, ".npmrc");
  if (fs.existsSync(npmrcPath)) {
    const npmrc = fs.readFileSync(npmrcPath, "utf8");
    if (npmrc.includes(`${WARPGOGOL_SCOPE}:registry`) || npmrc.includes(`${WARPGOGOL_SCOPE}/`)) {
      return true;
    }
  }
  return installCmds.some((cmd) => cmd.includes(`${WARPGOGOL_SCOPE}/`));
}

function defaultFetchVersion(cwd: string): boolean {
  try {
    execSync(`npm view ${PROBE_PACKAGE} version`, {
      cwd,
      stdio: "pipe",
      timeout: PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

function buildFixHint(tokenPresent: boolean): string {
  const base =
    `npm token for the @warpgogol scope cannot fetch ${PROBE_PACKAGE}. ` +
    `Set NPM_TOKEN env or replace YOUR_NPM_TOKEN in .npmrc with a valid npm read token ` +
    `(issued at workshop provisioning — see NEXT_STEPS.md §Token lifecycle).`;
  return tokenPresent
    ? `${base} A token is configured but was rejected — it may be expired or revoked; request a fresh one.`
    : base;
}

/**
 * Run the npm-token probe: parse `.npmrc`, then verify the registry actually
 * serves the package. Non-interactive — never prompts, never reads argv.
 */
export async function checkNpmToken(
  workspaceRoot: string,
  deps: NpmTokenProbeDeps = {},
): Promise<NpmTokenCheck> {
  const env = deps.env ?? process.env;
  const fetchVersion = deps.fetchVersion ?? defaultFetchVersion;
  const { registry, tokenPresent } = readNpmrcTokenStatus(workspaceRoot, env);
  const canFetch = fetchVersion(workspaceRoot);
  return {
    registry,
    tokenPresent,
    canFetch,
    fixHint: canFetch ? null : buildFixHint(tokenPresent),
  };
}
