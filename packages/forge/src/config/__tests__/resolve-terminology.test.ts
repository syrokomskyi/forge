import { describe, it, expect } from "vitest";
import { resolveTerminology, defaultForgeConfig, type ForgeConfig } from "../forge-config.ts";
import { TERMINOLOGY_DEFAULTS } from "../../profiles/profile-schema.ts";

describe("resolveTerminology", () => {
  function makeConfig(terminology?: Record<string, string>): ForgeConfig {
    const config = defaultForgeConfig("test");
    if (terminology && config.bindings) {
      config.bindings.terminology = terminology;
    }
    return config;
  }

  it("returns universal default when no overrides exist", () => {
    const config = makeConfig();
    expect(resolveTerminology(config, undefined, "artifact")).toBe(TERMINOLOGY_DEFAULTS.artifact);
    expect(resolveTerminology(config, undefined, "operator")).toBe(TERMINOLOGY_DEFAULTS.operator);
  });

  it("returns the key itself when not found in any tier", () => {
    const config = makeConfig();
    expect(resolveTerminology(config, undefined, "nonexistent")).toBe("nonexistent");
  });

  it("tier 1: per-project bindings.terminology overrides everything", () => {
    const config = makeConfig({ artifact: "widget" });
    expect(resolveTerminology(config, { artifact: "module" }, "artifact")).toBe("widget");
  });

  it("tier 2: caller-provided terminology overrides universal default", () => {
    const config = makeConfig();
    expect(resolveTerminology(config, { artifact: "custom" }, "artifact")).toBe("custom");
  });

  it("tier 3: universal default used when tiers 1 and 2 are absent", () => {
    const config = makeConfig();
    expect(resolveTerminology(config, undefined, "module")).toBe(TERMINOLOGY_DEFAULTS.module);
  });

  it("handles undefined bindings entirely", () => {
    const config = defaultForgeConfig("test");
    delete config.bindings;
    expect(resolveTerminology(config, { artifact: "thing" }, "artifact")).toBe("thing");
  });
});
