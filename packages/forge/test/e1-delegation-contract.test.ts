/*
E1 delegation contract proofs (WP-8 endgame prerequisite):
1. --json envelope carries exitCode + summary authoritatively (shapeJsonOutput)
2. plugin info logs write to stderr, never stdout — stream separation
*/
import { describe, expect, it, vi } from "vitest";

import { shapeJsonOutput } from "../src/cli-output.ts";

describe("shapeJsonOutput", () => {
  it("carries exitCode + summary alongside data payload", () => {
    const out = shapeJsonOutput({
      data: { status: "pass", releases: [1, 2] },
      summary: "[release.list] 2 releases",
      exitCode: 0,
      nextSteps: [],
    });
    expect(out.exitCode).toBe(0);
    expect(out.summary).toBe("[release.list] 2 releases");
    expect(out.status).toBe("pass");
    expect(out.releases).toEqual([1, 2]);
  });

  it("envelope keys are authoritative over data collisions", () => {
    const out = shapeJsonOutput({
      data: { exitCode: 99, summary: "wrong" },
      exitCode: 1,
      summary: "right",
    });
    expect(out.exitCode).toBe(1);
    expect(out.summary).toBe("right");
  });

  it("defaults exitCode 0 and empty summary when absent", () => {
    const out = shapeJsonOutput({ data: { x: 1 } });
    expect(out.exitCode).toBe(0);
    expect(out.summary).toBe("");
    expect(out.nextSteps).toEqual([]);
  });
});

describe("plugin log stream separation", () => {
  it("info writes to stderr not stdout", async () => {
    // contracts: the context log port — verify the wiring shape directly
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { createPluginContext } = await import("../src/sdk/context.ts");
      const ctx = createPluginContext(
        {
          schema: "forge:plugin-manifest/v1",
          id: "test-plugin",
          version: "1.0.0",
          forgeRange: ">=10.0.0",
          capabilities: {},
          registers: {},
        } as never,
        { workspaceRoot: "/tmp" },
      );
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      ctx.log.info("hello-info");
      const stderrOut = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      const stdoutOut = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(stderrOut).toContain("hello-info");
      expect(stdoutOut).not.toContain("hello-info");
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });
});
