/*
<MODULE_CONTRACT>
<purpose>RFC-1615 round-22 adversarial verification probes — the new tri-state
baseAdoptedGate in os/flow/correctness-step.ts vs the armed surface the gate
actually judges. Every probe asserts the SECURE behavior: a base revision
whose contour the gate would enforce must never reach the FLOW-INT-18
bootstrap degrade (a forge downgrade must not drop the gate).</purpose>
<non-goals>
  <item>No production fixes — verifier probes only.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { setVerifierGitBinForTests } from "../../../src/utils/verifier-git.ts";
import { runCorrectnessStep } from "../../flow/correctness-step.ts";
import { gitExec, initRepo } from "../../flow/tests/helpers.ts";
import { sideFrom } from "./frozen.ts";
import { runCorrectnessGate } from "./run.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}, 20_000);

/** A primary forge that predates correctness.gate (the degrade trigger). */
async function oldForge(repo: string): Promise<void> {
  const bin = join(repo, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  const script = join(bin, "forge");
  await writeFile(script, "#!/bin/sh\necho '  ✖ Unknown command: correctness.gate' >&2\nexit 1\n");
  await chmod(script, 0o755);
}

/** A repo whose `base` rev carries `yaml` as its root forge.yaml. */
async function repoWithBaseYaml(yaml: string): Promise<{ repo: string; base: string }> {
  const repo = await initRepo({ prefix: "r22-" });
  dirs.push(repo);
  await writeFile(join(repo, "forge.yaml"), yaml);
  await gitExec(repo, ["add", "forge.yaml"]);
  await gitExec(repo, ["commit", "-qm", "base forge.yaml"]);
  const base = (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
  await oldForge(repo);
  return { repo, base };
}

const step = (repo: string, base: string) =>
  runCorrectnessStep(ambientIo, { primary: repo, worktree: repo, base });

describe("CX-132: tagged non-plain-map base forge.yaml — must fail closed, never degrade", () => {
  // sideFrom marks every one of these forgeYamlUnreadable (isPlainMap rejects
  // Map/Set/Date/Buffer roots) → the gate refuses CORR-GATE-01. The adoption
  // check's `typeof "object"` guard lets them slip to "not-adopted" — the
  // exact divergence a forge downgrade launders through.
  const tagged = [
    ["!!set root", "!!set {a, b}\n"],
    ["!!omap root carrying correctness", "!!omap [{correctness: {mode: enforce}}]\n"],
    ["!!timestamp root", "!!timestamp 2020-01-01\n"],
    ["!!binary root", "!!binary AAA=\n"],
  ];
  for (const [name, doc] of tagged) {
    it(`${name}: sideFrom unreadable ⇒ step must refuse`, async () => {
      // Parity proof: the gate-side surface marks this unreadable, not "no surface".
      const shown = doc;
      expect(sideFrom(shown, () => null).forgeYamlUnreadable).toBe(true);
      const { repo, base } = await repoWithBaseYaml(doc);
      const res = await step(repo, base);
      expect(
        res.warning,
        `${name}: baseAdoptedGate degraded to a warning — a downgrade drops a contour the gate would refuse to read`,
      ).toBeUndefined();
      expect(res.refusal).toBeDefined();
    });
  }

  it("a plain YAML sequence root is already adopted (regression parity)", async () => {
    const { repo, base } = await repoWithBaseYaml("- a\n- b\n");
    const res = await step(repo, base);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/already adopted|could not be read/);
  });
});

describe("CX-133: a base that declares only `policy:` has an armed surface", () => {
  const BASE_YAML =
    "schema: forge/config@1\nproject: {name: probe}\npolicy:\n  mutable: [project]\n";

  it("proof the surface is armed: runCorrectnessGate refuses an undeclared top-level key diff", async () => {
    const repo = await initRepo({ prefix: "r22-policy-armed-" });
    dirs.push(repo);
    await writeFile(join(repo, "forge.yaml"), BASE_YAML);
    await gitExec(repo, ["add", "forge.yaml"]);
    await gitExec(repo, ["commit", "-qm", "base"]);
    const base = (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(repo, "forge.yaml"), BASE_YAML + "agentTools:\n  front: [x]\n");
    await gitExec(repo, ["add", "forge.yaml"]);
    await gitExec(repo, ["commit", "-qm", "session adds frozen key"]);
    const outcome = await runCorrectnessGate(repo, {
      base,
      bundleDir: join(os.tmpdir(), `r22-bundle-${Date.now()}`),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.status).toBe("fail");
    expect(
      outcome.result.violations.some(
        (v) => v.rule === "CORR-GATE-02" && v.message.includes("policy-key"),
      ),
      `expected a policy-key CORR-GATE-02, got: ${JSON.stringify(outcome.result.violations)}`,
    ).toBe(true);
  });

  for (const [name, yaml] of [
    ["policy: with mutable list", BASE_YAML],
    ["policy: {} (well-formed empty)", "policy: {}\n"],
    ["policy: ~ (malformed → CORR-GATE-01)", "policy: ~\n"],
    ["policy: [1] (malformed → CORR-GATE-01)", "policy: [1]\n"],
  ] as const) {
    it(`${name}: baseAdoptedGate must not degrade`, async () => {
      const { repo, base } = await repoWithBaseYaml(yaml);
      const res = await step(repo, base);
      expect(
        res.warning,
        `${name}: a declared policy surface at base is judged by the gate — the degrade must not fire`,
      ).toBeUndefined();
      expect(res.refusal).toBeDefined();
    });
  }
});

describe("CX-134: a base carrying only a frozen binding has an armed surface", () => {
  const cases = [
    {
      name: "bindings.commands.checkRun",
      yaml: 'schema: forge/config@1\nproject: {name: p}\nbindings:\n  commands:\n    checkRun: "node {file}"\n',
      head: "schema: forge/config@1\nproject: {name: p}\n",
    },
    {
      name: "bindings.paths.oracleReviewsDir",
      yaml: "schema: forge/config@1\nproject: {name: p}\nbindings:\n  paths:\n    oracleReviewsDir: docs/reviews\n",
      head: "schema: forge/config@1\nproject: {name: p}\n",
    },
    {
      name: "bindings.paths.invariantsFile",
      yaml: "schema: forge/config@1\nproject: {name: p}\nbindings:\n  paths:\n    invariantsFile: docs/knowledge.md\n",
      head: "schema: forge/config@1\nproject: {name: p}\n",
    },
    {
      name: "paths.rfcsDir",
      yaml: "schema: forge/config@1\nproject: {name: p}\npaths:\n  rfcsDir: docs/rfcs\n",
      head: "schema: forge/config@1\nproject: {name: p}\n",
    },
  ];

  for (const c of cases) {
    it(`${c.name}: removal is a CORR-GATE-02 binding weakening at the gate`, async () => {
      const repo = await initRepo({ prefix: "r22-bind-armed-" });
      dirs.push(repo);
      await writeFile(join(repo, "forge.yaml"), c.yaml);
      await gitExec(repo, ["add", "forge.yaml"]);
      await gitExec(repo, ["commit", "-qm", "base"]);
      const base = (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
      await writeFile(join(repo, "forge.yaml"), c.head);
      await gitExec(repo, ["add", "forge.yaml"]);
      await gitExec(repo, ["commit", "-qm", "session drops binding"]);
      const outcome = await runCorrectnessGate(repo, {
        base,
        bundleDir: join(os.tmpdir(), `r22-bundle-${Date.now()}-${Math.random()}`),
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.status).toBe("fail");
      expect(
        outcome.result.violations.some(
          (v) => v.rule === "CORR-GATE-02" && v.message.includes("binding"),
        ),
        `expected a binding CORR-GATE-02, got: ${JSON.stringify(outcome.result.violations)}`,
      ).toBe(true);
    });

    it(`${c.name}: baseAdoptedGate must not degrade`, async () => {
      const { repo, base } = await repoWithBaseYaml(c.yaml);
      const res = await step(repo, base);
      expect(
        res.warning,
        `${c.name}: a frozen binding at base is judged by the gate — the degrade must not fire`,
      ).toBeUndefined();
      expect(res.refusal).toBeDefined();
    });
  }
});

describe("regression: CX-130 adoption spellings still refuse", () => {
  const spellings: [string, string][] = [
    ["block map", "bindings:\n  paths:\n    correctnessManifest: docs/c.yaml\n"],
    ["flow style", "correctness: {mode: enforce}\n"],
    ["quoted key", '"correctness":\n  mode: enforce\n'],
    ["space before colon", "correctness :\n  mode: enforce\n"],
    ["single-quoted binding key", "bindings:\n  paths:\n    'correctnessManifest': docs/c.yaml\n"],
    ["correctness: ~ (explicit null)", "correctness: ~\n"],
    ["non-string manifest value", "bindings:\n  paths:\n    correctnessManifest: 5\n"],
    ["unparseable yaml", "a: [unclosed\n"],
    ["scalar root", "just a string\n"],
    ["multi-document", "a: 1\n---\nb: 2\n"],
    ["merge key alone is not the contour", "<<: {other: 1}\ncorrectness: {mode: warn}\n"],
    ["__proto__ key + correctness", "__proto__: {x: 1}\ncorrectness: {}\n"],
  ];
  for (const [name, yaml] of spellings) {
    it(`${name} ⇒ adopted ⇒ refusal`, async () => {
      const { repo, base } = await repoWithBaseYaml(yaml);
      const res = await step(repo, base);
      expect(res.warning).toBeUndefined();
      expect(res.refusal?.message).toMatch(/already adopted/);
    });
  }
});

describe("regression: CX-131 unreadable reads refuse", () => {
  // The hardened boundary channel (gitEvidence/verifierSpawn) deliberately
  // bypasses io.exec and session PATH — failure injection lands on real git
  // failures or the resolved-binary test seam, never io stubs (CX-46..52).

  it("a failing ls-tree (exit 128) ⇒ unreadable ⇒ refusal", async () => {
    const { repo } = await repoWithBaseYaml("x: 1\n");
    const res = await step(repo, "0000000000000000000000000000000000000000");
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/could not be read/);
  });

  it("a failing git show after a matching ls-tree ⇒ unreadable ⇒ refusal", async () => {
    const { repo, base } = await repoWithBaseYaml("x: 1\n");
    // Delete forge.yaml's loose blob object: `ls-tree` still lists the entry
    // (the tree object is intact) while `git show` fails on the missing
    // blob — the same two-stage failure the io.exec stub used to fake.
    const blob = (await gitExec(repo, ["rev-parse", `${base}:forge.yaml`])).stdout.trim();
    await rm(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const res = await step(repo, base);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/could not be read/);
  });

  it("a failed git spawn (ENOENT bin) ⇒ unreadable ⇒ refusal", async () => {
    const { repo, base } = await repoWithBaseYaml("x: 1\n");
    // The resolved-binary seam is the in-process injection point: a spawn
    // failure reports exitCode -1 → unreadable, never "not adopted".
    setVerifierGitBinForTests(join(os.tmpdir(), "cx23-no-such-git"));
    try {
      const res = await step(repo, base);
      expect(res.warning).toBeUndefined();
      expect(res.refusal?.message).toMatch(/could not be read/);
    } finally {
      setVerifierGitBinForTests(undefined);
    }
  });

  it("a real gitlink forge.yaml (git show fails) ⇒ unreadable ⇒ refusal", async () => {
    const repo = await initRepo({ prefix: "r22-gitlink-" });
    dirs.push(repo);
    // Forge.yaml as a gitlink: ls-tree lists the entry, `git show` fails on it.
    const subSha = (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await gitExec(repo, ["update-index", "--add", "--cacheinfo", `160000,${subSha},forge.yaml`]);
    await gitExec(repo, ["commit", "-qm", "gitlink forge.yaml"]);
    const base = (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await oldForge(repo);
    const res = await step(repo, base);
    expect(res.warning).toBeUndefined();
    // `git show rev:gitlink` dumps the linked commit's log — unparseable as a
    // YAML map ⇒ "adopted"; a dangling link instead fails the read ⇒
    // "unreadable". Both refuse.
    expect(res.refusal?.message).toMatch(/already adopted|could not be read/);
  });
});

describe("regression: the legit bootstrap degrade still works", () => {
  it("no forge.yaml at base ⇒ not-adopted ⇒ FLOW-INT-18 warning (not a refusal)", async () => {
    const repo = await initRepo({ prefix: "r22-noforge-" });
    dirs.push(repo);
    const base = (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await oldForge(repo);
    const res = await step(repo, base);
    expect(res.refusal).toBeUndefined();
    expect(res.warning?.ruleId).toBe("FLOW-INT-18");
    expect(res.status).toBe("not-run");
  });

  it("a forge.yaml that exists only nested (x/forge.yaml) ⇒ consistent not-adopted", async () => {
    const repo = await initRepo({ prefix: "r22-nested-" });
    dirs.push(repo);
    await mkdir(join(repo, "x"), { recursive: true });
    await writeFile(join(repo, "x", "forge.yaml"), "correctness:\n  mode: enforce\n");
    await gitExec(repo, ["add", "-A"]);
    await gitExec(repo, ["commit", "-qm", "nested forge.yaml"]);
    const base = (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await oldForge(repo);
    const res = await step(repo, base);
    // The gate reads only the ROOT forge.yaml — a nested file arms nothing.
    // "not-adopted" here is CONSISTENT with GateRepo.show(base, "forge.yaml").
    expect(res.warning?.ruleId).toBe("FLOW-INT-18");
  });

  it("an empty forge.yaml file ⇒ adopted (fail closed; gate calls it unreadable)", async () => {
    const { repo, base } = await repoWithBaseYaml("");
    const res = await step(repo, base);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/already adopted/);
  });

  it("a forge.yaml directory ⇒ adopted (tree listing parses as scalar)", async () => {
    const repo = await initRepo({ prefix: "r22-dir-" });
    dirs.push(repo);
    await mkdir(join(repo, "forge.yaml"), { recursive: true });
    await writeFile(join(repo, "forge.yaml", "inner.yaml"), "x: 1\n");
    await gitExec(repo, ["add", "-A"]);
    await gitExec(repo, ["commit", "-qm", "dir forge.yaml"]);
    const base = (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await oldForge(repo);
    const res = await step(repo, base);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/already adopted/);
  });

  it("a forge.yaml symlink ⇒ adopted (link target parses as scalar)", async () => {
    const repo = await initRepo({ prefix: "r22-symlink-" });
    dirs.push(repo);
    const { symlink } = await import("node:fs/promises");
    await symlink("seed.txt", join(repo, "forge.yaml"));
    await gitExec(repo, ["add", "forge.yaml"]);
    await gitExec(repo, ["commit", "-qm", "symlink forge.yaml"]);
    const base = (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await oldForge(repo);
    const res = await step(repo, base);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/already adopted/);
  });

  it("a bogus base rev ⇒ unreadable ⇒ refusal (never not-adopted)", async () => {
    const repo = await initRepo({ prefix: "r22-badbase-" });
    dirs.push(repo);
    await oldForge(repo);
    const res = await step(repo, "definitely-not-a-rev");
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/could not be read/);
  });

  it("a rev:path base (HEAD:seed.txt) ⇒ ls-tree fails ⇒ unreadable ⇒ refusal", async () => {
    const repo = await initRepo({ prefix: "r22-colonbase-" });
    dirs.push(repo);
    await oldForge(repo);
    const res = await step(repo, "HEAD:seed.txt");
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/could not be read/);
  });

  it("a NUL byte in base ⇒ exec throws ⇒ unreadable ⇒ refusal", async () => {
    const repo = await initRepo({ prefix: "r22-nulbase-" });
    dirs.push(repo);
    await oldForge(repo);
    const res = await step(repo, "HEAD\0x");
    expect(res.warning).toBeUndefined();
    expect(res.refusal).toBeDefined();
  });
});

describe("regression: gate-output and spoof guards", () => {
  async function repoWithForge(script: string): Promise<string> {
    const repo = await initRepo({ prefix: "r22-out-" });
    dirs.push(repo);
    const bin = join(repo, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "forge"), script);
    await chmod(join(bin, "forge"), 0o755);
    return repo;
  }

  it("a pass verdict still requires exit 0", async () => {
    const repo = await repoWithForge(
      '#!/bin/sh\necho \'{"status":"pass","bundlePath":null,"violations":[]}\'\nexit 1\n',
    );
    const res = await step(repo, "HEAD");
    expect(res.refusal).toBeDefined();
  });

  it("a fail verdict with exit 0 still refuses", async () => {
    const repo = await repoWithForge(
      '#!/bin/sh\necho \'{"status":"fail","bundlePath":null,"violations":[{"rule":"CORR-GATE-02","severity":"error","message":"weakening (mode): x"}]}\'\nexit 0\n',
    );
    const res = await step(repo, "HEAD");
    expect(res.status).toBe("fail");
    expect(res.refusal?.message).toMatch(/CORR-GATE-02/);
  });

  it("the unknown-command phrase with exit 0 is not a degrade", async () => {
    const repo = await repoWithForge(
      "#!/bin/sh\necho '  ✖ Unknown command: correctness.gate' >&2\nexit 0\n",
    );
    const res = await step(repo, "HEAD");
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/no JSON result/);
  });

  it("the phrase plus a stray `{` on stdout is not a degrade", async () => {
    const repo = await repoWithForge(
      "#!/bin/sh\necho '{not json'\necho '  ✖ Unknown command: correctness.gate' >&2\nexit 1\n",
    );
    const res = await step(repo, "HEAD");
    expect(res.warning).toBeUndefined();
    expect(res.refusal).toBeDefined();
  });

  it("a corrupt-json gate (no parse, no phrase) refuses not-run", async () => {
    const repo = await repoWithForge("#!/bin/sh\necho garbage\nexit 1\n");
    const res = await step(repo, "HEAD");
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/no JSON result/);
  });

  it("an exempt verdict passes through", async () => {
    const repo = await repoWithForge(
      '#!/bin/sh\necho \'{"status":"exempt","bundlePath":"/b.json","violations":[],"acceptedWeakening":null}\'\nexit 0\n',
    );
    const res = await step(repo, "HEAD");
    expect(res.status).toBe("exempt");
    expect(res.refusal).toBeUndefined();
  });
});
