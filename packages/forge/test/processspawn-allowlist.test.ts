import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createPluginContext } from "../src/sdk/context.js";
import { verifyManifest } from "../src/sdk/loader.js";

function ctx(grant: boolean | string[]) {
  const root = mkdtempSync(join(tmpdir(), "forge-spawn-"));
  const manifest = verifyManifest(
    {
      schema: "forge:plugin-manifest/v1",
      id: "test",
      version: "0.1.0",
      forgeRange: ">=10.2.1",
      capabilities: { filesystem: "read", processSpawn: grant },
    },
    root,
  );
  return createPluginContext(manifest, { workspaceRoot: root });
}

describe("processSpawn binary allowlist", () => {
  it("refuses undeclared binaries in array form", async () => {
    const c = ctx(["cp"]);
    await expect(c.process.spawn("rm", ["-rf", "/tmp/x"])).rejects.toThrow(/allowlist/);
  });

  it("permits declared binaries in array form", async () => {
    const c = ctx(["echo"]);
    const r = await c.process.spawn("echo", ["hello"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  it("matches basename for path-qualified spawns", async () => {
    const c = ctx(["echo"]);
    const r = await c.process.spawn("/bin/echo", ["hi"]);
    expect(r.exitCode).toBe(0);
  });

  it("boolean true remains unrestricted (legacy fully-trusted form)", async () => {
    const c = ctx(true);
    const r = await c.process.spawn("echo", ["x"]);
    expect(r.exitCode).toBe(0);
  });

  it("false refuses everything", async () => {
    const c = ctx(false);
    await expect(c.process.spawn("echo", ["x"])).rejects.toThrow(/refused/);
  });
});
