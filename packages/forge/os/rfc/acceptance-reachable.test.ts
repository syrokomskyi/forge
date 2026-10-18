/*
<MODULE_CONTRACT>
<purpose>RFC-1334: reachable probe tests — symbol mode over a temporary git repository and command mode over a fixture manifest.</purpose>
<non-goals>
  <item>Not a TypeScript resolution suite — the scan is lexical by design.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1334: tests for AC-1..AC-5.</item>
  <item>RFC-1334: step 4 — reachable acceptance probe (symbol and command modes) and V-45</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  probeReachableCommand,
  probeReachableSymbol,
  resetReachableScanCache,
} from "./reachable-symbol.ts";

let root: string;

async function repo(files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
}

const lib = { "packages/p/src/lib.ts": "export function compute() { return 1; }\n" };
const probe = (extra: { root?: string } = {}) =>
  probeReachableSymbol({
    workspaceRoot: root,
    symbol: "compute",
    module: "packages/p/src/lib.ts",
    ...extra,
  });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "reachable-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  resetReachableScanCache();
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("reachable probe (RFC-1334)", () => {
  it("passes when a non-test module imports the symbol", async () => {
    await repo({
      ...lib,
      "packages/p/src/use.ts": 'import { compute } from "./lib.ts";\nexport const v = compute();\n',
    });
    expect((await probe()).ok).toBe(true);
  });

  it("fails when only test files import the symbol", async () => {
    await repo({ ...lib, "packages/p/src/lib.test.ts": 'import { compute } from "./lib.ts";\n' });
    const r = await probe();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no runtime importer");
  });

  it("fails when only type-only imports reference the symbol", async () => {
    await repo({
      ...lib,
      "packages/p/src/a.ts": 'import type { compute } from "./lib.ts";\n',
      "packages/p/src/b.ts": 'import { type compute } from "./lib.ts";\n',
    });
    expect((await probe()).ok).toBe(false);
  });

  it("fails when no importer is reachable from the declared root", async () => {
    await repo({
      ...lib,
      "packages/p/src/orphan.ts": 'import { compute } from "./lib.ts";\n',
      "packages/p/src/main.ts": "export const main = 1;\n",
    });
    const r = await probe({ root: "packages/p/src/main.ts" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not reachable from root");
  });

  it("passes through a barrel and a namespace import", async () => {
    await repo({
      ...lib,
      "packages/p/src/index.ts": 'export { compute } from "./lib.ts";\n',
      "packages/p/src/use.ts": 'import * as p from "./index.ts";\np.compute();\n',
    });
    expect((await probe()).ok).toBe(true);
  });

  it("keeps imports that follow a glob string containing a comment opener", async () => {
    await repo({
      ...lib,
      "packages/p/src/use.ts":
        'const G = "packages/*/src/**";\nimport { compute } from "./lib.ts";\nexport const v = compute() + G.length; // */\n',
    });
    expect((await probe()).ok).toBe(true);
  });

  it("reaches an importer through a dynamic module loader from the root", async () => {
    await repo({
      ...lib,
      "packages/p/src/feature.ts":
        'import { compute } from "./lib.ts";\nexport const f = compute;\n',
      "packages/p/src/main.ts": 'export const loaders = { f: () => import("./feature.ts") };\n',
    });
    expect((await probe({ root: "packages/p/src/main.ts" })).ok).toBe(true);
  });

  it("treats a bound dynamic import as a namespace", async () => {
    await repo({
      ...lib,
      "packages/p/src/use.ts": 'const m = await import("./lib.ts");\nm.compute();\n',
    });
    expect((await probe()).ok).toBe(true);
  });

  it("resolves bare specifiers through exports subpath patterns", async () => {
    await repo({
      ...lib,
      "packages/p/package.json": '{ "name": "@t/p", "exports": { "./*": "./src/*.ts" } }\n',
      "packages/q/src/use.ts": 'import { compute } from "@t/p/lib";\nexport const v = compute();\n',
    });
    expect((await probe()).ok).toBe(true);
  });

  it("fails a command probe whose reachableVia is empty", async () => {
    await repo({
      "docs/command-manifest.generated.yaml":
        "commands:\n  - name: lonely.run\n    reachableVia: []\n  - name: wired.run\n    reachableVia:\n      - kind: pipeline\n        ref: packages.check\n",
    });
    expect((await probeReachableCommand({ workspaceRoot: root, command: "lonely.run" })).ok).toBe(
      false,
    );
    expect((await probeReachableCommand({ workspaceRoot: root, command: "wired.run" })).ok).toBe(
      true,
    );
  });
});
