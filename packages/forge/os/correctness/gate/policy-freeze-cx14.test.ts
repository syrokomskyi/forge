/*
<MODULE_CONTRACT>
<purpose>RFC-1615 round-13 adversarial verification probes — verify the CX-73
(origin range git-read failures surface through unreadableReads), CX-74
(blob-only path reads), and CX-75 (unreadable carrier suppresses
anchor-removed) fixes, and record round-13 counterexamples CX-76..CX-81.</purpose>
<non-goals>
  <item>Not a contract source of truth — gate/run.ts owns behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1615: round-13 probes (verifier-side).</item>
  <item>RFC-1615: close RFC-1615 round-14 counterexamples — binding adds, base-side rfc namespace, governed acceptance provenance, unreadable listings</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessGate } from "./run.ts";
import {
  HELPERS,
  L1_ORACLE,
  ORACLE_PATH,
  makeGateFixture,
  manifestYaml,
  reviewYaml,
  verifierCommit,
  type GateFixture,
} from "./tests/gate-fixture.ts";

const MARK = "@ai-" + "invariant";
const fixtures: GateFixture[] = [];
const roots: string[] = [];
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.cleanup());
  roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }));
});
const fx = (o: Parameters<typeof makeGateFixture>[0] = {}) => {
  const f = makeGateFixture(o);
  fixtures.push(f);
  return f;
};

interface Fx {
  root: string;
  write(rel: string, body: string): void;
  read(rel: string): string;
  git(args: string[]): string;
  commit(msg: string): string;
}

/** Minimal fixture for scenarios that need commits before the base snapshot. */
function makeFx(forgeYaml: string, manifest: string): Fx {
  const root = mkdtempSync(path.join(os.tmpdir(), "forge-gate-cx-"));
  roots.push(root);
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = (msg: string) => {
    git(["add", "-A"]);
    git(["commit", "-qm", msg, "--allow-empty"]);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "-q", "-b", "develop"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  write("forge.yaml", forgeYaml);
  write(
    "docs/requirements.xml",
    '<requirements>\n  <meta><document-id>requirements</document-id></meta>\n  <requirement id="REQ-01">Never two openers</requirement>\n</requirements>\n',
  );
  write(
    "apps/api/wrangler.jsonc",
    '{ "d1_databases": [{ "binding": "DB", "database_name": "main", "database_id": "x" }] }\n',
  );
  write(
    "apps/api/migrations/0001_init.sql",
    "CREATE TABLE candidates (id TEXT PRIMARY KEY, state TEXT NOT NULL);\n",
  );
  write(
    "apps/api/src/dispatch.ts",
    `export function dispatch(): void {\n  // ${MARK}[INV-dispatch-01]: dispatch moves an approved candidate to queued exactly once\n  //   (checked-by: test:${ORACLE_PATH})\n}\n`,
  );
  write(ORACLE_PATH, L1_ORACLE);
  write("docs/correctness.yaml", manifest);
  commit("product");
  return {
    root,
    write,
    read: (rel) => readFileSync(path.join(root, rel), "utf8"),
    git,
    commit,
  };
}

const FORGE_YAML = (
  extra = "",
  checkRun = '    checkRun: "node {file}"\n',
) => `schema: forge/config@1
project:
  name: gate-fixture
paths: {}
bindings:
  schema: forge/bindings@1
  commands:
${checkRun}    verify: "node scripts/verify.mjs"
  paths:
    compassDocs: [docs/requirements.xml]
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: enforce
  tier: standard
${extra}`;

const RFC_PLANT = (dir: string) => ({
  [`${dir}/rfc-0005-vault.md`]:
    '---\nid: RFC-0005\ntitle: "vault"\nstatus: accepted\n---\n\n# RFC-0005\n\n## Acceptance criteria\n\n- [ ] AC-3: THE dispatch SHALL queue (evidence: probe:AC-3)\n',
  "test/vault.oracle.ts": L1_ORACLE,
});

const VAULT_ENTRY = `  - id: CM-vault-01
    source: rfc-ac
    ref: RFC-0005/AC-3
    seam: data
    anchors: [INV-vault-01]
    oracles:
      - check: test:test/vault.oracle.ts
        substrate: L1
`;

const VAULT_ANCHOR = `export function vault(): void {
  // ${MARK}[INV-vault-01]: vault moves an approved candidate to queued exactly once
  //   (checked-by: test:test/vault.oracle.ts)
}
`;

const POLICY_HOOKS = `policy:
  mutable: [project]
  freezeFiles: ["hooks/**"]
`;

/**
 * A runner that "passes and attests" any oracle without executing it — the
 * payload a session installs behind an added bindings.commands.checkRun.
 */
const FAKE_RUNNER = `import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { attestSubstrate } from ${JSON.stringify(HELPERS)};
const db = new DatabaseSync(":memory:");
db.exec(readFileSync("apps/api/migrations/0001_init.sql", "utf8"));
attestSubstrate(db, { level: "L1", engine: "node:sqlite" });
`;

/** A PATH shim that exits 128 for git invocations matching `match` — deterministic read-failure injection. */
async function withFailingGit(match: string, fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "git-shim-"));
  roots.push(dir);
  writeFileSync(path.join(dir, "git"), `#!/bin/sh\n${match}\nexec /usr/bin/git "$@"\n`, {
    mode: 0o755,
  });
  const prev = process.env["PATH"];
  process.env["PATH"] = `${dir}:${prev}`;
  try {
    await fn();
  } finally {
    process.env["PATH"] = prev;
  }
}

const msgs = (r: { violations: { rule: string; message: string }[] }, rule: string) =>
  r.violations.filter((v) => v.rule === rule).map((v) => v.message);

describe("round-13 fix verification", () => {
  it("CX-73: a failed git log --follow for the governing RFC flags unreadableReads and degrades requirement origin to self", async () => {
    const f = fx({ extraFiles: RFC_PLANT("docs/rfcs") });
    const base = f.base;
    f.write("apps/api/src/vault.ts", VAULT_ANCHOR);
    f.write("docs/correctness.yaml", manifestYaml({}, VAULT_ENTRY));
    f.commit("bind entry");
    await withFailingGit(
      'if [ "$1" = "log" ] && [ "$2" = "--follow" ]; then exit 128; fi',
      async () => {
        const out = await runCorrectnessGate(f.root, {
          base,
          bundleDir: `${f.root}/.bundles`,
        });
        if (!out.ok) throw new Error(out.usageError);
        // The failed history read must surface — not silently degrade to self.
        expect(
          out.bundle.unreadableReads?.some((l) => /log --follow -G/.test(l)),
          "resolveImplementationRange must report the failed log through unreadableReads",
        ).toBe(true);
        const oracle = out.bundle.entries
          .find((e) => e.id === "CM-vault-01")
          ?.oracles.find((o) => o.check === "test:test/vault.oracle.ts");
        expect(oracle?.origin).toBe("self");
        expect(out.result.status).toBe("fail");
        expect(msgs(out.result, "CORR-GATE-01").some((m) => /a git read failed/.test(m))).toBe(
          true,
        );
      },
    );
  });

  it("CX-73b: a failed rev-parse HEAD inside resolveImplementationRange flags unreadableReads", async () => {
    const f = fx({ extraFiles: RFC_PLANT("docs/rfcs") });
    f.write("apps/api/src/vault.ts", VAULT_ANCHOR);
    f.write("docs/correctness.yaml", manifestYaml({}, VAULT_ENTRY));
    f.commit("bind entry");
    // Fail only `git rev-parse HEAD` — the gate's own revParse calls ask for
    // `X^{commit}` / `--abbrev-ref`, so `$2` here is bare `HEAD`.
    await withFailingGit(
      'if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then exit 128; fi',
      async () => {
        const out = await runCorrectnessGate(f.root, {
          base: f.base,
          bundleDir: `${f.root}/.bundles`,
        });
        if (!out.ok) throw new Error(out.usageError);
        expect(out.bundle.unreadableReads?.some((l) => /rev-parse HEAD/.test(l))).toBe(true);
        expect(out.result.status).toBe("fail");
      },
    );
  });

  it("CX-74a: a file->dir flip on a frozen path reports a deletion, not a fabricated byte edit", async () => {
    const f = makeFx(FORGE_YAML(POLICY_HOOKS), manifestYaml({}));
    f.write("hooks/tool.sh", "#!/bin/sh\ntrue\n");
    const base = f.commit("hooks");
    f.git(["rm", "-q", "hooks/tool.sh"]);
    mkdirSync(`${f.root}/hooks/tool.sh`, { recursive: true });
    f.write("hooks/tool.sh/inner.txt", "x\n");
    f.commit("file to dir flip");
    const out = await runCorrectnessGate(f.root, {
      base,
      bundleDir: `${f.root}/.bundles`,
      policyOnly: true,
    });
    if (!out.ok) throw new Error(out.usageError);
    const w = out.result.weakenings.filter((x) => x.subject === "hooks/tool.sh");
    expect(
      w.some((x) => /was deleted/.test(x.message)),
      "the head-side tree entry is not a file — the claim must be a deletion",
    ).toBe(true);
    expect(w.some((x) => /changed without/.test(x.message))).toBe(false);
  });

  it("CX-74b: a file->gitlink flip reports a deletion, not a fabricated byte edit", async () => {
    const f = makeFx(FORGE_YAML(POLICY_HOOKS), manifestYaml({}));
    f.write("hooks/sub", "module placeholder\n");
    const base = f.commit("hooks");
    f.git(["rm", "-q", "hooks/sub"]);
    f.git([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${f.git(["rev-parse", "HEAD"])},hooks/sub`,
    ]);
    f.git(["commit", "-qm", "file to gitlink flip"]);
    const out = await runCorrectnessGate(f.root, {
      base,
      bundleDir: `${f.root}/.bundles`,
      policyOnly: true,
    });
    if (!out.ok) throw new Error(out.usageError);
    const w = out.result.weakenings.filter((x) => x.subject === "hooks/sub");
    expect(
      w.some((x) => /was deleted/.test(x.message)),
      "a gitlink is not a file — the claim must be a deletion",
    ).toBe(true);
    expect(w.some((x) => /changed without/.test(x.message))).toBe(false);
  });

  it("CX-74c: a dir->file flip inside a frozen glob is an addition, not a fabricated edit of the base tree", async () => {
    const f = makeFx(FORGE_YAML(POLICY_HOOKS), manifestYaml({}));
    f.write("hooks/deploy/run.sh", "#!/bin/sh\ntrue\n"); // hooks/deploy is a TREE at base
    const base = f.commit("hooks");
    f.git(["rm", "-rq", "hooks/deploy"]);
    f.write("hooks/deploy", "#!/bin/sh\ntrue\n");
    f.commit("dir to file flip");
    const out = await runCorrectnessGate(f.root, {
      base,
      bundleDir: `${f.root}/.bundles`,
      policyOnly: true,
    });
    if (!out.ok) throw new Error(out.usageError);
    const w = out.result.weakenings.filter((x) => x.subject === "hooks/deploy");
    expect(
      w.some((x) => /new file hooks\/deploy matches/.test(x.message)),
      "the base-side tree entry is not a file — the claim must be an addition",
    ).toBe(true);
    expect(w.some((x) => /changed without/.test(x.message))).toBe(false);
  });

  it("CX-75: an unreadable changed anchor carrier suppresses anchor-removed — the flag carries the refusal", async () => {
    const f = fx();
    f.write("apps/api/src/dispatch.ts", "export function dispatch(): void {}\n");
    f.commit("drop the anchor");
    const blobSha = f.git(["rev-parse", "HEAD:apps/api/src/dispatch.ts"]);
    rmSync(path.join(f.root, ".git", "objects", blobSha.slice(0, 2), blobSha.slice(2)), {
      force: true,
    });
    const out = await runCorrectnessGate(f.root, { base: f.base, bundleDir: `${f.root}/.bundles` });
    if (!out.ok) throw new Error(out.usageError);
    expect(
      msgs(out.result, "CORR-GATE-02").some((m) => /anchor INV-dispatch-01 was removed/.test(m)),
      "anchor-removed must NOT be claimed when the changed carrier cannot be read",
    ).toBe(false);
    expect(msgs(out.result, "CORR-GATE-01").some((m) => /a git read failed/.test(m))).toBe(true);
    expect(out.result.status).toBe("fail");
  });
});

describe("round-13 counterexamples", () => {
  it("CX-76 (fabricate): a failed BASE enumeration fabricates 'new file' weakening claims for files unchanged since base", async () => {
    const f = makeFx(FORGE_YAML(POLICY_HOOKS), manifestYaml({}));
    f.write("hooks/deploy.sh", "#!/bin/sh\ntrue\n");
    f.write("stale/old.txt", "stale\n");
    const base = f.commit("add hooks + stale");
    f.git(["rm", "-rq", "stale"]);
    f.commit("remove stale");
    // Corrupt the base-only 'stale' tree object: files(base) fails, files(head) is clean.
    const treeSha = f.git(["rev-parse", `${base}:stale`]);
    rmSync(path.join(f.root, ".git", "objects", treeSha.slice(0, 2), treeSha.slice(2)), {
      force: true,
    });
    const out = await runCorrectnessGate(f.root, {
      base,
      bundleDir: `${f.root}/.bundles`,
      policyOnly: true,
    });
    if (!out.ok) throw new Error(out.usageError);
    // hooks/deploy.sh existed at base and is byte-identical — the "new file"
    // claim is fabricated: `before` is empty because the BASE enumeration
    // failed, and globAdditions only re-checks membership when HEAD's fails.
    expect(
      out.result.weakenings.some(
        (w) => w.kind === "policy-file" && w.subject === "hooks/deploy.sh",
      ),
      "globAdditions must not report 'new file' for a file that existed at base",
    ).toBe(false);
    expect(out.result.status).toBe("fail"); // the flag still refuses — the claim is the bug
  });

  it("CX-77 (fail-open): adding bindings.commands.checkRun is not judged — a session binds a fake-attest runner and every oracle covers without executing", async () => {
    // Base: manifest bound, NO checkRun binding, oracle verified by a review record.
    const f = makeFx(FORGE_YAML("", ""), manifestYaml({}));
    const rel = "docs/correctness/reviews/2026-11-13-base.yaml";
    f.write(rel, reviewYaml([{ check: `test:${ORACLE_PATH}`, content: L1_ORACLE }]));
    verifierCommit(f.git, rel);
    const base = f.git(["rev-parse", "HEAD"]);
    // Session: add checkRun pointing at a script that attests without running {file}.
    f.write("scripts/attest.mjs", FAKE_RUNNER);
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace(
          'verify: "node scripts/verify.mjs"',
          'checkRun: "node scripts/attest.mjs"\n    verify: "node scripts/verify.mjs"',
        ),
    );
    f.commit("bind checkRun to the fake runner");
    const out = await runCorrectnessGate(f.root, { base, bundleDir: `${f.root}/.bundles` });
    if (!out.ok) throw new Error(out.usageError);
    expect(
      msgs(out.result, "CORR-GATE-02").some((m) => /checkRun/.test(m)),
      "adding the runner binding is a change to the frozen surface and must be a weakening",
    ).toBe(true);
    const oracle = out.bundle.entries
      .find((e) => e.id === "CM-dispatch-01")
      ?.oracles.find((o) => o.check === `test:${ORACLE_PATH}`);
    expect(
      oracle?.command,
      "the 'run' was the fake runner — the oracle file was never executed",
    ).toBe("node scripts/attest.mjs");
    expect(oracle?.attestation?.matches).toBe(true);
    expect(out.bundle.entries.find((e) => e.id === "CM-dispatch-01")?.covered).toBe(true);
    // The flagged binding add refuses the run — the fake runner never pays off.
    expect(out.result.status).toBe("fail");
  });

  it("CX-78 (fail-open): paths.rfcsDir rebound at HEAD lets requirement origin resolve a planted 'accepted' file outside the base RFC namespace", async () => {
    const f = fx({ extraFiles: RFC_PLANT("vault") });
    const base = f.base;
    f.write("forge.yaml", f.read("forge.yaml").replace("paths: {}", "paths:\n  rfcsDir: vault"));
    f.write("apps/api/src/vault.ts", VAULT_ANCHOR);
    f.write("docs/correctness.yaml", manifestYaml({}, VAULT_ENTRY));
    f.commit("rebind rfcsDir + bind entry");
    const out = await runCorrectnessGate(f.root, { base, bundleDir: `${f.root}/.bundles` });
    if (!out.ok) throw new Error(out.usageError);
    const oracle = out.bundle.entries
      .find((e) => e.id === "CM-vault-01")
      ?.oracles.find((o) => o.check === "test:test/vault.oracle.ts");
    expect(
      oracle?.origin,
      "a planted file under a rebound namespace must NOT grant requirement origin",
    ).toBe("self");
    expect(out.result.status).toBe("fail");
  });

  it("CX-79 (fail-open): a planted rfc-NNNN-*.md under the real rfcsDir earns requirement origin — acceptance text is trusted without provenance", async () => {
    const f = fx({ extraFiles: RFC_PLANT("docs/rfcs") });
    const base = f.base;
    f.write("apps/api/src/vault.ts", VAULT_ANCHOR);
    f.write("docs/correctness.yaml", manifestYaml({}, VAULT_ENTRY));
    f.commit("bind entry");
    const out = await runCorrectnessGate(f.root, { base, bundleDir: `${f.root}/.bundles` });
    if (!out.ok) throw new Error(out.usageError);
    const oracle = out.bundle.entries
      .find((e) => e.id === "CM-vault-01")
      ?.oracles.find((o) => o.check === "test:test/vault.oracle.ts");
    expect(oracle?.origin).toBe("self");
    expect(out.result.status).toBe("fail");
  });

  it("CX-80 (fabricate): a '!'-negation in policy.freezeFiles fabricates policy-file weakenings on the complement and whitelists them in the accept path", async () => {
    const f = makeFx(
      FORGE_YAML(`policy:\n  mutable: [project]\n  freezeFiles: ["!hooks/**"]\n`),
      manifestYaml({}),
    );
    const base = f.git(["rev-parse", "HEAD"]);
    f.write("apps/api/src/other.ts", "export const x = 2;\n");
    f.write("docs/new-doc.md", "hello\n");
    f.commit("touch arbitrary files");
    const out = await runCorrectnessGate(f.root, {
      base,
      bundleDir: `${f.root}/.bundles`,
      policyOnly: true,
    });
    if (!out.ok) throw new Error(out.usageError);
    // The malformed declaration refuses CORR-GATE-01 — but the glob still runs.
    expect(msgs(out.result, "CORR-GATE-01").some((m) => /policy: declaration/.test(m))).toBe(true);
    // It must resolve to NOTHING (supportMalformed already zeroes its globs) —
    // instead the complement matcher fabricates policy-file claims on
    // arbitrary files.
    expect(
      out.result.weakenings.filter((w) => w.kind === "policy-file").map((w) => w.subject),
      "a malformed policy resolves to nothing — no complement-fabricated claims",
    ).toEqual([]);
    // …and the same malformed glob counts as a frozen surface in the
    // --accept-weakening isolation check, whitelisting foreign files.
    const accepted = await runCorrectnessGate(f.root, {
      base,
      bundleDir: `${f.root}/.bundles`,
      policyOnly: true,
      acceptWeakening: "arbitrary",
    });
    if (!accepted.ok) throw new Error(accepted.usageError);
    expect(
      accepted.result.acceptedWeakening,
      "the malformed '!' glob must not whitelist foreign paths in the isolation check",
    ).toBe(null);
  });

  it("CX-81 (fail-open): a failed `git ls-files` silently widens to the fs walk — an ignored-file anchor satisfies CORR-04 and masks the refusal", async () => {
    const f = fx({
      extraFiles: {
        ".gitignore": "ignored/\n",
      },
    });
    f.write(
      "ignored/ghost.ts",
      `export const ghost = 1;\n// ${MARK}[INV-ghost-01]: ghost moves an approved candidate to queued exactly once\n//   (checked-by: test:${ORACLE_PATH})\n`,
    );
    f.write(
      "docs/correctness.yaml",
      manifestYaml(
        {},
        `  - id: CM-ghost-01
    source: req
    ref: REQ-01
    seam: data
    anchors: [INV-ghost-01]
    oracles:
      - check: test:${ORACLE_PATH}
        substrate: L1
`,
      ),
    );
    f.commit("bind ghost entry");

    // Control: with `git ls-files` working, the ignored file is invisible — CORR-04 must fire.
    const control = await runCorrectnessGate(f.root, {
      base: f.base,
      bundleDir: `${f.root}/.bundles`,
    });
    if (!control.ok) throw new Error(control.usageError);
    expect(
      msgs(control.result, "CORR-GATE-01").some((m) => /INV-ghost-01/.test(m)),
      "control: the ignored-file anchor must not satisfy CORR-04",
    ).toBe(true);
    expect(control.result.status).toBe("fail");

    // Attack: `git ls-files` fails → listWorkspaceFiles falls back to the fs
    // walk which includes the ignored file — the CORR-04 error is masked.
    await withFailingGit('if [ "$1" = "ls-files" ]; then exit 128; fi', async () => {
      const out = await runCorrectnessGate(f.root, {
        base: f.base,
        bundleDir: `${f.root}/.bundles`,
      });
      if (!out.ok) throw new Error(out.usageError);
      expect(
        out.result.violations.some((v) =>
          /ls-files|filesystem walk|git read failed/.test(v.message),
        ),
        "a failed ls-files must surface through the unreadable-reads refusal",
      ).toBe(true);
      expect(out.result.status).toBe("fail");
    });
  });
});
