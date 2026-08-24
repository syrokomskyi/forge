import { test, expect, describe } from "vitest";
import { forgePluginManifestSchema } from "../plugin/ForgePluginManifest.ts";

describe("forgePluginManifestSchema (RFC-0941)", () => {
  test("accepts valid manifest with id and version", () => {
    const result = forgePluginManifestSchema.safeParse({
      id: "wg",
      version: "1.0.0",
    });
    expect(result.success).toBe(true);
  });

  test("accepts hyphenated kebab-case id", () => {
    const result = forgePluginManifestSchema.safeParse({
      id: "my-cool-pack",
      version: "0.1.0",
    });
    expect(result.success).toBe(true);
  });

  test("accepts semver pre-release version", () => {
    const result = forgePluginManifestSchema.safeParse({
      id: "wg",
      version: "1.0.0-beta.1",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing id", () => {
    const result = forgePluginManifestSchema.safeParse({
      version: "1.0.0",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing version", () => {
    const result = forgePluginManifestSchema.safeParse({
      id: "wg",
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-kebab-case id (uppercase)", () => {
    const result = forgePluginManifestSchema.safeParse({
      id: "Wg",
      version: "1.0.0",
    });
    expect(result.success).toBe(false);
  });

  test("rejects id with underscores", () => {
    const result = forgePluginManifestSchema.safeParse({
      id: "my_pack",
      version: "1.0.0",
    });
    expect(result.success).toBe(false);
  });

  test("rejects id starting with digit", () => {
    const result = forgePluginManifestSchema.safeParse({
      id: "1wg",
      version: "1.0.0",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid semver version", () => {
    const result = forgePluginManifestSchema.safeParse({
      id: "wg",
      version: "1.0",
    });
    expect(result.success).toBe(false);
  });

  test("rejects extra fields (strict schema)", () => {
    const result = forgePluginManifestSchema.safeParse({
      id: "wg",
      version: "1.0.0",
      extensionPoints: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-string id", () => {
    const result = forgePluginManifestSchema.safeParse({
      id: 123,
      version: "1.0.0",
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty object", () => {
    const result = forgePluginManifestSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
