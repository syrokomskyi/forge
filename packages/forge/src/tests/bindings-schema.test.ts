/*
<MODULE_CONTRACT>
<purpose>Unit tests for RFC-0639 semantic bindings schema extensions — semantic command keys, terminology resolution chain, applyCliBindingDefaults with 5 new keys.</purpose>
<non-goals>
  <item>Do not test resolveBinding — covered in forge-config.test.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0639: initial test suite for semantic command keys, terminology resolution, and applyCliBindingDefaults.</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, test } from "vitest";
import {
  forgeBindingsSchema,
  applyCliBindingDefaults,
  resolveTerminology,
  defaultForgeConfig,
  type ForgeConfig,
} from "../config/forge-config.ts";
import { TERMINOLOGY_DEFAULTS } from "../profiles/profile-schema.ts";

describe("RFC-0639: Semantic command keys", () => {
  test("forgeBindingsSchema accepts semantic keys with string values", () => {
    const bindings = {
      schema: "forge/bindings@1",
      commands: {
        validateRfc: null,
        validateAdr: null,
        implementStamp: null,
        typecheck: null,
        test: null,
        scopedBuild: null,
        specValidate: null,
        sessionSave: null,
        validate: "npx editframe check",
        produce: "npx editframe render -o {output}",
        verify: "npx editframe render --dry-run",
        preview: "npx editframe preview",
        lint: "npx editframe check --strict",
      },
      paths: {
        invariantsFile: null,
        compassDocs: [],
        reviewsDir: null,
        handoffsDir: null,
        sessionsDir: null,
      },
    };
    const result = forgeBindingsSchema.safeParse(bindings);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands.validate).toBe("npx editframe check");
      expect(result.data.commands.produce).toBe("npx editframe render -o {output}");
    }
  });

  test("forgeBindingsSchema defaults semantic keys to null when absent", () => {
    const bindings = {
      schema: "forge/bindings@1",
      commands: {
        validateRfc: null,
        validateAdr: null,
        implementStamp: null,
        typecheck: null,
        test: null,
        scopedBuild: null,
        specValidate: null,
        sessionSave: null,
      },
      paths: {
        invariantsFile: null,
        compassDocs: [],
        reviewsDir: null,
        handoffsDir: null,
        sessionsDir: null,
      },
    };
    const result = forgeBindingsSchema.safeParse(bindings);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands.validate).toBeNull();
      expect(result.data.commands.produce).toBeNull();
      expect(result.data.commands.verify).toBeNull();
      expect(result.data.commands.preview).toBeNull();
      expect(result.data.commands.lint).toBeNull();
    }
  });

  test("existing forge.yaml with only original 8 keys parses without changes", () => {
    const bindings = {
      schema: "forge/bindings@1",
      commands: {
        validateRfc: "forge rfc.validate --id {id} --json",
        validateAdr: "forge adr.validate --id {id} --json",
        implementStamp: "forge rfc.implement.stamp --id {id} --implementation-commit {commit}",
        typecheck: "pnpm --filter {workspace} run build:check",
        test: "pnpm --filter {workspace} run test",
        scopedBuild: "pnpm --filter {workspace} run build",
        specValidate: "forge spec.validate --spec={id} --json",
        sessionSave: "forge session.save --json",
      },
      paths: {
        invariantsFile: "docs/architecture-dna.md",
        compassDocs: [],
        reviewsDir: "docs/reviews",
        handoffsDir: "docs/handoffs",
        sessionsDir: "docs/sessions",
      },
    };
    const result = forgeBindingsSchema.safeParse(bindings);
    expect(result.success).toBe(true);
  });
});

describe("RFC-0639: Terminology schema change", () => {
  test("terminology defaults to empty record when absent", () => {
    const bindings = {
      schema: "forge/bindings@1",
      commands: {
        validateRfc: null,
        validateAdr: null,
        implementStamp: null,
        typecheck: null,
        test: null,
        scopedBuild: null,
        specValidate: null,
        sessionSave: null,
      },
      paths: {
        invariantsFile: null,
        compassDocs: [],
        reviewsDir: null,
        handoffsDir: null,
        sessionsDir: null,
      },
    };
    const result = forgeBindingsSchema.safeParse(bindings);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.terminology).toEqual({});
    }
  });

  test("terminology accepts a record of string-to-string", () => {
    const bindings = {
      schema: "forge/bindings@1",
      commands: {
        validateRfc: null,
        validateAdr: null,
        implementStamp: null,
        typecheck: null,
        test: null,
        scopedBuild: null,
        specValidate: null,
        sessionSave: null,
      },
      paths: {
        invariantsFile: null,
        compassDocs: [],
        reviewsDir: null,
        handoffsDir: null,
        sessionsDir: null,
      },
      terminology: { artifact: "composition", module: "scene" },
    };
    const result = forgeBindingsSchema.safeParse(bindings);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.terminology.artifact).toBe("composition");
      expect(result.data.terminology.module).toBe("scene");
    }
  });
});

describe("RFC-0639: applyCliBindingDefaults", () => {
  test("returns 13 keys with semantic keys as null", () => {
    const commands = applyCliBindingDefaults("pnpm");
    // CLI-backed keys are non-null
    expect(commands.validateRfc).not.toBeNull();
    expect(commands.validateAdr).not.toBeNull();
    expect(commands.implementStamp).not.toBeNull();
    expect(commands.specValidate).not.toBeNull();
    expect(commands.sessionSave).not.toBeNull();
    // Software-domain keys are null
    expect(commands.typecheck).toBeNull();
    expect(commands.test).toBeNull();
    expect(commands.scopedBuild).toBeNull();
    // Semantic keys (RFC-0639) are null
    expect(commands.validate).toBeNull();
    expect(commands.produce).toBeNull();
    expect(commands.verify).toBeNull();
    expect(commands.preview).toBeNull();
    expect(commands.lint).toBeNull();
  });
});

describe("RFC-0639: resolveTerminology", () => {
  const baseConfig: ForgeConfig = {
    schema: "forge/config@1",
    project: { name: "test", stack: [], packageManager: "pnpm" },
    paths: {
      rfcsDir: "docs/rfcs",
      adrsDir: "docs/adrs",
      plansDir: "docs/plans",
      auditsDir: "docs/audits",
      specsDir: "docs/specs",
      skillsDir: ".agents/skills",
      sessionsDir: "docs/sessions",
    },
    bindings: {
      schema: "forge/bindings@1",
      commands: {
        validateRfc: null,
        validateAdr: null,
        implementStamp: null,
        typecheck: null,
        test: null,
        scopedBuild: null,
        specValidate: null,
        sessionSave: null,
        validate: null,
        produce: null,
        verify: null,
        preview: null,
        lint: null,
      },
      paths: {
        invariantsFile: null,
        compassDocs: [],
        reviewsDir: null,
        handoffsDir: null,
        sessionsDir: null,
      },
      terminology: {},
    },
  };

  test("tier 1: returns bindings terminology override when present", () => {
    const config: ForgeConfig = {
      ...baseConfig,
      bindings: {
        ...baseConfig.bindings!,
        terminology: { artifact: "composition" },
      },
    };
    expect(resolveTerminology(config, undefined, "artifact")).toBe("composition");
  });

  test("tier 2: returns caller-provided terminology when bindings don't have the key", () => {
    const config: ForgeConfig = {
      ...baseConfig,
      bindings: {
        ...baseConfig.bindings!,
        terminology: {},
      },
    };
    const profileTerminology = { artifact: "scene" };
    expect(resolveTerminology(config, profileTerminology, "artifact")).toBe("scene");
  });

  test("tier 3: returns universal default when neither bindings nor caller-provided have the key", () => {
    const config: ForgeConfig = {
      ...baseConfig,
      bindings: {
        ...baseConfig.bindings!,
        terminology: {},
      },
    };
    expect(resolveTerminology(config, undefined, "artifact")).toBe(
      TERMINOLOGY_DEFAULTS.artifact,
    );
    expect(resolveTerminology(config, undefined, "module")).toBe(
      TERMINOLOGY_DEFAULTS.module,
    );
    expect(resolveTerminology(config, undefined, "operator")).toBe(
      TERMINOLOGY_DEFAULTS.operator,
    );
  });

  test("fallback: returns the key itself when not found in any tier", () => {
    const config: ForgeConfig = {
      ...baseConfig,
      bindings: {
        ...baseConfig.bindings!,
        terminology: {},
      },
    };
    expect(resolveTerminology(config, undefined, "nonexistent")).toBe("nonexistent");
  });

  test("works with undefined terminology parameter (skips tier 2)", () => {
    const config: ForgeConfig = {
      ...baseConfig,
      bindings: {
        ...baseConfig.bindings!,
        terminology: {},
      },
    };
    expect(resolveTerminology(config, undefined, "artifact")).toBe("artifact");
  });

  test("bindings override takes precedence over caller-provided terminology", () => {
    const config: ForgeConfig = {
      ...baseConfig,
      bindings: {
        ...baseConfig.bindings!,
        terminology: { artifact: "composition" },
      },
    };
    const profileTerminology = { artifact: "scene" };
    expect(resolveTerminology(config, profileTerminology, "artifact")).toBe("composition");
  });

  test("works with defaultForgeConfig", () => {
    const config = defaultForgeConfig("test-project", "pnpm");
    expect(resolveTerminology(config, undefined, "artifact")).toBe("artifact");
    expect(resolveTerminology(config, undefined, "source")).toBe("source file");
  });
});
