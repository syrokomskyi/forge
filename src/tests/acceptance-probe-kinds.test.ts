// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { validateAcceptanceShape, runProbe } from "../../os/rfc/acceptance.ts";
import type { AcceptanceProbe } from "../../os/rfc/types.ts";

const mockSpawn = vi.hoisted(() => {
  return vi.fn();
});

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

function createMockChild(exitCode: number | null): {
  child: EventEmitter & { kill: () => void };
} {
  const child = new EventEmitter() as EventEmitter & { kill: () => void };
  child.kill = vi.fn();
  mockSpawn.mockReturnValueOnce(child);
  process.nextTick(() => {
    child.emit("close", exitCode);
  });
  return { child };
}

describe("validateAcceptanceShape — test probe", () => {
  it("accepts a well-formed test probe", () => {
    const issues = validateAcceptanceShape([
      { probe: "test", file: "src/test.ts", expect: { exitCode: 0 }, criterion: "AC-1" },
    ]);
    expect(issues).toEqual([]);
  });

  it("rejects a test probe missing file", () => {
    const issues = validateAcceptanceShape([
      { probe: "test", expect: { exitCode: 0 } },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('requires a string "file"');
  });

  it("rejects a test probe missing expect.exitCode", () => {
    const issues = validateAcceptanceShape([
      { probe: "test", file: "src/test.ts" },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("requires expect: { exitCode");
  });

  it("rejects a test probe with non-string testName", () => {
    const issues = validateAcceptanceShape([
      { probe: "test", file: "src/test.ts", testName: 123, expect: { exitCode: 0 } },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("testName must be a string");
  });
});

describe("validateAcceptanceShape — json-schema probe", () => {
  it("accepts a well-formed json-schema probe", () => {
    const issues = validateAcceptanceShape([
      {
        probe: "json-schema",
        artifact: "docs/config.json",
        schemaInline: { type: "object" },
        criterion: "AC-3",
      },
    ]);
    expect(issues).toEqual([]);
  });

  it("rejects a json-schema probe missing artifact", () => {
    const issues = validateAcceptanceShape([
      { probe: "json-schema", schemaInline: { type: "object" } },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('requires a string "artifact"');
  });

  it("rejects a json-schema probe missing schemaInline", () => {
    const issues = validateAcceptanceShape([
      { probe: "json-schema", artifact: "docs/config.json" },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('requires an object "schemaInline"');
  });
});

describe("validateAcceptanceShape — unknown probe kind", () => {
  it("lists test and json-schema in the expected kinds", () => {
    const issues = validateAcceptanceShape([{ probe: "unknown-kind" }]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("test");
    expect(issues[0].message).toContain("json-schema");
  });
});

describe("validateAcceptanceShape — existing probe kinds (regression)", () => {
  it("accepts well-formed run probe", () => {
    const issues = validateAcceptanceShape([
      { probe: "run", command: "werkstatt test", expect: { exitCode: 0 } },
    ]);
    expect(issues).toEqual([]);
  });

  it("accepts well-formed file-exists probe", () => {
    const issues = validateAcceptanceShape([
      { probe: "file-exists", path: "src/index.ts" },
    ]);
    expect(issues).toEqual([]);
  });

  it("accepts well-formed file-contains probe", () => {
    const issues = validateAcceptanceShape([
      { probe: "file-contains", path: "src/index.ts", pattern: "export" },
    ]);
    expect(issues).toEqual([]);
  });

  it("accepts well-formed command-registered probe", () => {
    const issues = validateAcceptanceShape([
      { probe: "command-registered", name: "rfc.validate" },
    ]);
    expect(issues).toEqual([]);
  });

  it("accepts well-formed page probe", () => {
    const issues = validateAcceptanceShape([
      { probe: "page", path: "/about" },
    ]);
    expect(issues).toEqual([]);
  });
});

describe("runProbe — test probe", () => {
  beforeEach(() => {
    mockSpawn.mockClear();
  });

  it("returns ok:true when vitest exits with expected code (AC-1)", async () => {
    createMockChild(0);
    const probe: AcceptanceProbe = {
      probe: "test",
      file: "src/foo.test.ts",
      expect: { exitCode: 0 },
      criterion: "AC-1",
    };
    const result = await runProbe(probe, "/fake/workspace");
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("exitCode=0");
  });

  it("returns ok:false when vitest exits with unexpected code (AC-2)", async () => {
    createMockChild(1);
    const probe: AcceptanceProbe = {
      probe: "test",
      file: "src/foo.test.ts",
      expect: { exitCode: 0 },
      criterion: "AC-2",
    };
    const result = await runProbe(probe, "/fake/workspace");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("exitCode=1");
  });

  it("passes testName as -t argument to vitest", async () => {
    createMockChild(0);
    const probe: AcceptanceProbe = {
      probe: "test",
      file: "src/foo.test.ts",
      testName: "my test",
      expect: { exitCode: 0 },
    };
    await runProbe(probe, "/fake/workspace");
    expect(mockSpawn).toHaveBeenCalledWith(
      "pnpm",
      ["exec", "vitest", "run", "src/foo.test.ts", "-t", "my test"],
      { cwd: "/fake/workspace", stdio: "ignore" },
    );
  });
});

describe("runProbe — json-schema probe", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "rfc0998-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns ok:true when artifact matches schema (AC-3)", async () => {
    const artifactPath = path.join(tempDir, "valid.json");
    await writeFile(artifactPath, JSON.stringify({ name: "test", version: 1 }));
    const probe: AcceptanceProbe = {
      probe: "json-schema",
      artifact: path.relative("/fake/workspace", artifactPath),
      schemaInline: {
        type: "object",
        properties: {
          name: { type: "string" },
          version: { type: "number" },
        },
        required: ["name", "version"],
      },
      criterion: "AC-3",
    };
    const result = await runProbe(probe, tempDir);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("schema valid");
  });

  it("returns ok:false when artifact does not match schema (AC-4)", async () => {
    const artifactPath = path.join(tempDir, "invalid.json");
    await writeFile(artifactPath, JSON.stringify({ name: 123 }));
    const probe: AcceptanceProbe = {
      probe: "json-schema",
      artifact: "invalid.json",
      schemaInline: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      },
      criterion: "AC-4",
    };
    const result = await runProbe(probe, tempDir);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Ajv error");
  });

  it("returns ok:false when artifact file not found", async () => {
    const probe: AcceptanceProbe = {
      probe: "json-schema",
      artifact: "nonexistent.json",
      schemaInline: { type: "object" },
    };
    const result = await runProbe(probe, tempDir);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("artifact file not found");
  });

  it("returns ok:false when artifact is unparseable", async () => {
    const artifactPath = path.join(tempDir, "bad.json");
    await writeFile(artifactPath, "{ not valid json");
    const probe: AcceptanceProbe = {
      probe: "json-schema",
      artifact: "bad.json",
      schemaInline: { type: "object" },
    };
    const result = await runProbe(probe, tempDir);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("could not be parsed");
  });
});
