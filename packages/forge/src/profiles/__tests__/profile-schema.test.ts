import { describe, it, expect } from "vitest";
import {
  profileInvariantSchema,
  profileInvariantCheckSchema,
  profileDevServerSchema,
  profileReleaseSchema,
  profilePrerequisiteSchema,
  profileArtifactSchema,
  UNIVERSAL_TERMINOLOGY_KEYS,
  TERMINOLOGY_DEFAULTS,
} from "../profile-schema.ts";

describe("UNIVERSAL_TERMINOLOGY_KEYS", () => {
  it("contains expected keys", () => {
    expect(UNIVERSAL_TERMINOLOGY_KEYS).toContain("artifact");
    expect(UNIVERSAL_TERMINOLOGY_KEYS).toContain("module");
    expect(UNIVERSAL_TERMINOLOGY_KEYS).toContain("operator");
  });
});

describe("TERMINOLOGY_DEFAULTS", () => {
  it("has defaults for all universal keys", () => {
    for (const key of UNIVERSAL_TERMINOLOGY_KEYS) {
      expect(TERMINOLOGY_DEFAULTS[key]).toBeDefined();
    }
  });
});

describe("profileArtifactSchema", () => {
  it("accepts minimal artifact with id and extensions", () => {
    const result = profileArtifactSchema.safeParse({
      id: "html-pages",
      extensions: [".html"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts artifact with produce and validate", () => {
    const result = profileArtifactSchema.safeParse({
      id: "html-pages",
      extensions: [".html"],
      produce: { command: "astro build", output: "dist" },
      validate: { command: "check", outputFormat: "json" },
      determinism: { hashable: true, inputs: ["src"] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects artifact without id", () => {
    const result = profileArtifactSchema.safeParse({ extensions: [".html"] });
    expect(result.success).toBe(false);
  });

  it("accepts artifact with empty extensions array", () => {
    const result = profileArtifactSchema.safeParse({ id: "test", extensions: [] });
    expect(result.success).toBe(true);
  });
});

describe("profileInvariantCheckSchema", () => {
  it("accepts filename-pattern kind", () => {
    const result = profileInvariantCheckSchema.safeParse({
      kind: "filename-pattern",
      glob: "*.ts",
      pattern: "^[a-z-]+\\.ts$",
    });
    expect(result.success).toBe(true);
  });

  it("accepts attribute-pattern kind with required fields", () => {
    const result = profileInvariantCheckSchema.safeParse({
      kind: "attribute-pattern",
      elements: ["img"],
      attribute: "src",
      pattern: "^/assets/",
    });
    expect(result.success).toBe(true);
  });

  it("rejects attribute-pattern without elements", () => {
    const result = profileInvariantCheckSchema.safeParse({
      kind: "attribute-pattern",
      attribute: "src",
      pattern: "^/assets/",
    });
    expect(result.success).toBe(false);
  });

  it("rejects attribute-pattern with empty elements array", () => {
    const result = profileInvariantCheckSchema.safeParse({
      kind: "attribute-pattern",
      elements: [],
      attribute: "src",
      pattern: "^/assets/",
    });
    expect(result.success).toBe(false);
  });

  it("accepts frontmatter-required with fields", () => {
    const result = profileInvariantCheckSchema.safeParse({
      kind: "frontmatter-required",
      fields: ["title", "created"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects frontmatter-required without fields", () => {
    const result = profileInvariantCheckSchema.safeParse({
      kind: "frontmatter-required",
    });
    expect(result.success).toBe(false);
  });
});

describe("profileInvariantSchema", () => {
  it("accepts valid invariant with id matching pattern", () => {
    const result = profileInvariantSchema.safeParse({
      id: "VIDEO-01",
      rule: "All videos must have captions",
      severity: "error",
    });
    expect(result.success).toBe(true);
  });

  it("rejects id not matching ^[A-Z]+-\\d+$ pattern", () => {
    const result = profileInvariantSchema.safeParse({
      id: "video-01",
      rule: "test",
      severity: "error",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid severity", () => {
    const result = profileInvariantSchema.safeParse({
      id: "VIDEO-01",
      rule: "test",
      severity: "critical",
    });
    expect(result.success).toBe(false);
  });
});

describe("profileDevServerSchema", () => {
  it("accepts minimal dev server with command", () => {
    const result = profileDevServerSchema.safeParse({ command: "astro dev" });
    expect(result.success).toBe(true);
  });

  it("accepts dev server with port and timeout", () => {
    const result = profileDevServerSchema.safeParse({
      command: "astro dev",
      port: 4321,
      readinessTimeout: 5000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty command", () => {
    const result = profileDevServerSchema.safeParse({ command: "" });
    expect(result.success).toBe(false);
  });

  it("rejects negative port", () => {
    const result = profileDevServerSchema.safeParse({ command: "dev", port: -1 });
    expect(result.success).toBe(false);
  });
});

describe("profileReleaseSchema", () => {
  it("accepts local release target", () => {
    const result = profileReleaseSchema.safeParse({
      target: "local",
      outputDir: "dist",
    });
    expect(result.success).toBe(true);
  });

  it("accepts r2 release target with required fields", () => {
    const result = profileReleaseSchema.safeParse({
      target: "r2",
      outputDir: "dist",
      r2: { bucket: "my-bucket", accountId: "123" },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data?.manifestName).toBe("release-manifest.json");
  });

  it("rejects invalid target", () => {
    const result = profileReleaseSchema.safeParse({
      target: "invalid",
      outputDir: "dist",
    });
    expect(result.success).toBe(false);
  });
});

describe("profilePrerequisiteSchema", () => {
  it("accepts minimal prerequisite", () => {
    const result = profilePrerequisiteSchema.safeParse({
      id: "ffmpeg",
      name: "FFmpeg",
      check: "ffmpeg -version",
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data?.severity).toBe("error");
  });

  it("accepts warning severity", () => {
    const result = profilePrerequisiteSchema.safeParse({
      id: "ffmpeg",
      name: "FFmpeg",
      check: "ffmpeg -version",
      severity: "warning",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid severity", () => {
    const result = profilePrerequisiteSchema.safeParse({
      id: "ffmpeg",
      name: "FFmpeg",
      check: "ffmpeg -version",
      severity: "critical",
    });
    expect(result.success).toBe(false);
  });
});
