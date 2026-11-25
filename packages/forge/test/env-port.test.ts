/* Env port — allowlist-enforced secrets-adjacent access (envKeys manifest dimension). */
import { describe, expect, it } from "vitest";

import { createPluginContext } from "../src/sdk/context.ts";
import { CapabilityViolation, type PluginManifest } from "../src/sdk/types.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

function ctx(envKeys?: string[]) {
  const manifest: PluginManifest = {
    id: "env-test",
    version: "1.0.0",
    forgeRange: "^10.0.0",
    capabilities: { filesystem: "read", processSpawn: false, network: false, gitMutation: false, ...(envKeys ? { envKeys } : {}) },
    registers: {},
  };
  return createPluginContext(manifest, { workspaceRoot: mkTmp("forge-env-") });
}

describe("env port", () => {
  it("declared keys read through", () => {
    process.env.FORGE_TEST_KEY = "test-value";
    const c = ctx(["FORGE_TEST_KEY"]);
    expect(c.env.get("FORGE_TEST_KEY")).toBe("test-value");
    expect(c.env.declared("FORGE_TEST_KEY")).toBe(true);
    delete process.env.FORGE_TEST_KEY;
  });
  it("undeclared keys refuse with CapabilityViolation", () => {
    const c = ctx(["FORGE_TEST_KEY"]);
    expect(() => c.env.get("HOME")).toThrow(CapabilityViolation);
    expect(() => c.env.get("PATH")).toThrow(CapabilityViolation);
    expect(c.env.declared("HOME")).toBe(false);
  });
  it("missing envKeys dimension refuses everything", () => {
    const c = ctx();
    expect(() => c.env.get("ANYTHING")).toThrow(CapabilityViolation);
  });
  it("declared-but-unset keys return undefined without violation", () => {
    const c = ctx(["DEFINITELY_UNSET_FORGE_VAR"]);
    expect(c.env.get("DEFINITELY_UNSET_FORGE_VAR")).toBeUndefined();
  });
});
