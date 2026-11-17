/*
<MODULE_CONTRACT>
<purpose>RFC-1615 round-23 independent adversarial probes — the
baseAdoptedGate contour-adoption oracle inside runCorrectnessStep
(packages/forge/os/flow/correctness-step.ts). Assert SECURE behavior only:
a base that adopted any armed contour element must refuse a missing
correctness.gate primary (never degrade to the FLOW-INT-18 warning), an
unreadable base read must refuse (never launder as "not adopted"), and
only a genuinely non-adopted base may degrade. Also re-probes CX-130..134
regressions and the unknown-command spoof guard.</purpose>
<non-goals>
  <item>No fixes — verifier only.</item>
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

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}, 20_000);

const UNKNOWN_BIN = "#!/bin/sh\necho '  ✖ Unknown command: correctness.gate' >&2\nexit 1\n";

/** A repo at HEAD whose `node_modules/.bin/forge` answers the pre-RFC-1580 unknown-command shape. */
async function repoWith(
  forgeYaml: string | null,
  opts?: { dir?: boolean; commit?: boolean },
): Promise<string> {
  const repo = await initRepo({ prefix: "vfy-r23-" });
  dirs.push(repo);
  if (opts?.dir === true) {
    await mkdir(join(repo, "forge.yaml"), { recursive: true });
    await writeFile(join(repo, "forge.yaml", "inner.txt"), "x\n");
  } else if (forgeYaml !== null) {
    await writeFile(join(repo, "forge.yaml"), forgeYaml);
  }
  await mkdir(join(repo, "node_modules", ".bin"), { recursive: true });
  await writeFile(join(repo, "node_modules", ".bin", "forge"), UNKNOWN_BIN);
  await chmod(join(repo, "node_modules", ".bin", "forge"), 0o755);
  await gitExec(repo, ["add", "forge.yaml"]);
  if (opts?.commit !== false) await gitExec(repo, ["commit", "-qm", "fixture"]);
  return repo;
}

async function step(repo: string, base = "HEAD") {
  return runCorrectnessStep(ambientIo, { primary: repo, worktree: repo, base });
}

const adopted = async (name: string, forgeYaml: string | null, opts?: { dir?: boolean }) => {
  const repo = await repoWith(forgeYaml, opts);
  const res = await step(repo);
  expect(res.warning, `${name}: adopted base must never degrade`).toBeUndefined();
  expect(res.refusal?.message, `${name}: expected the adopted refusal`).toMatch(/already adopted/);
};

const degrade = async (name: string, forgeYaml: string | null, opts?: { dir?: boolean }) => {
  const repo = await repoWith(forgeYaml, opts);
  const res = await step(repo);
  expect(res.refusal, `${name}: non-adopted base must degrade to a warning`).toBeUndefined();
  expect(res.warning?.ruleId, `${name}: expected FLOW-INT-18 warning`).toBe("FLOW-INT-18");
};

describe("r23 — adoption-arming completeness (CX-134 regression + arm list)", () => {
  it("CX-135a correctnessManifest binding alone → adopted", async () => {
    await adopted("manifest", "bindings:\n  paths:\n    correctnessManifest: docs/c.yaml\n");
  });
  it("CX-135b checkRun binding alone → adopted", async () => {
    await adopted("checkRun", 'bindings:\n  commands:\n    checkRun: "node {file}"\n');
  });
  it("CX-135c oracleReviewsDir binding alone → adopted", async () => {
    await adopted("reviewsDir", "bindings:\n  paths:\n    oracleReviewsDir: docs/rev\n");
  });
  it("CX-135d invariantsFile binding alone → adopted", async () => {
    await adopted("invariantsFile", "bindings:\n  paths:\n    invariantsFile: docs/inv.md\n");
  });
  it("CX-135e compassDocs binding alone → adopted (over-conservative, fail-closed)", async () => {
    await adopted("compassDocs", "bindings:\n  paths:\n    compassDocs: [docs/requirements.xml]\n");
  });
  it("CX-135f paths.rfcsDir binding alone → adopted", async () => {
    await adopted("rfcsDir", "paths:\n  rfcsDir: docs/rfcs\n");
  });
  it("CX-136 correctness section alone → adopted", async () => {
    await adopted("correctness", "correctness:\n  mode: enforce\n");
  });
  it("CX-137a policy surface alone → adopted (CX-133 regression)", async () => {
    await adopted("policy", "policy:\n  mutable: [project]\n");
  });
  it("CX-137b malformed policy scalar → adopted (arms malformed CORR-GATE-01)", async () => {
    await adopted("policy scalar", "policy: 5\n");
    await adopted("policy null", "policy: ~\n");
    await adopted("policy list", "policy: []\n");
  });
});

describe("r23 — CX-130 regression: every YAML spelling of the contour key", () => {
  const spellings: [string, string][] = [
    ["plain", "correctness: {}\n"],
    ["double-quoted", '"correctness": {}\n'],
    ["single-quoted", "'correctness': {}\n"],
    ["space before colon", "correctness : {}\n"],
    ["top-level flow map", "{correctness: {mode: enforce}}\n"],
    ["complex key", '? "correctness"\n: {}\n'],
    ["explicit !!str tag", "!!str correctness: {}\n"],
    ["unresolved !tag key", "!foo correctness: {}\n"],
  ];
  for (const [name, yaml] of spellings) {
    it(`CX-138 ${name} → adopted`, async () => {
      await adopted(name, yaml);
    });
  }
  const bindingSpellings: [string, string][] = [
    ["quoted binding key", 'bindings:\n  paths:\n    "correctnessManifest": docs/c.yaml\n'],
    ["flow bindings", "bindings: {paths: {correctnessManifest: docs/c.yaml}}\n"],
  ];
  for (const [name, yaml] of bindingSpellings) {
    it(`CX-139 ${name} → adopted`, async () => {
      await adopted(name, yaml);
    });
  }
});

describe("r23 — CX-132 regression: non-plain-map roots arm (never not-adopted)", () => {
  const roots: [string, string][] = [
    ["scalar", "just a string\n"],
    ["array", "- a\n- b\n"],
    ["!!set", "!!set {a, b}\n"],
    ["!!omap", "!!omap\n- a: 1\n"],
    ["!!timestamp", "!!timestamp 2020-01-01\n"],
    ["!!binary", "!!binary aGk=\n"],
    ["NUL byte in doc", "correctness:\x00{}\n"],
    ["unparseable", "a: [unclosed\n"],
    ["duplicate key", "correctness: {}\ncorrectness: {}\n"],
    ["multi-document", "---\ncorrectness: {}\n---\nx: 1\n"],
    ["empty file", ""],
    ["comment-only", "# correctness: enforce\n"],
    ["tab-indented", "correctness:\n\tmode: enforce\n"],
  ];
  for (const [name, yaml] of roots) {
    it(`CX-140 ${name} → adopted or unreadable (never not-adopted)`, async () => {
      const repo = await repoWith(yaml);
      const res = await step(repo);
      expect(
        res.warning,
        `${name}: non-plain-map/unreadable base must never degrade`,
      ).toBeUndefined();
      expect(res.refusal, `${name}: expected a refusal`).toBeTruthy();
    });
  }
});

describe("r23 — CX-131 regression: failed reads are unreadable, never absent", () => {
  it("CX-141a gitlink forge.yaml (submodule entry) → unreadable refusal", async () => {
    const repo = await repoWith(null);
    // Plant a gitlink entry at path forge.yaml.
    const sub = await initRepo({ prefix: "vfy-r23-sub-" });
    dirs.push(sub);
    await gitExec(repo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      sub,
      "forge.yaml",
    ]);
    await gitExec(repo, ["add", "-A"]);
    await gitExec(repo, ["commit", "-qm", "gitlink"]);
    const res = await step(repo);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/could not be read|unreadable|adopted/);
  });
  // The hardened boundary channel (gitEvidence) deliberately bypasses
  // io.exec — failure injection lands on real git failures (dangling blob,
  // non-commit base) or the resolved-binary test seam, never io stubs
  // (CX-46..52).

  it("CX-141b git spawn failure on ls-tree → unreadable refusal", async () => {
    const repo = await repoWith("x: 1\n");
    setVerifierGitBinForTests(join(os.tmpdir(), "cx24-no-such-git"));
    try {
      const res = await runCorrectnessStep(ambientIo, {
        primary: repo,
        worktree: repo,
        base: "HEAD",
      });
      expect(res.warning).toBeUndefined();
      expect(res.refusal?.message).toMatch(/could not be read/);
    } finally {
      setVerifierGitBinForTests(undefined);
    }
  });
  it("CX-141c git spawn failure on show → unreadable refusal", async () => {
    const repo = await repoWith("x: 1\n");
    setVerifierGitBinForTests(join(os.tmpdir(), "cx24-no-such-git"));
    try {
      const res = await runCorrectnessStep(ambientIo, {
        primary: repo,
        worktree: repo,
        base: "HEAD",
      });
      expect(res.warning).toBeUndefined();
      expect(res.refusal?.message).toMatch(/could not be read/);
    } finally {
      setVerifierGitBinForTests(undefined);
    }
  });
  it("CX-141d spawn failure on either read → unreadable refusal", async () => {
    const repo = await repoWith("x: 1\n");
    setVerifierGitBinForTests(join(os.tmpdir(), "cx24-no-such-git"));
    try {
      const res = await runCorrectnessStep(ambientIo, {
        primary: repo,
        worktree: repo,
        base: "HEAD",
      });
      expect(res.warning).toBeUndefined();
      expect(res.refusal?.message).toMatch(/could not be read/);
    } finally {
      setVerifierGitBinForTests(undefined);
    }
  });
  it("CX-141e ls-tree failure (non-commit base) → unreadable refusal", async () => {
    const repo = await repoWith("x: 1\n");
    const res = await step(repo, "0000000000000000000000000000000000000000");
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/could not be read/);
  });
  it("CX-141f show failure while ls-tree lists (deleted blob object) → unreadable refusal", async () => {
    const repo = await repoWith("x: 1\n");
    // Delete forge.yaml's loose blob object: `ls-tree` still lists the entry
    // (the tree object is intact) while `git show` fails on the missing blob.
    const blob = (await gitExec(repo, ["rev-parse", "HEAD:forge.yaml"])).stdout.trim();
    await rm(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const res = await step(repo);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/could not be read/);
  });
});

describe("r23 — legit bootstrap must still degrade (other failure direction)", () => {
  it("CX-142a no forge.yaml at base → degrade warning", async () => {
    await degrade("absent", null);
  });
  it("CX-142b forge.yaml without any contour → degrade warning", async () => {
    await degrade(
      "no contour",
      'schema: forge/config@1\nproject:\n  name: x\nbindings:\n  commands:\n    build: "pnpm build"\n',
    );
  });
  it("CX-142c contour only inside comments/strings → degrade", async () => {
    await degrade(
      "comment/string",
      'x: "correctness: enforce"\n# policy: {mutable: [a]}\nnote: binds paths.correctnessManifest\n',
    );
  });
  it("CX-142d contour nested under a non-top-level key → degrade", async () => {
    await degrade("nested", "outer:\n  correctness: {mode: enforce}\n  policy: {mutable: [a]}\n");
  });
  it("CX-142e merge keys do not resolve (yaml@2 parity with sideFrom) → degrade", async () => {
    await degrade("merge correctness", "defs: &c\n  correctness: {mode: enforce}\n<<: *c\n");
    await degrade("merge policy", "defs: &p\n  policy: {mutable: [a]}\n<<: *p\n");
    await degrade(
      "merge bindings",
      "defs: &b\n  bindings:\n    commands:\n      checkRun: node {file}\n<<: *b\n",
    );
  });
  it("CX-142f dead bindings.paths.rfcsDir key → degrade (gate reads top-level paths only)", async () => {
    await degrade("dead rfcsDir", "bindings:\n  paths:\n    rfcsDir: docs/rfcs\n");
  });
  it("CX-142g null-valued binding rows → degrade (gate arms only on typed values)", async () => {
    await degrade(
      "null bindings",
      "bindings:\n  paths:\n    correctnessManifest: ~\n    oracleReviewsDir: ~\n  commands:\n    checkRun: ~\npaths:\n  rfcsDir: ~\n",
    );
  });
  it("CX-142h non-map bindings/paths containers → degrade (gate reads nothing there)", async () => {
    await degrade("scalar bindings", 'bindings: "x"\npaths: 5\n');
    await degrade("list bindings", "bindings: [correctnessManifest, checkRun]\n");
  });
});

describe("r23 — non-plain/tree/symlink forge.yaml git-object forms", () => {
  it("CX-143a forge.yaml as a directory → adopted (listing is a scalar)", async () => {
    await adopted("dir", null, { dir: true });
  });
  it("CX-143b forge.yaml as a symlink → adopted (target text is a scalar)", async () => {
    const repo = await repoWith("x: 1\n");
    await gitExec(repo, ["rm", "-q", "forge.yaml"]);
    const fs = await import("node:fs/promises");
    await fs.symlink("nonexistent-target", join(repo, "forge.yaml"));
    await gitExec(repo, ["add", "forge.yaml"]);
    await gitExec(repo, ["commit", "-qm", "symlink"]);
    const res = await step(repo);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/already adopted|could not be read/);
  });
});

describe("r23 — unknown-command detection must not be spoofable", () => {
  const binWith = (script: string) => async (repo: string) => {
    await writeFile(join(repo, "node_modules", ".bin", "forge"), script);
    await chmod(join(repo, "node_modules", ".bin", "forge"), 0o755);
  };
  it("CX-144a JSON on stdout + unknown line on stderr → refuse, never degrade", async () => {
    const repo = await repoWith("x: 1\n");
    await binWith(
      `#!/bin/sh\necho '{"status":"pass","violations":[]}'\necho '  ✖ Unknown command: correctness.gate' >&2\nexit 1\n`,
    )(repo);
    const res = await step(repo);
    expect(res.warning).toBeUndefined();
    expect(res.refusal).toBeTruthy();
  });
  it("CX-144b stray { on stdout blocks the degrade even with the exact stderr line", async () => {
    const repo = await repoWith("x: 1\n");
    await binWith(
      `#!/bin/sh\necho '{garbage'\necho '  ✖ Unknown command: correctness.gate' >&2\nexit 1\n`,
    )(repo);
    const res = await step(repo);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/no JSON result/);
  });
  it("CX-144c exit 0 with the phrase → not a failing gate → refuse", async () => {
    const repo = await repoWith("x: 1\n");
    await binWith(`#!/bin/sh\necho '  ✖ Unknown command: correctness.gate' >&2\nexit 0\n`)(repo);
    const res = await step(repo);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/no JSON result/);
  });
  it("CX-144d phrase on stdout instead of stderr → refuse", async () => {
    const repo = await repoWith("x: 1\n");
    await binWith(`#!/bin/sh\necho '  ✖ Unknown command: correctness.gate'\nexit 1\n`)(repo);
    const res = await step(repo);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/no JSON result/);
  });
  it("CX-144e near-miss phrases → refuse (whole-line, exact command)", async () => {
    const variants = [
      "Unknown command: correctness.gate now",
      "xx Unknown command: correctness.gate",
      "Unknown command: correctness.gates",
      "Unknown command: correctness.gate --base",
      "Unknown command: correctnessgate",
      "Unknown command correctness.gate",
    ];
    for (const line of variants) {
      const repo = await repoWith("x: 1\n");
      await writeFile(
        join(repo, "node_modules", ".bin", "forge"),
        `#!/bin/sh\necho '${line}' >&2\nexit 1\n`,
      );
      await chmod(join(repo, "node_modules", ".bin", "forge"), 0o755);
      const res = await step(repo);
      expect(res.warning, `phrase: ${line}`).toBeUndefined();
      expect(res.refusal?.message, `phrase: ${line}`).toMatch(/no JSON result/);
    }
  });
  it("CX-144f phrase wrapped in a violation message → refuse (line must be bare)", async () => {
    const repo = await repoWith("x: 1\n");
    await writeFile(
      join(repo, "node_modules", ".bin", "forge"),
      `#!/bin/sh\necho '  ✖ CORR-GATE-02 weakening (exemption): Unknown command: correctness.gate' >&2\nexit 1\n`,
    );
    await chmod(join(repo, "node_modules", ".bin", "forge"), 0o755);
    const res = await step(repo);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/no JSON result/);
  });
  it("CX-144g spawn failure of the primary binary → refusal", async () => {
    const repo = await repoWith("x: 1\n");
    await writeFile(join(repo, "node_modules", ".bin", "forge"), "not a script\n");
    await chmod(join(repo, "node_modules", ".bin", "forge"), 0o644);
    const res = await step(repo);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/could not start|binary is missing|no JSON result/);
  });
});

describe("r23 — over-approximation sanity: conservative adopted is fail-closed", () => {
  const cases: [string, string][] = [
    ["non-string manifest binding", "bindings:\n  paths:\n    correctnessManifest: 5\n"],
    ["map manifest binding", "bindings:\n  paths:\n    correctnessManifest: {}\n"],
    ["scalar compassDocs", "bindings:\n  paths:\n    compassDocs: docs/x.xml\n"],
    ["empty compassDocs", "bindings:\n  paths:\n    compassDocs: []\n"],
    ["non-string rfcsDir", "paths:\n  rfcsDir: 5\n"],
    ["correctness null", "correctness: ~\n"],
    ["correctness scalar", "correctness: yes\n"],
    ["empty correctness", "correctness: {}\n"],
    ["exempt mode", "correctness:\n  mode: exempt\n"],
    [
      "allow list only",
      "correctness:\n  audit:\n    allow: [{check: correctness.audit, subject: x}]\n",
    ],
  ];
  for (const [name, yaml] of cases) {
    it(`CX-145 ${name} → adopted (fail-closed)`, async () => {
      await adopted(name, yaml);
    });
  }
});

describe("r23 — worktree/git-read layout edges", () => {
  it("CX-147a adoption check from a linked worktree (.git file) still refuses a downgrade", async () => {
    const repo = await repoWith("correctness:\n  mode: enforce\n");
    const wt = join(repo, "wt-check");
    await gitExec(repo, ["worktree", "add", "-f", wt, "HEAD"]);
    dirs.push(wt);
    const res = await runCorrectnessStep(ambientIo, {
      primary: repo,
      worktree: wt,
      base: "HEAD",
    });
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/already adopted/);
  });
  it("CX-147b large forge.yaml spanning spawn chunks still resolves the contour", async () => {
    // >64 KiB of multibyte-heavy comment padding pushes git show across pipe
    // chunk boundaries; a mid-boundary UTF-8 split decodes as U+FFFD inside a
    // scalar, which cannot hide the ASCII contour key (ambient io.exec has no
    // maxBuffer).
    const pad = `# ${"ü".repeat(60000)}\n`;
    const repo = await repoWith(`${pad}correctness:\n  mode: enforce\n`);
    const res = await step(repo);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/already adopted/);
  });
  it("CX-147c gate result inside a {data:} envelope still parses", async () => {
    const repo = await repoWith("x: 1\n");
    await writeFile(
      join(repo, "node_modules", ".bin", "forge"),
      `#!/bin/sh\necho '{"data":{"status":"fail","violations":[{"rule":"CORR-GATE-02","severity":"error","message":"weakening (binding): x"}]}}'\nexit 1\n`,
    );
    await chmod(join(repo, "node_modules", ".bin", "forge"), 0o755);
    const res = await step(repo);
    expect(res.warning).toBeUndefined();
    expect(res.refusal?.message).toMatch(/CORR-GATE-02/);
  });
  it("CX-147d --accept-weakening reason reaches argv verbatim", async () => {
    const repo = await repoWith("x: 1\n");
    const log = join(repo, "argv.log");
    await writeFile(
      join(repo, "node_modules", ".bin", "forge"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\necho '{"status":"pass"}'\nexit 0\n`,
    );
    await chmod(join(repo, "node_modules", ".bin", "forge"), 0o755);
    const reason = 'operator: land it "as-is" --not-a-flag';
    await runCorrectnessStep(ambientIo, {
      primary: repo,
      worktree: repo,
      base: "HEAD",
      acceptWeakening: reason,
    });
    const recorded = (await import("node:fs/promises")).readFile;
    const text = await recorded(log, "utf8");
    expect(text).toContain("--accept-weakening");
    expect(text).toContain(reason);
  });
});

describe("r23 — base argv and binary edge cases", () => {
  it("CX-146a flag-shaped base → unreadable/refusal, never degrade", async () => {
    const repo = await repoWith("x: 1\n");
    const res = await step(repo, "--help");
    expect(res.warning).toBeUndefined();
    expect(res.refusal).toBeTruthy();
  });
  it("CX-146b0 NUL byte inside base argv → refusal (spawn throw = unreadable)", async () => {
    const repo = await repoWith("x: 1\n");
    const res = await step(repo, "HEAD\x00injected");
    expect(res.warning).toBeUndefined();
    expect(res.refusal).toBeTruthy();
  });
  it("CX-146b base with colon → refusal", async () => {
    const repo = await repoWith("x: 1\n");
    const res = await step(repo, "HEAD:forge.yaml");
    expect(res.warning).toBeUndefined();
    expect(res.refusal).toBeTruthy();
  });
  it("CX-146c missing primary binary → refusal", async () => {
    const repo = await repoWith("x: 1\n");
    await rm(join(repo, "node_modules"), { recursive: true, force: true });
    const res = await step(repo);
    expect(res.refusal?.message).toMatch(/binary is missing/);
    expect(res.warning).toBeUndefined();
  });
  it("CX-146d forged pass JSON without a real gate run is still trusted to the primary boundary (documented)", async () => {
    // Boundary note: node_modules/.bin/forge inside the PRIMARY is the trust
    // anchor — a binary printing well-formed pass JSON is accepted verbatim;
    // the adoption check guards only the pre-gate downgrade shape.
    const repo = await repoWith("correctness:\n  mode: enforce\n");
    await writeFile(
      join(repo, "node_modules", ".bin", "forge"),
      `#!/bin/sh\necho '{"status":"pass","bundlePath":null,"violations":[],"weakenings":[],"acceptedWeakening":null}'\nexit 0\n`,
    );
    await chmod(join(repo, "node_modules", ".bin", "forge"), 0o755);
    const res = await step(repo);
    expect(res.status).toBe("pass");
  });
});
