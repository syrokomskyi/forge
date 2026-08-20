import { describe, it, expect } from "vitest";
import { resolveAllTerminology } from "../terminology-utils.ts";
import { defaultForgeConfig } from "../../config/forge-config.ts";
import { TERMINOLOGY_DEFAULTS } from "../profile-schema.ts";
import type { StackProfile } from "../stack-profile.ts";

function makeProfile(terminology?: Record<string, string>): StackProfile {
  return {
    schema: "forge/stack-profile@1",
    id: "test-profile",
    displayName: "Test",
    detect: { anyOf: ["package.json"] },
    workspace: { dirs: ["packages"], files: [] },
    install: [],
    terminology,
  };
}

describe("resolveAllTerminology", () => {
  it("returns universal defaults when no overrides exist", () => {
    const config = defaultForgeConfig("test");
    const profile = makeProfile();
    const result = resolveAllTerminology(config, profile);
    expect(result.artifact).toBe(TERMINOLOGY_DEFAULTS.artifact);
    expect(result.operator).toBe(TERMINOLOGY_DEFAULTS.operator);
  });

  it("profile terminology overrides universal defaults", () => {
    const config = defaultForgeConfig("test");
    const profile = makeProfile({ artifact: "widget" });
    const result = resolveAllTerminology(config, profile);
    expect(result.artifact).toBe("widget");
    expect(result.operator).toBe(TERMINOLOGY_DEFAULTS.operator);
  });

  it("project terminology overrides profile terminology", () => {
    const config = defaultForgeConfig("test");
    if (config.bindings) {
      config.bindings.terminology = { artifact: "project-widget" };
    }
    const profile = makeProfile({ artifact: "profile-widget" });
    const result = resolveAllTerminology(config, profile);
    expect(result.artifact).toBe("project-widget");
  });

  it("handles undefined profile", () => {
    const config = defaultForgeConfig("test");
    const result = resolveAllTerminology(config, undefined);
    expect(result.artifact).toBe(TERMINOLOGY_DEFAULTS.artifact);
  });

  it("handles undefined config bindings", () => {
    const config = defaultForgeConfig("test");
    delete config.bindings;
    const profile = makeProfile({ artifact: "widget" });
    const result = resolveAllTerminology(config, profile);
    expect(result.artifact).toBe("widget");
  });

  it("merges all three layers correctly", () => {
    const config = defaultForgeConfig("test");
    if (config.bindings) {
      config.bindings.terminology = { module: "project-module" };
    }
    const profile = makeProfile({ artifact: "profile-artifact", module: "profile-module" });
    const result = resolveAllTerminology(config, profile);
    expect(result.artifact).toBe("profile-artifact");
    expect(result.module).toBe("project-module");
    expect(result.operator).toBe(TERMINOLOGY_DEFAULTS.operator);
  });
});
