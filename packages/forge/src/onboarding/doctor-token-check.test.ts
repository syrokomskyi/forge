/*
<MODULE_CONTRACT>
<purpose>Unit tests for the npm-token probe (RFC-1125, AC-2) — .npmrc parsing, token presence detection, and the fail-fast fixHint contract used by forge create and forge.doctor.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1125: initial npm-token probe tests (AC-2 evidence).</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkNpmToken,
  readNpmrcTokenStatus,
  workshopNeedsWarpgogolToken,
} from "./npm-token-check.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "npm-token-check-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const NPMRC_WITH_TOKEN = `@warpgogol:registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=npm_real_token_123
`;

const NPMRC_PLACEHOLDER = `@warpgogol:registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=YOUR_NPM_TOKEN
`;

const NPMRC_ENV_REF = `@warpgogol:registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=\${NPM_TOKEN}
`;

// --- readNpmrcTokenStatus ---

test("detects registry and literal token from .npmrc", async () => {
  await writeFile(join(tempDir, ".npmrc"), NPMRC_WITH_TOKEN);
  const status = readNpmrcTokenStatus(tempDir, {});
  expect(status.registry).toBe("https://registry.npmjs.org/");
  expect(status.tokenPresent).toBe(true);
});

test("YOUR_NPM_TOKEN placeholder does not count as a token", async () => {
  await writeFile(join(tempDir, ".npmrc"), NPMRC_PLACEHOLDER);
  const status = readNpmrcTokenStatus(tempDir, {});
  expect(status.tokenPresent).toBe(false);
});

test("NPM_TOKEN env satisfies the probe even with placeholder .npmrc", async () => {
  await writeFile(join(tempDir, ".npmrc"), NPMRC_PLACEHOLDER);
  const status = readNpmrcTokenStatus(tempDir, { NPM_TOKEN: "npm_env_token" });
  expect(status.tokenPresent).toBe(true);
});

test("${NPM_TOKEN} reference resolves against env", async () => {
  await writeFile(join(tempDir, ".npmrc"), NPMRC_ENV_REF);
  expect(readNpmrcTokenStatus(tempDir, { NPM_TOKEN: "x" }).tokenPresent).toBe(true);
  expect(readNpmrcTokenStatus(tempDir, {}).tokenPresent).toBe(false);
});

test("missing .npmrc → no registry, no token", () => {
  const status = readNpmrcTokenStatus(tempDir, {});
  expect(status.registry).toBeNull();
  expect(status.tokenPresent).toBe(false);
});

// --- workshopNeedsWarpgogolToken ---

test("needs token when .npmrc declares @warpgogol scope", async () => {
  await writeFile(join(tempDir, ".npmrc"), NPMRC_PLACEHOLDER);
  expect(workshopNeedsWarpgogolToken(tempDir, [])).toBe(true);
});

test("needs token when install pulls @warpgogol packages", () => {
  expect(workshopNeedsWarpgogolToken(tempDir, ["pnpm add -wD @warpgogol/forge"])).toBe(true);
});

test("skips probe when no @warpgogol usage", () => {
  expect(workshopNeedsWarpgogolToken(tempDir, ["pnpm add -wD prettier"])).toBe(false);
});

// --- checkNpmToken ---

test("canFetch=true → fixHint is null", async () => {
  await writeFile(join(tempDir, ".npmrc"), NPMRC_WITH_TOKEN);
  const result = await checkNpmToken(tempDir, { fetchVersion: () => true, env: {} });
  expect(result.canFetch).toBe(true);
  expect(result.fixHint).toBeNull();
});

test("canFetch=false with token → fixHint mentions expiry/revocation", async () => {
  await writeFile(join(tempDir, ".npmrc"), NPMRC_WITH_TOKEN);
  const result = await checkNpmToken(tempDir, { fetchVersion: () => false, env: {} });
  expect(result.canFetch).toBe(false);
  expect(result.fixHint).toContain("expired or revoked");
});

test("canFetch=false without token → fixHint names NPM_TOKEN and .npmrc", async () => {
  await writeFile(join(tempDir, ".npmrc"), NPMRC_PLACEHOLDER);
  const result = await checkNpmToken(tempDir, { fetchVersion: () => false, env: {} });
  expect(result.canFetch).toBe(false);
  // AC-2: the fixHint must be actionable — name the exact remediation path
  expect(result.fixHint).toContain("NPM_TOKEN");
  expect(result.fixHint).toContain(".npmrc");
});
