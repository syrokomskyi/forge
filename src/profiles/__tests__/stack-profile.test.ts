import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadStackProfile,
  listStackProfiles,
  detectStack,
  stackProfileSchema,
} from "../stack-profile.ts";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-profile-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const validProfileYaml = `
schema: forge/stack-profile@1
id: test-stack
displayName: Test Stack
detect:
  anyOf:
    - package.json
workspace:
  dirs:
    - packages
  files:
    - path: package.json
      content: '{}'
install: []
`;

describe("stackProfileSchema", () => {
  it("accepts a valid minimal profile", () => {
    const result = stackProfileSchema.safeParse({
      schema: "forge/stack-profile@1",
      id: "test",
      displayName: "Test",
      detect: { anyOf: ["package.json"] },
      workspace: { dirs: ["packages"], files: [] },
      install: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects wrong schema literal", () => {
    const result = stackProfileSchema.safeParse({
      schema: "wrong",
      id: "test",
      displayName: "Test",
      detect: { anyOf: ["package.json"] },
      workspace: { dirs: ["packages"], files: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty anyOf array", () => {
    const result = stackProfileSchema.safeParse({
      schema: "forge/stack-profile@1",
      id: "test",
      displayName: "Test",
      detect: { anyOf: [] },
      workspace: { dirs: ["packages"], files: [] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional domain fields", () => {
    const result = stackProfileSchema.safeParse({
      schema: "forge/stack-profile@1",
      id: "test",
      displayName: "Test",
      detect: { anyOf: ["package.json"] },
      workspace: { dirs: ["packages"], files: [] },
      install: [],
      domain: "software",
      terminology: { artifact: "module" },
      register: "business",
    });
    expect(result.success).toBe(true);
  });
});

describe("loadStackProfile", () => {
  it("loads a valid YAML profile", async () => {
    const profilePath = join(tempDir, "test.yaml");
    await writeFile(profilePath, validProfileYaml, "utf8");
    const profile = loadStackProfile(profilePath);
    expect(profile.id).toBe("test-stack");
    expect(profile.displayName).toBe("Test Stack");
  });

  it("throws on invalid YAML", async () => {
    const profilePath = join(tempDir, "bad.yaml");
    await writeFile(profilePath, "not: valid: yaml: [", "utf8");
    expect(() => loadStackProfile(profilePath)).toThrow();
  });

  it("throws on schema validation failure", async () => {
    const profilePath = join(tempDir, "invalid.yaml");
    await writeFile(profilePath, "schema: wrong\nid: test\n", "utf8");
    expect(() => loadStackProfile(profilePath)).toThrow();
  });
});

describe("listStackProfiles", () => {
  it("returns empty array when profiles dir missing", () => {
    expect(listStackProfiles(join(tempDir, "nonexistent"))).toEqual([]);
  });

  it("lists all .yaml profiles in the directory", async () => {
    const profilesDir = join(tempDir, "profiles");
    await mkdir(profilesDir, { recursive: true });
    await writeFile(join(profilesDir, "a.yaml"), validProfileYaml, "utf8");
    await writeFile(
      join(profilesDir, "b.yaml"),
      validProfileYaml.replace("test-stack", "test-stack-b"),
      "utf8",
    );
    await writeFile(join(profilesDir, ".hidden.yaml"), validProfileYaml, "utf8");

    const profiles = listStackProfiles(tempDir);
    expect(profiles).toHaveLength(2);
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain("test-stack");
    expect(ids).toContain("test-stack-b");
  });
});

describe("detectStack", () => {
  it("detects matching profile", async () => {
    await writeFile(join(tempDir, "package.json"), "{}", "utf8");
    const profiles = [
      {
        schema: "forge/stack-profile@1" as const,
        id: "a",
        displayName: "A",
        detect: { anyOf: ["package.json"] },
        workspace: { dirs: [], files: [] },
        install: [],
      },
      {
        schema: "forge/stack-profile@1" as const,
        id: "b",
        displayName: "B",
        detect: { anyOf: ["nonexistent.file"] },
        workspace: { dirs: [], files: [] },
        install: [],
      },
    ];

    const result = detectStack(tempDir, profiles);
    expect(result?.id).toBe("a");
  });

  it("returns null when no profile matches", () => {
    const profiles = [
      {
        schema: "forge/stack-profile@1" as const,
        id: "x",
        displayName: "X",
        detect: { anyOf: ["nonexistent.file"] },
        workspace: { dirs: [], files: [] },
        install: [],
      },
    ];
    expect(detectStack(tempDir, profiles)).toBeNull();
  });

  it("supports glob patterns in detect.anyOf", async () => {
    await writeFile(join(tempDir, "astro.config.mjs"), "export default {}", "utf8");
    const profiles = [
      {
        schema: "forge/stack-profile@1" as const,
        id: "astro",
        displayName: "Astro",
        detect: { anyOf: ["astro.config.*"] },
        workspace: { dirs: [], files: [] },
        install: [],
      },
    ];
    const result = detectStack(tempDir, profiles);
    expect(result?.id).toBe("astro");
  });
});
