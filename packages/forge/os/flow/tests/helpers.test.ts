/*
<MODULE_CONTRACT>
<purpose>RFC-1606 AC-4: the shared primary-forge harness is the single
producer — contract tests asserting what the stand-in actually does (not
invoke-order): executable binary, passing gate default, verdict-file and
exit-code overrides, and .git/info/exclude coverage so the stub never reads
as primary dirt.</purpose>
<non-goals>
  <item>No flow-command behavior — os/flow suites own that.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { afterAll, describe, expect, it } from "vitest";
import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { ambientIo } from "../../../src/utils/io.ts";
import { gitExec, initRepo, installRealPrimaryForge } from "./helpers.ts";

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs.splice(0).reverse()) {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

describe("installFakePrimaryForge — the single stand-in producer", () => {
  it("writes an executable .bin/forge answering correctness.gate with status pass", async () => {
    const repo = await initRepo({ prefix: "harness-fake-" });
    dirs.push(repo);
    const script = join(repo, "node_modules", ".bin", "forge");
    await access(script, constants.X_OK);
    const res = await ambientIo.exec(script, ["correctness.gate"], { cwd: repo });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).status).toBe("pass");
  });

  it("honors a dropped .correctness-gate.json and .correctness-gate.exit", async () => {
    const repo = await initRepo({ prefix: "harness-verdict-" });
    dirs.push(repo);
    await writeFile(join(repo, ".correctness-gate.json"), '{"status":"fail","violations":[]}');
    await writeFile(join(repo, ".correctness-gate.exit"), "3");
    const res = await ambientIo.exec(
      join(repo, "node_modules", ".bin", "forge"),
      ["correctness.gate"],
      {
        cwd: repo,
      },
    );
    expect(res.exitCode).toBe(3);
    expect(JSON.parse(res.stdout).status).toBe("fail");
  });

  it("excludes the stub tree so it never reads as primary dirt", async () => {
    const repo = await initRepo({ prefix: "harness-clean-" });
    dirs.push(repo);
    const status = await gitExec(repo, ["status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
  });

  it("initRepo installs the stand-in without a second call", async () => {
    const repo = await initRepo({ prefix: "harness-initrepo-" });
    dirs.push(repo);
    const script = join(repo, "node_modules", ".bin", "forge");
    const res = await ambientIo.exec(script, ["correctness.gate"], { cwd: repo });
    expect(res.exitCode).toBe(0);
  });
});

describe("installRealPrimaryForge — the real-CLI pointer", () => {
  it("replaces the stand-in with an exec wrapper for the given CLI", async () => {
    const repo = await initRepo({ prefix: "harness-real-" });
    dirs.push(repo);
    const cli = join(repo, "fake-cli.js");
    await writeFile(cli, 'console.log(JSON.stringify({cli:"real"}));\n');
    await installRealPrimaryForge(repo, cli);
    const res = await ambientIo.exec(join(repo, "node_modules", ".bin", "forge"), ["any.command"], {
      cwd: repo,
    });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).cli).toBe("real");
    const body = await readFile(join(repo, "node_modules", ".bin", "forge"), "utf8");
    expect(body).toMatch(/exec env -u NODE_OPTIONS node/);
  });
});
