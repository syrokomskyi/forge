/*
<MODULE_CONTRACT>
<purpose>RFC-1616 (AC-4, AC-5): policy.digest write→verify round-trip,
forge/policy-bundle@1 validity, tamper detection, mutable-key exclusion,
--base advance without X-Policy-Digest trailer, and absent-policy refusal.</purpose>
<non-goals>
  <item>Not a gate test — the judged-diff semantics live in os/correctness/gate tests.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1616: initial suite.</item>
  <item>RFC-1616: external verification trust boundary

policy.digest (canonical SHA-256 over the frozen surface), adversarial.run
with a 12-scenario catalog replayed through the real gate in a scratch
clone, flow.push verifier-trailer hard stop (fail-closed on unreadable
forge.yaml), project.owner + push.requireVerifierReview config, trust-boundary
scaffold (CODEOWNERS + forge-policy workflow) and reference docs.</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";
import { policyBundleSchema } from "../../../src/correctness/policy-bundle.ts";
import { runPolicyDigest } from "./policy-digest.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const FORGE_YAML = `schema: forge/config@1
project:
  name: demo
paths:
  rfcsDir: docs/rfcs
policy:
  mutable: [project]
  additive: [bindings]
  freezeFiles:
    - "hooks/**"
agentTools:
  deny: [deploy]
`;

function repo(forgeYaml = FORGE_YAML): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "policy-digest-"));
  dirs.push(root);
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(path.join(root, "forge.yaml"), forgeYaml);
  mkdirSync(path.join(root, "hooks"), { recursive: true });
  writeFileSync(path.join(root, "hooks/pre-commit.sh"), "#!/bin/sh\nexit 0\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "seed"]);
  return root;
}

const ctx = (root: string): ForgeRuntimeContext => ({
  workspaceRoot: root,
  logger: { section: () => {}, info: () => {}, warn: () => {}, error: () => {}, success: () => {} },
  dryRun: false,
  outputFormat: "json",
});
const inp = (flags: Record<string, unknown>): ForgeCommandInput => ({
  argv: [],
  flags: flags as ForgeCommandInput["flags"],
});
const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (root: string, rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};

describe("policy.digest (RFC-1616)", () => {
  it("AC-4: --write emits a valid forge/policy-bundle@1 and --verify exits 0", async () => {
    const root = repo();
    const w = await runPolicyDigest(inp({ write: true }), ctx(root));
    expect(w.exitCode).toBe(0);
    const bundle = policyBundleSchema.safeParse(
      parseYaml(readFileSync(path.join(root, ".forge/policy.digest"), "utf8")),
    );
    expect(bundle.success, ".forge/policy.digest must validate forge/policy-bundle@1").toBe(true);
    const v = await runPolicyDigest(inp({ verify: true }), ctx(root));
    expect(v.exitCode).toBe(0);
    expect(v.data?.sha256).toBe(bundle.data?.sha256);
  });

  it("AC-4: editing a frozen surface element without regenerating fails --verify", async () => {
    const root = repo();
    await runPolicyDigest(inp({ write: true }), ctx(root));
    write(root, "hooks/pre-commit.sh", "#!/bin/sh\necho pwned\nexit 0\n");
    const v = await runPolicyDigest(inp({ verify: true }), ctx(root));
    expect(v.exitCode).toBe(1);
  });

  it("AC-4: a mutable-key change does not churn the digest", async () => {
    const root = repo();
    await runPolicyDigest(inp({ write: true }), ctx(root));
    write(root, "forge.yaml", FORGE_YAML.replace("name: demo", "name: renamed"));
    const v = await runPolicyDigest(inp({ verify: true }), ctx(root));
    expect(v.exitCode).toBe(0);
  });

  it("AC-5: an unattested surface advance since --base fails naming the advance", async () => {
    const root = repo();
    const base = git(root, ["rev-parse", "HEAD"]).trim();
    write(root, "forge.yaml", FORGE_YAML.replace("deny: [deploy]", "deny: []"));
    git(root, ["commit", "-qam", "weaken the deny list"]);
    await runPolicyDigest(inp({ write: true }), ctx(root));
    git(root, ["add", ".forge/policy.digest"]);
    git(root, ["commit", "-qm", "regenerate digest — no trailer"]);
    const v = await runPolicyDigest(inp({ verify: true, base }), ctx(root));
    expect(v.exitCode).toBe(1);
    expect(v.data?.violations.join(" ")).toContain("advanced");
  });

  it("AC-5: an advance carrying X-Policy-Digest passes", async () => {
    const root = repo();
    const base = git(root, ["rev-parse", "HEAD"]).trim();
    write(root, "forge.yaml", FORGE_YAML.replace("deny: [deploy]", "deny: []"));
    git(root, ["commit", "-qam", "weaken the deny list"]);
    const w = await runPolicyDigest(inp({ write: true }), ctx(root));
    git(root, ["add", ".forge/policy.digest"]);
    git(root, ["commit", "-qm", `regenerate digest\n\nX-Policy-Digest: ${w.data?.sha256}`]);
    const v = await runPolicyDigest(inp({ verify: true, base }), ctx(root));
    expect(v.exitCode).toBe(0);
  });

  it("refuses when no policy: section is declared", async () => {
    const root = repo(`schema: forge/config@1\nproject:\n  name: demo\n`);
    const v = await runPolicyDigest(inp({ verify: true }), ctx(root));
    expect(v.exitCode).toBe(1);
    expect(v.summary).toContain("no policy surface declared");
  });
});
