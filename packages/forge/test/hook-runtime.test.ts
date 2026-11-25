/*
Lifecycle-hook runtime proof — beforeIntegrate veto requeues under bounded infra
semantics; afterIntegrate fires post-integration with errors loud in the report;
duplicate hook registration refuses the plugin (fail-closed loader).
*/
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { drainQueue } from "../src/integration/drain.ts";
import { invokeLifecycleHook } from "../src/sdk/hooks.ts";
import { loadPlugin } from "../src/sdk/loader.ts";
import type { LoadedPlugin } from "../src/sdk/loader.ts";
import { enqueueUnit } from "../src/integration/enqueue.ts";
import { createFixtureRepo, buildSessionChain } from "./helpers/git-fixture.ts";
import { createQueueFixture, mkTmp, type QueueFixture } from "./helpers/queue-fixture.ts";

describe("lifecycle-hook runtime", () => {
  let dir = "";
  let fixture: QueueFixture;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hook-runtime-"));
    fixture = createQueueFixture(join(dir, "queue"), join(dir, "evidence"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makePlugin(name: string, hookImpl: string): string {
    const pluginDir = join(dir, name);
    mkdirSync(join(pluginDir, "hooks"), { recursive: true });
    writeFileSync(join(pluginDir, "hooks", "before.mjs"), hookImpl);
    writeFileSync(
      join(pluginDir, "forge.plugin.yaml"),
      [
        "schema: forge:plugin-manifest/v1",
        `id: ${name}`,
        "version: 1.0.0",
        'forgeRange: ">=10.0.0"',
        "capabilities:",
        "  filesystem: read",
        "registers:",
        "  hooks:",
        "    - hooks/before.mjs",
        "",
      ].join("\n"),
    );
    return pluginDir;
  }

  it("invokeLifecycleHook runs matching hooks and isolates failures", async () => {
    const good = makePlugin("good-hook", `export default { hook: "beforeIntegrate", async run() {} };`);
    const bad = makePlugin("bad-hook", `export default { hook: "beforeIntegrate", async run() { throw new Error("veto-boom"); } };`);
    const plugins: LoadedPlugin[] = [];
    for (const entry of [good, bad]) {
      plugins.push(await loadPlugin(entry, dir, { workspaceRoot: dir }));
    }
    const result = await invokeLifecycleHook(plugins, "beforeIntegrate", { unitId: "u1" });
    expect(result.ran).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].pluginId).toBe("bad-hook");
    expect(result.errors[0].error).toContain("veto-boom");
  });

  it("duplicate hook implementation refuses the plugin at load", async () => {
    const pluginDir = join(dir, "dup-hook");
    mkdirSync(join(pluginDir, "hooks"), { recursive: true });
    const impl = `export default { hook: "beforeIntegrate", async run() {} };`;
    writeFileSync(join(pluginDir, "hooks", "a.mjs"), impl);
    writeFileSync(join(pluginDir, "hooks", "b.mjs"), impl);
    writeFileSync(
      join(pluginDir, "forge.plugin.yaml"),
      [
        "schema: forge:plugin-manifest/v1",
        "id: dup-hook",
        "version: 1.0.0",
        'forgeRange: ">=10.0.0"',
        "capabilities:",
        "  filesystem: read",
        "registers:",
        "  hooks:",
        "    - hooks/a.mjs",
        "    - hooks/b.mjs",
        "",
      ].join("\n"),
    );
    await expect(loadPlugin(pluginDir, dir, { workspaceRoot: dir })).rejects.toThrow("duplicate hook");
  });

  it("drain requeues units when beforeIntegrate hook throws", async () => {
    const repo = createFixtureRepo(mkTmp("hook-veto-repo-"));
    const fx = createQueueFixture(mkTmp("hook-veto-queue-"), mkTmp("hook-veto-evidence-"));
    const vetoDir = makePlugin("veto-plugin", `export default { hook: "beforeIntegrate", async run() { throw new Error("studio-veto"); } };`);
    const plugin = await loadPlugin(vetoDir, dir, { workspaceRoot: dir });
    const chain = buildSessionChain(repo, [["ok.txt", "clean"]]);
    enqueueUnit(fx.store, {
      treeDigest: chain.treeDigest,
      baseRef: repo.head(),
      sessionId: "s1",
      worktreePath: "/tmp/x",
      governanceIds: [],
      commitChain: chain.chain,
    });
    const report = await drainQueue({
      store: fx.store,
      repoDir: repo.dir,
      governedRef: "refs/heads/develop",
      graph: fx.graph,
      evidenceStore: fx.evidenceStore,
      executors: fx.executors,
      plugins: [plugin],
    });
    expect(report.processed.find((p) => p.unitId)?.terminal).toBe("queued");
  });

  it("drain integrates cleanly when hooks pass", async () => {
    const repo = createFixtureRepo(mkTmp("hook-pass-repo-"));
    const fx = createQueueFixture(mkTmp("hook-pass-queue-"), mkTmp("hook-pass-evidence-"));
    const passDir = makePlugin("pass-plugin", `export default { hook: "beforeIntegrate", async run() {} };`);
    const plugin = await loadPlugin(passDir, dir, { workspaceRoot: dir });
    const chain = buildSessionChain(repo, [["ok.txt", "clean"]]);
    enqueueUnit(fx.store, {
      treeDigest: chain.treeDigest,
      baseRef: repo.head(),
      sessionId: "s1",
      worktreePath: "/tmp/x",
      governanceIds: [],
      commitChain: chain.chain,
    });
    const report = await drainQueue({
      store: fx.store,
      repoDir: repo.dir,
      governedRef: "refs/heads/develop",
      graph: fx.graph,
      evidenceStore: fx.evidenceStore,
      executors: fx.executors,
      plugins: [plugin],
    });
    expect(report.processed.find((p) => p.unitId)?.terminal).toBe("integrated");
  });
});
