/*
<MODULE_CONTRACT>
<purpose>RFC-1615 round-14 adversarial acceptance verification (independent,
commit ac5892fec): re-verify CX-76..81 under attack and hunt new
counterexample classes (CX-82+). Every probe is hermetic — tmp git repos,
no network; git-failure injection via a resolved-binary shim
(`setVerifierGitBinForTests`) that refuses exact argv prefixes and forwards
everything else to the real git binary — the hardened verifier channel
ignores session PATH by design (CX-52), so injection lands on the resolver
itself.</purpose>
<non-goals>
  <item>Not a contract source of truth — gate/run.ts owns behaviour.</item>
  <item>Never modifies gate source; probe-only file.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1615: round-14 adversarial verification probes (CX-76..CX-85)</item>
  <item>RFC-1615: close RFC-1615 round-15 counterexamples — live rfcsDir key, base-anchored governing-reference resolution, judged compassDocs</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r14 trust-boundary counterexamples</item>
</CHANGE_SUMMARY>
*/

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { setVerifierGitBinForTests } from "../../../src/utils/verifier-git.ts";
import { deriveOrigin, type OriginResult } from "./origin.ts";
import { sideFrom } from "./frozen.ts";
import { GateRepo } from "./repo.ts";
import { runCorrectnessGate } from "./run.ts";
import { makeGateFixture, ORACLE_PATH, type GateFixture } from "./tests/gate-fixture.ts";
import { listWorkspaceFiles, settingsFromForgeDoc } from "../workspace.ts";

const fixtures: GateFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const fx = (o: Parameters<typeof makeGateFixture>[0] = {}) => {
  const f = makeGateFixture(o);
  fixtures.push(f);
  return f;
};

const gate = async (
  f: GateFixture,
  base = f.base,
  acceptWeakening?: string,
  policyOnly = false,
) => {
  const out = await runCorrectnessGate(f.root, {
    base,
    bundleDir: `${f.root}/.bundles`,
    acceptWeakening,
    policyOnly,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
};

/** Entry 2 shapes used by the laundering probes (anchor/oracle reuse keeps CORR-04/05 green). */
const LAUNDRY_ENTRY = (source: string, ref: string) => `  - id: CM-rfc-02
    source: ${source}
    ref: ${ref}
    seam: other
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:${ORACLE_PATH}
        substrate: L0
`;

const manifestWith = (extra: string) => `schema: forge/correctness-manifest@1
entries:
  - id: CM-dispatch-01
    source: req
    ref: REQ-01
    seam: data
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:${ORACLE_PATH}
        substrate: L1
${extra}support: []
exemptions: []
`;

const PLANTED_RFC = `---
id: RFC-0005
status: accepted
---
## Acceptance criteria
- [x] AC-1: the oracle passes (evidence: probe)
`;

/**
 * Bin shim: refuses exact argv prefixes with exit 121, forwards the rest to
 * the real git binary. Arms BOTH channels — the resolved-binary seam for
 * hardened evidence reads (`setVerifierGitBinForTests`; session-PATH
 * injection is the attack CX-52 closed, so the module seam is the in-process
 * equivalent) and PATH for ordinary io.exec worktree reads like `ls-files`.
 */
function makeGitShim(matchers: string[][]): { arm(): void; disarm(): void; dispose(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rfc1615-git-shim-"));
  // The real BINARY, not the PATH-resolved `git` — on this workspace that is the
  // ADR-0078 wrapper, which re-scans PATH and would recurse into this shim.
  const real =
    ["/usr/bin/git", "/bin/git"].find((p) => existsSync(p)) ??
    execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const matchers = ${JSON.stringify(matchers)};
for (const m of matchers) {
  if (m.length <= args.length && m.every((a, i) => args[i] === a)) {
    process.stderr.write("rfc1615-shim: refused " + m.join(" ") + "\\n");
    process.exit(121);
  }
}
const { spawnSync } = require("node:child_process");
const r = spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`;
  const shim = path.join(dir, "git");
  writeFileSync(shim, script);
  chmodSync(shim, 0o755);
  const prev = process.env.PATH ?? "";
  return {
    arm: () => {
      process.env.PATH = `${dir}:${prev}`;
      setVerifierGitBinForTests(shim);
    },
    disarm: () => {
      process.env.PATH = prev;
      setVerifierGitBinForTests(undefined);
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Minimal git repo for deriveOrigin unit probes: c1 (draft RFC) → A (acceptance) → c2 (post). */
function originRepo(opts: {
  acceptBody: string;
  postBody?: string;
  archive?: boolean;
  checkAtAccept?: boolean;
}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "rfc1615-origin-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).toString().trim();
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  git(["init", "-q", "-b", "develop"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  write("docs/rfcs/rfc-0005-req.md", "status: draft\n");
  write("README.md", "init\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "c1"]);
  const c1 = git(["rev-parse", "HEAD"]);
  const rfcRel = opts.archive ? "docs/rfcs/archive/rfc-0005-req.md" : "docs/rfcs/rfc-0005-req.md";
  rmSync(path.join(root, "docs/rfcs/rfc-0005-req.md"));
  write(rfcRel, "status: accepted\n");
  if (opts.checkAtAccept !== false) write("test/o.ts", "export const o = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", opts.acceptBody]);
  const accept = git(["rev-parse", "HEAD"]);
  write("README.md", "post\n");
  if (opts.checkAtAccept === false) write("test/o.ts", "export const o = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", opts.postBody ?? "c2"]);
  const post = git(["rev-parse", "HEAD"]);
  return {
    root,
    git,
    c1,
    accept,
    post,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function derive(
  root: string,
  head: string,
  integrationBase: string,
  failCommitBodyOf?: string[],
): Promise<{ res: OriginResult; flags: number }> {
  const shims = failCommitBodyOf?.length
    ? [makeGitShim(failCommitBodyOf.map((sha) => ["log", "-1", "--format=%B", sha]))]
    : [];
  shims.forEach((s) => s.arm());
  try {
    const repo = new GateRepo(root);
    const before = repo.unreadableReads.length;
    const res = await deriveOrigin({
      repo,
      head,
      check: "test:test/o.ts",
      source: "rfc-ac",
      ref: "RFC-0005/AC-1",
      rfcsDir: "docs/rfcs",
      reviews: [],
      checkFile: "test/o.ts",
      integrationBase,
    });
    return { res, flags: repo.unreadableReads.length - before };
  } finally {
    shims.forEach((s) => {
      s.disarm();
      s.dispose();
    });
  }
}

describe("round-14 re-verification: CX-76 (baseFilesComplete / glob additions)", () => {
  const policyBase = () =>
    fx({
      forgeYamlAppend: 'policy:\n  freezeFiles: ["frozen/**"]\n',
      extraFiles: { "frozen/a.txt": "v1\n" },
    });

  it("CX-76a: a failed base ls-tree suppresses the fabricated 'new file' claim for an EDITED glob-frozen file; the edit is still judged via blob(base) and the read failure refuses", async () => {
    const f = policyBase();
    f.write("frozen/a.txt", "v2\n");
    f.commit("edit a frozen policy file");
    const shim = makeGitShim([["ls-tree", "-r", "-z", "--name-only", f.base]]);
    shim.arm();
    try {
      const r = await gate(f);
      expect(
        r.violations.some((v) => v.rule === "CORR-GATE-01" && /a git read failed/.test(v.message)),
      ).toBe(true);
      expect(
        r.weakenings.some((w) => w.subject === "frozen/a.txt" && /new file/.test(w.message)),
      ).toBe(false);
      expect(
        r.weakenings.some((w) => w.kind === "policy-file" && w.subject === "frozen/a.txt"),
      ).toBe(true);
      expect(r.status).toBe("fail");
    } finally {
      shim.disarm();
      shim.dispose();
    }
  }, 30_000);

  it("CX-76b: a failed base ls-tree still reports a GENUINE addition — but only alongside the fail-closed refusal", async () => {
    const f = policyBase();
    f.write("frozen/new.txt", "n\n");
    f.commit("add under the frozen glob");
    const shim = makeGitShim([["ls-tree", "-r", "-z", "--name-only", f.base]]);
    shim.arm();
    try {
      const r = await gate(f);
      expect(
        r.weakenings.some(
          (w) =>
            w.kind === "policy-file" &&
            w.subject === "frozen/new.txt" &&
            /new file/.test(w.message),
        ),
      ).toBe(true);
      expect(
        r.violations.some((v) => v.rule === "CORR-GATE-01" && /a git read failed/.test(v.message)),
      ).toBe(true);
      expect(r.status).toBe("fail");
    } finally {
      shim.disarm();
      shim.dispose();
    }
  }, 30_000);

  it("CX-76c: BOTH enumerations failed — additions come from the diff fallback, edits are recovered per-path, refusal stands", async () => {
    const f = policyBase();
    f.write("frozen/a.txt", "v2\n");
    f.write("frozen/new.txt", "n\n");
    f.commit("edit + add under the frozen glob");
    const shim = makeGitShim([["ls-tree", "-r", "-z", "--name-only"]]);
    shim.arm();
    try {
      const r = await gate(f);
      expect(
        r.weakenings.some((w) => w.kind === "policy-file" && w.subject === "frozen/new.txt"),
      ).toBe(true);
      expect(
        r.weakenings.some((w) => w.kind === "policy-file" && w.subject === "frozen/a.txt"),
      ).toBe(true);
      expect(
        r.violations.some((v) => v.rule === "CORR-GATE-01" && /a git read failed/.test(v.message)),
      ).toBe(true);
      expect(r.status).toBe("fail");
    } finally {
      shim.disarm();
      shim.dispose();
    }
  }, 30_000);

  it("CX-76d: blob(base) resolving a TREE type (dir→file flip under the glob) is judged an addition, never a byte edit", async () => {
    const f = policyBase();
    f.write("frozen/x.txt/keep.txt", "k\n");
    f.commit("dir under the glob");
    const base2 = f.git(["rev-parse", "HEAD"]);
    f.git(["rm", "-q", "-r", "frozen/x.txt"]);
    f.write("frozen/x.txt", "f\n");
    f.commit("flip dir to file");
    const r = await gate(f, base2);
    expect(
      r.weakenings.some(
        (w) =>
          w.kind === "policy-file" && w.subject === "frozen/x.txt" && /new file/.test(w.message),
      ),
    ).toBe(true);
    expect(
      r.weakenings.some(
        (w) => w.subject === "frozen/x.txt/keep.txt" && /was deleted/.test(w.message),
      ),
    ).toBe(true);
    expect(r.status).toBe("fail");
  }, 30_000);
});

describe("round-14 re-verification: CX-77 (binding adds)", () => {
  it("CX-77a: adding checkRun / rfcsDir bindings under a declared contour (base manifest bound) are binding weakenings", async () => {
    const f = fx();
    f.write("forge.yaml", f.read("forge.yaml").replace('    checkRun: "node {file}"\n', ""));
    const base = f.commit("base without checkRun");
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("  paths:", "  paths:\n    rfcsDir: docs/rfcs2\n")
        .replace(
          "correctness:",
          'commands:\n    checkRun: "node {file}"\n  paths2: null\ncorrectness:',
        ),
    );
    // rebuild cleanly instead of the fragile replace above — the LIVE
    // rfcsDir key is the top-level `paths:` object (CX-82), not
    // `bindings.paths` (stripped by the loader).
    f.write(
      "forge.yaml",
      `schema: forge/config@1
project:
  name: gate-fixture
paths:
  rfcsDir: docs/rfcs2
bindings:
  schema: forge/bindings@1
  commands:
    checkRun: "node {file}"
  paths:
    compassDocs: [docs/requirements.xml]
    correctnessManifest: docs/correctness.yaml
correctness:
  mode: enforce
  tier: standard
`,
    );
    f.commit("session adds checkRun + rfcsDir bindings");
    const r = await gate(f, base);
    const msgs = r.weakenings.filter((w) => w.kind === "binding").map((w) => w.message);
    expect(msgs.some((m) => /bindings\.commands\.checkRun added/.test(m))).toBe(true);
    expect(msgs.some((m) => /paths\.rfcsDir added/.test(m))).toBe(true);
    expect(r.status).toBe("fail");
  }, 30_000);

  it("CX-77b: binding adds under a base manifest that is bound but UNPARSABLE still refuse (CORR-GATE-02 on the unreadable manifest)", async () => {
    const f = fx();
    f.write("docs/correctness.yaml", ":::: not yaml [[[\n");
    const base = f.commit("break the base manifest");
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace(
          "    correctnessManifest: docs/correctness.yaml",
          "    correctnessManifest: docs/correctness.yaml\n    rfcsDir: docs/rfcs2",
        ),
    );
    f.commit("session adds a binding");
    const r = await gate(f, base);
    expect(
      r.violations.some(
        (v) => v.rule === "CORR-GATE-02" && /does not parse with this forge/.test(v.message),
      ),
    ).toBe(true);
    expect(r.status).toBe("fail");
  }, 30_000);

  it("CX-77c: a rebind restored to the base value across two session commits leaves no weakening at HEAD; command adds outside the judged keys are unjudged (documented surface)", async () => {
    const f = fx();
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace('checkRun: "node {file}"', 'checkRun: "true {file}"\n    lint: "evil {file}"'),
    );
    f.commit("rebind checkRun + add lint");
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace(
          'checkRun: "true {file}"\n    lint: "evil {file}"',
          'checkRun: "node {file}"\n    lint: "evil {file}"',
        ),
    );
    f.commit("restore checkRun");
    const r = await gate(f);
    expect(r.weakenings.some((w) => w.kind === "binding" && /checkRun/.test(w.message))).toBe(
      false,
    );
    expect(r.weakenings.some((w) => /lint/.test(w.message))).toBe(false);
  }, 30_000);
});

describe("round-14 re-verification: CX-78 (base-side RFC namespace)", () => {
  it("CX-78a: deriveOrigin resolves the RFC at the integration base — a HEAD-planted earlier-sorting duplicate does not win", async () => {
    const o = originRepo({ acceptBody: "accept: RFC-0005\n\nX-RFC: RFC-0005" });
    try {
      // plant a duplicate whose name sorts before the real file, committed at HEAD
      const plant = path.join(o.root, "docs/rfcs/rfc-0005-aaa.md");
      writeFileSync(plant, "status: accepted\n");
      o.git(["add", "-A"]);
      o.git(["commit", "-qm", "plant duplicate"]);
      const head = o.git(["rev-parse", "HEAD"]);
      const { res } = await derive(o.root, head, o.post);
      expect(res.origin).toBe("requirement");
      expect(res.detail).toContain(o.accept.slice(0, 9));
    } finally {
      o.cleanup();
    }
  }, 30_000);

  it("CX-78b: the archive subtree (docs/rfcs/archive/**) resolves as governing at the base", async () => {
    const o = originRepo({ acceptBody: "accept: RFC-0005\n\nX-RFC: RFC-0005", archive: true });
    try {
      const { res } = await derive(o.root, o.post, o.post);
      expect(res.origin).toBe("requirement");
    } finally {
      o.cleanup();
    }
  }, 30_000);
});

describe("round-14 re-verification: CX-79 (governed acceptance provenance)", () => {
  const GOV = "accept: RFC-0005\n\nX-RFC: RFC-0005";
  it("CX-79 matrix: X-RFC case/whitespace variants, spoof attempts, commitBody failure, range edges", async () => {
    const cases: {
      name: string;
      acceptBody: string;
      postBody?: string;
      base?: "c1" | "A" | "post";
      checkAtAccept?: boolean;
      expectOrigin: string;
      failBodyOf?: "A";
      expectFlags?: number;
    }[] = [
      { name: "plain acceptance commit", acceptBody: "accept: RFC-0005", expectOrigin: "self" },
      { name: "X-RFC: RFC-0005 (convention)", acceptBody: GOV, expectOrigin: "requirement" },
      {
        name: "x-rfc: lowercase",
        acceptBody: "accept\n\nx-rfc: RFC-0005",
        expectOrigin: "requirement",
      },
      {
        name: "X-RFC:RFC-0005 (no space)",
        acceptBody: "accept\n\nX-RFC:RFC-0005",
        expectOrigin: "requirement",
      },
      {
        name: "X-RFC with extra tokens",
        acceptBody: "accept\n\nX-RFC: RFC-0005 extra tokens",
        expectOrigin: "self",
      },
      { name: "X-ADR only (spoof)", acceptBody: "accept\n\nX-ADR: ADR-0001", expectOrigin: "self" },
      {
        name: "verifier trailer pair (promotes via the verified path — the pair's commit is also the check file's last touch)",
        acceptBody:
          "accept\n\nX-Expectation-Origin: independent-verifier\nX-Verifier-Report: docs/rfcs/rfc-0005-req.md",
        expectOrigin: "verified",
      },
      {
        name: "governed trailer on a NON-acceptance commit",
        acceptBody: "accept: RFC-0005",
        postBody: "post\n\nX-RFC: RFC-0005",
        expectOrigin: "self",
      },
      {
        name: "commitBody read failure flags and stays self",
        acceptBody: GOV,
        expectOrigin: "self",
        failBodyOf: "A",
        expectFlags: 1,
      },
      {
        name: "range.base == integration base",
        acceptBody: GOV,
        base: "A",
        expectOrigin: "requirement",
      },
      {
        name: "acceptance AFTER the integration base",
        acceptBody: GOV,
        base: "c1",
        expectOrigin: "self",
      },
      {
        name: "multiple X-RFC lines (batch convention: per-id line match)",
        acceptBody: "accept\n\nX-RFC: RFC-0006\nX-RFC: RFC-0005",
        expectOrigin: "requirement",
      },
      {
        name: "check file not committed at the acceptance commit",
        acceptBody: GOV,
        checkAtAccept: false,
        expectOrigin: "self",
      },
    ];
    for (const c of cases) {
      const o = originRepo({
        acceptBody: c.acceptBody,
        postBody: c.postBody,
        checkAtAccept: c.checkAtAccept,
      });
      try {
        const base = c.base === "A" ? o.accept : c.base === "c1" ? o.c1 : o.post;
        const { res, flags } = await derive(
          o.root,
          o.post,
          base,
          c.failBodyOf === "A" ? [o.accept] : undefined,
        );
        expect(res.origin, c.name).toBe(c.expectOrigin);
        if (c.expectFlags !== undefined) expect(flags, c.name).toBe(c.expectFlags);
        if (c.expectOrigin === "requirement" && !c.failBodyOf) {
          expect(res.detail, c.name).toContain(o.accept.slice(0, 9));
        }
        if (c.expectOrigin === "verified") expect(res.viaTrailer, c.name).toBe(true);
      } finally {
        o.cleanup();
      }
    }
  }, 60_000);

  function rfcEndToEndFixture(acceptBody: string) {
    const f = fx({ mode: "enforce" });
    f.write("docs/rfcs/rfc-0005-req.md", `${PLANTED_RFC}`);
    f.write("test/rfc.oracle.ts", "process.exit(0);\n");
    f.write(
      "apps/api/src/rfc.ts",
      `export function rfc(): void {\n  // @ai-invariant[INV-rfc-01]: the rfc oracle covers the acceptance criterion\n  //   (checked-by: test:test/rfc.oracle.ts)\n}\n`,
    );
    f.write(
      "docs/correctness.yaml",
      manifestWith(`  - id: CM-rfc-02
    source: rfc-ac
    ref: RFC-0005/AC-1
    seam: other
    anchors: [INV-rfc-01]
    oracles:
      - check: test:test/rfc.oracle.ts
        substrate: L0
`),
    );
    f.git(["add", "-A"]);
    f.git(["commit", "-qm", acceptBody]);
    const acceptBase = f.git(["rev-parse", "HEAD"]);
    f.commit("session work (--allow-empty)");
    return { f, acceptBase };
  }

  it("CX-79 gate: a governed (X-RFC) acceptance commit mints requirement origin end-to-end — pass", async () => {
    const { f, acceptBase } = rfcEndToEndFixture(GOV);
    const r = await gate(f, acceptBase);
    const entry = r.weakenings.length;
    expect(entry).toBe(0);
    expect(r.status).toBe("pass");
  }, 60_000);

  it("CX-79 gate: an UNGOVERNED acceptance commit cannot mint a requirement oracle — CORR-GATE-03 refuses", async () => {
    const { f, acceptBase } = rfcEndToEndFixture("accept: RFC-0005");
    const r = await gate(f, acceptBase);
    expect(r.violations.some((v) => v.rule === "CORR-GATE-03" && /CM-rfc-02/.test(v.message))).toBe(
      true,
    );
    expect(r.status).toBe("fail");
  }, 60_000);
});

describe("round-14 re-verification: CX-80 (malformed policy zeroing)", () => {
  it("CX-80a: a HEAD-malformed policy does NOT disarm the base-declared freeze globs — the addition is still judged and the malformed refusal stands", async () => {
    const f = fx({
      forgeYamlAppend: 'policy:\n  freezeFiles: ["frozen/**"]\n',
      extraFiles: { "frozen/a.txt": "v1\n" },
    });
    f.write("frozen/new.txt", "n\n");
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('policy:\n  freezeFiles: ["frozen/**"]\n', "policy: [1, 2]\n"),
    );
    f.commit("malform the policy + add under the old glob");
    const r = await gate(f);
    expect(
      r.violations.some(
        (v) =>
          v.rule === "CORR-GATE-01" && /at HEAD/.test(v.message) && /malformed/.test(v.message),
      ),
    ).toBe(true);
    // the frozen set is read at --base: a session cannot disarm the base freeze by malforming its own copy
    expect(
      r.weakenings.some(
        (w) =>
          w.kind === "policy-file" && w.subject === "frozen/new.txt" && /new file/.test(w.message),
      ),
    ).toBe(true);
    expect(r.status).toBe("fail");
  }, 30_000);

  it("CX-80b: a BASE-malformed policy (negation glob) refuses and zeroes — no addition claims", async () => {
    const f = fx({ forgeYamlAppend: 'policy:\n  freezeFiles: ["!x"]\n' });
    f.write("frozen/new.txt", "n\n");
    f.commit("add a file");
    const r = await gate(f);
    expect(
      r.violations.some(
        (v) =>
          v.rule === "CORR-GATE-01" && /at --base/.test(v.message) && /malformed/.test(v.message),
      ),
    ).toBe(true);
    expect(r.weakenings.some((w) => w.subject === "frozen/new.txt")).toBe(false);
    expect(r.status).toBe("fail");
  }, 30_000);

  it("CX-80c: policy: {} is a VALID deny-by-default declaration — a frozen top-level key change is a policy-key weakening", async () => {
    const f = fx({ forgeYamlAppend: "policy: {}\n" });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("name: gate-fixture", "name: gate-fixture-x"),
    );
    f.commit("change a frozen key");
    const r = await gate(f);
    expect(
      r.weakenings.some(
        (w) => w.kind === "policy-key" && /project\.name/.test(w.subject + w.message),
      ),
    ).toBe(true);
    expect(r.status).toBe("fail");
  }, 30_000);

  it("CX-80d: --accept-weakening cannot launder a malformed-policy refusal (CORR-GATE-01 persists)", async () => {
    const f = fx({
      forgeYamlAppend: 'policy:\n  freezeFiles: ["frozen/**"]\n',
      extraFiles: { "frozen/a.txt": "v1\n" },
    });
    f.write("frozen/new.txt", "n\n");
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('policy:\n  freezeFiles: ["frozen/**"]\n', 'policy: "nope"\n'),
    );
    f.commit("malform the policy");
    const r = await gate(f, f.base, "operator: accept");
    expect(r.violations.some((v) => v.rule === "CORR-GATE-01" && /malformed/.test(v.message))).toBe(
      true,
    );
    expect(r.status).toBe("fail");
  }, 30_000);
});

describe("round-14 re-verification: CX-81 (listWorkspaceFiles / onGitFailure)", () => {
  it("CX-81a: a failed git ls-files flags CORR-01 + unreadableReads, refuses the gate, and refuses --accept-weakening (flag lands before the accept check)", async () => {
    const f = fx();
    // a real weakening (deleted base entry) so the accept path engages
    f.write(
      "docs/correctness.yaml",
      "schema: forge/correctness-manifest@1\nentries: []\nsupport: []\nexemptions: []\n",
    );
    f.commit("session drops the frozen entry");
    // The shim matches SPAWN argv — `evidenceSpawnArgs` strips
    // `--exclude-standard` from `ls-files` bodies (CX-142), so the
    // trusted enumeration reaches git as `ls-files -z --cached
    // --others`; refuse that shape.
    const shim = makeGitShim([["ls-files", "-z", "--cached", "--others"]]);
    shim.arm();
    try {
      const plain = await gate(f);
      expect(
        plain.violations.some((v) => v.rule === "CORR-GATE-01" && /ls-files/.test(v.message)),
      ).toBe(true);
      expect(
        plain.violations.some(
          (v) => v.rule === "CORR-GATE-01" && /a git read failed/.test(v.message),
        ),
      ).toBe(true);
      expect(plain.status).toBe("fail");
      const accepted = await gate(f, f.base, "operator: accept");
      expect(
        accepted.violations.some(
          (v) => v.rule === "CORR-GATE-02" && /a git read failed/.test(v.message),
        ),
      ).toBe(true);
      expect(accepted.status).toBe("fail");
    } finally {
      shim.disarm();
      shim.dispose();
    }
  }, 60_000);

  it("CX-81b: a linked worktree (.git FILE) lists normally — no fallback, no flag", async () => {
    const main = mkdtempSync(path.join(os.tmpdir(), "rfc1615-main-"));
    try {
      const git = (args: string[]) =>
        execFileSync("git", args, { cwd: main, encoding: "utf8" }).toString().trim();
      git(["init", "-q", "-b", "develop"]);
      git(["config", "user.email", "t@t.t"]);
      git(["config", "user.name", "t"]);
      writeFileSync(path.join(main, "a.txt"), "a\n");
      git(["add", "-A"]);
      git(["commit", "-qm", "init"]);
      const wt = path.join(os.tmpdir(), `rfc1615-wt-${Date.now()}`);
      git(["worktree", "add", "-q", wt, "-b", "wt-branch"]);
      try {
        const failures: string[] = [];
        const files = await listWorkspaceFiles(wt, (l) => failures.push(l));
        expect(failures).toEqual([]);
        expect(files).toContain("a.txt");
      } finally {
        rmSync(wt, { recursive: true, force: true });
        git(["worktree", "prune"]);
      }
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  }, 30_000);

  it("CX-81c: a missing git binary reaches onGitFailure (spawn ENOENT) and falls back disclosed", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "rfc1615-nogit-"));
    try {
      writeFileSync(path.join(root, ".git"), "gitdir: nowhere\n");
      writeFileSync(path.join(root, "x.txt"), "x\n");
      const failures: string[] = [];
      const prev = process.env.PATH;
      process.env.PATH = "/nonexistent-rfc1615";
      try {
        const files = await listWorkspaceFiles(root, (l) => failures.push(l));
        expect(failures).toEqual(["ls-files --cached --others --exclude-standard"]);
        expect(files).toContain("x.txt");
      } finally {
        process.env.PATH = prev;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("round-14 new classes", () => {
  it("CX-82: the LIVE rfcsDir key is judged and CORR-03 resolves at the base — a session-planted governing RFC (with the live-key rebind) cannot launder CORR-03", async () => {
    const f = fx({ mode: "enforce" });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("paths: {}", "paths:\n  rfcsDir: planted-rfcs"),
    );
    f.write("planted-rfcs/rfc-0005-laundry.md", PLANTED_RFC);
    f.write("docs/correctness.yaml", manifestWith(LAUNDRY_ENTRY("rfc-ac", "RFC-0005/AC-1")));
    f.commit("session: plant the governing RFC + rebind the live namespace key");
    const r = await gate(f);
    // The live-key rebind is a judged binding weakening, and the planted RFC
    // cannot satisfy base-anchored CORR-03.
    expect(r.weakenings.some((w) => w.kind === "binding" && /rfcsDir/.test(w.subject))).toBe(true);
    expect(r.status).toBe("fail");
  }, 60_000);

  it("CX-82 control: without the planted RFC the same entry refuses as CORR-GATE-01 (CORR-03 unresolved)", async () => {
    const f = fx({ mode: "enforce" });
    f.write("docs/correctness.yaml", manifestWith(LAUNDRY_ENTRY("rfc-ac", "RFC-0005/AC-1")));
    f.commit("session: add the rfc-ac entry only");
    const r = await gate(f);
    expect(r.violations.some((v) => v.rule === "CORR-GATE-01")).toBe(true);
    expect(r.status).toBe("fail");
  }, 60_000);

  it("CX-83: the same laundering via an unjudged compassDocs binding add (planted requirements document) — enforce-mode pass", async () => {
    const f = fx({ mode: "enforce" });
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace("    compassDocs: [docs/requirements.xml]\n", ""),
    );
    const base = f.commit("base without compassDocs");
    f.write("docs/correctness.yaml", manifestWith(LAUNDRY_ENTRY("req", "REQ-FAKE")));
    f.commit("session: add a req entry the base cannot resolve");
    const control = await gate(f, base);
    expect(control.violations.some((v) => v.rule === "CORR-GATE-01")).toBe(true);
    expect(control.status).toBe("fail");
    f.write(
      "planted-req.xml",
      '<requirements>\n  <meta><document-id>requirements</document-id></meta>\n  <requirement id="REQ-01">a</requirement>\n  <requirement id="REQ-FAKE">b</requirement>\n</requirements>\n',
    );
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace(
          "    correctnessManifest:",
          "    compassDocs: [planted-req.xml]\n    correctnessManifest:",
        ),
    );
    f.commit("session: rebind compassDocs at the planted requirements doc");
    const attack = await gate(f, base);
    // The compassDocs rebind is a judged binding weakening (CX-83 fix).
    expect(
      attack.weakenings.some((w) => w.kind === "binding" && /compassDocs/.test(w.subject)),
    ).toBe(true);
    expect(attack.status).toBe("fail");
  }, 90_000);

  it("CX-84 (no finding): dotted-key smuggling under bindings is inert in both readers", () => {
    const doc = { bindings: { "paths.rfcsDir": "planted" } } as Record<string, unknown>;
    expect(sideFrom(JSON.stringify(doc), () => null).rfcsDir).toBeNull();
    expect(settingsFromForgeDoc(doc, false).rfcsDir).toBe("docs/rfcs");
    const top = { "paths.rfcsDir": "planted" } as Record<string, unknown>;
    expect(settingsFromForgeDoc(top, false).rfcsDir).toBe("docs/rfcs");
  });

  it("CX-85 (no finding): explicit null rfcsDir fails the schema probe (configError), the default applies only to absence", () => {
    expect(settingsFromForgeDoc({ paths: { rfcsDir: null } }, false).configError).not.toBeNull();
    expect(settingsFromForgeDoc({ paths: { rfcsDir: "x" } }, false).rfcsDir).toBe("x");
    expect(settingsFromForgeDoc({}, false).rfcsDir).toBe("docs/rfcs");
  });
});
