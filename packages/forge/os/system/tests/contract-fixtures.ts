/*
<MODULE_CONTRACT>
<purpose>RFC-1541 test fixtures — tagged product repos carrying forge.yaml contract declarations, a pnpm v9 lockfile and (for validator checks) a committed fake validator package; a fake npm on PATH for pin-drift.</purpose>
<non-goals><item>No network, no real package manager.</item></non-goals>
</MODULE_CONTRACT>
*/
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitExec } from "../../flow/tests/helpers.ts";
import {
  localMapFor,
  makeProduct,
  makeSystemRepo,
  VALID_EDGES_YAML,
  VALID_SYSTEM_YAML,
} from "./helpers.ts";

export const TAG = "v1.0.0";
export const SPEC_PKG = "@acme/demo-spec";
export const VALIDATOR_PKG = "@acme/demo-validator";

const RELEASE_ANNOTATION = [
  "release v1.0.0",
  "",
  "schema: forge/release-tag@1",
  "line: v",
  "version: 1.0.0",
  "level: minor",
  "previous: null",
  'rfcs: ["RFC-0001"]',
  "fingerprints: {}",
].join("\n");

export const PRODUCTS_YAML = `schema: forge/system-products@1
products:
  - id: alpha
    remote: https://example.invalid/alpha.git
    offers:
      - demo-spec
  - id: beta
    remote: https://example.invalid/beta.git
    offers: []
`;

async function commitAndTag(
  root: string,
  files: Record<string, string>,
  executable: string[] = [],
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    if (executable.includes(rel)) await chmod(abs, 0o755);
  }
  await gitExec(root, ["add", "-f", "-A"]);
  const c = await gitExec(root, ["commit", "-m", "release content"]);
  if (c.exitCode !== 0) throw new Error(`commit failed: ${c.stderr}`);
  const t = await gitExec(root, ["tag", "-a", TAG, "HEAD", "-m", RELEASE_ANNOTATION]);
  if (t.exitCode !== 0) throw new Error(`tag failed: ${t.stderr}`);
}

/** A product that pins the spec package at `version` in its root lockfile importer. */
export async function specConsumer(version: string | null): Promise<string> {
  const root = await makeProduct();
  const files: Record<string, string> = {
    "forge.yaml": `schema: "forge/workspace@1"\nspecPackages:\n  - id: demo-spec\n    package: "${SPEC_PKG}"\n`,
  };
  if (version !== null) {
    files["pnpm-lock.yaml"] =
      `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '${SPEC_PKG}':\n        specifier: ${version}\n        version: ${version}(zod@4.6.5)\n`;
  }
  await commitAndTag(root, files);
  return root;
}

/** A producer whose `intake` contract runs a committed fake validator package (package or root form). */
export async function validatorProducer(
  form: "package" | "root",
  validatorExit = 0,
): Promise<string> {
  const root = await makeProduct();
  const emit = `require("node:fs").writeFileSync(require("node:path").join(process.argv[1],"bundle.txt"),"x")`;
  const consumer =
    form === "package"
      ? `    consumer:\n      package: "${VALIDATOR_PKG}"\n      validator:\n        argv: ["demo-validate", "{bundle}"]\n`
      : `    consumer:\n      root: ../elsewhere\n      validator:\n        argv: ["demo-validate", "{bundle}"]\n`;
  await commitAndTag(
    root,
    {
      "forge.yaml": `schema: "forge/workspace@1"\ncontractProducers:\n  - id: intake\n    emit:\n      argv: ["${process.execPath}", "-e", ${JSON.stringify(emit)}, "{bundle}"]\n${consumer}    test: conformance.test.ts\n`,
      "pnpm-lock.yaml": `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      '${VALIDATOR_PKG}':\n        specifier: 2.1.0\n        version: 2.1.0\n`,
      [`node_modules/${VALIDATOR_PKG}/package.json`]: JSON.stringify({
        name: VALIDATOR_PKG,
        version: "2.1.0",
      }),
      "node_modules/.bin/demo-validate": `#!/bin/sh\nexit ${validatorExit}\n`,
    },
    ["node_modules/.bin/demo-validate"],
  );
  return root;
}

export async function systemWith(
  products: Record<string, string>,
  files: Record<string, string>,
): Promise<string> {
  return makeSystemRepo({
    "system/system.yaml": VALID_SYSTEM_YAML,
    "system/products.yaml": PRODUCTS_YAML,
    "system/edges.yaml": VALID_EDGES_YAML,
    "system/products.local.yaml": localMapFor(products),
    ...files,
  });
}

/** Install a fake `npm` first on PATH answering `view <pkg> dist-tags.latest` and `view <pkg> versions --json`. */
export async function fakeNpm(opts: {
  versions?: string[];
  latest?: string;
  offline?: boolean;
}): Promise<() => void> {
  const bin = await mkdtemp(path.join(os.tmpdir(), "fake-npm-"));
  const script = opts.offline
    ? `#!/bin/sh\necho "npm error code ENOTFOUND" >&2\nexit 1\n`
    : `#!/bin/sh\ncase "$3" in\n  dist-tags.latest) echo "${opts.latest}" ;;\n  versions) echo '${JSON.stringify(opts.versions)}' ;;\n  *) exit 1 ;;\nesac\n`;
  await writeFile(path.join(bin, "npm"), script);
  await chmod(path.join(bin, "npm"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  return () => {
    process.env.PATH = saved;
  };
}

export function scenario(id: string, products: string[], checks: string): string {
  return `schema: forge/system-scenario@1\nid: ${id}\ntitle: ${id}\nproducts: [${products.join(", ")}]\ncontracts: []\nchecks:\n${checks}`;
}
