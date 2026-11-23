/*
<MODULE_CONTRACT>
<purpose>
RFC-1616 acceptance probes — independent round-5 verification of the external
verification trust boundary against export candidate f71fdbe5. Every probe
FAILS when the counterexample is live and PASSES when closed; numbering
continues from CX-71 (round 4 reported CX-61..CX-71).

Round-5 attack surfaces (opened or left over by the r4 hardening):
  - transport-level config keys the -c pins never cover: core.gitProxy,
    remote.origin.proxy, URL-scoped http.<url>.*, credential.<url>.helper —
    a generic `-c key=` pin cannot beat a remote- or URL-scoped twin, so the
    "trusted" ls-remote/fetch can be MITM'd end-to-end while remote-identity
    parity stays quiet.
  - remote.origin.pushurl lists: `remote get-url --push` returns only the
    FIRST push url while `git push` delivers to ALL of them — the second
    pushurl escapes FLOW-PUSH-09 and the trailer commit lands on the real
    origin unflagged.
  - repo-config programs that execute on admitted "read" argv: core.hooksPath
    (reference-transaction on the pinned fetch), diff.*.textconv (plain git
    diff), filter.*.smudge (cat-file --filters) — the evidence allowlist
    mirrors READ_ONLY_GIT_QUERIES, whose own contract trusts repo config.
  - argv shapes the evidence predicate admits that are not reads:
    diff --no-index (arbitrary file read) and fetch +src:refs/heads/*
    (integration-branch rewrite).
  - session-writable history topology: .git/info/grafts is NOT gated by
    GIT_NO_REPLACE_OBJECTS — rev-list/merge-base answers lie on the trusted
    channel.
  - adoption verdicts satisfied by CI that can never fail: dead run:
    structure (exit 0 / set +e / if-false wrap), expression continue-on-error,
    invalid on.push subkeys — and symlinked boundary paths the scaffold
    writes through.
  - the --dry-run trailer scan reported on unverified tracking refs, and
    filterEvidenceExtraEnv/verifierSpawnEnv env-lever gaps (PATH and
    preload levers ride back in).
</purpose>
<non-goals>
  <item>Not a contract source of truth — src/utils/verifier-git.ts, os/flow/**, src/onboarding/trust-boundary.ts own behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import {
  FORGE_POLICY_WORKFLOW,
  scaffoldTrustBoundary,
} from "../../../src/onboarding/trust-boundary.ts";
import {
  filterEvidenceExtraEnv,
  setVerifierGitBinForTests,
  verifierGitEnv,
  verifierSpawnEnv,
} from "../../../src/utils/verifier-git.ts";
import { collectDigest } from "../../flow/digest.ts";
import { gitEvidence, isEvidenceGitQuery } from "../../flow/git.ts";
import { pushFlow } from "../../flow/handlers/flow-push.ts";
import { gitExec, initRepoWithOrigin } from "../../flow/tests/helpers.ts";

/** The slice shape the static-scan probes consume from the scanner. */
interface KernelSourceScanner {
  handlerSlices(file: string, handler: string): { file: string; allowlistedGitEntry?: boolean }[];
}

const SCANNER_SPEC: string = "@warpgogol/werkstatt-shared/node/kernel-source-scan";

/**
 * The kernel source scanner ships only inside the werkstatt monorepo — the
 * standalone forge extract carries no @warpgogol/werkstatt-shared at all, so
 * the static-scan half of the R5-R4 probe loads it lazily and stands down
 * when it cannot resolve. A widened specifier keeps tsc honest in the
 * extract (a literal would fail TS2307 there).
 */
async function loadSourceScanner(): Promise<((root: string) => KernelSourceScanner) | undefined> {
  try {
    const mod = (await import(SCANNER_SPEC)) as {
      createSourceScanner?: (root: string) => KernelSourceScanner;
    };
    return mod.createSourceScanner;
  } catch {
    return undefined;
  }
}

const dirs: string[] = [];
const spawned: Array<{ kill: () => void }> = [];
afterEach(() => {
  for (const p of spawned.splice(0)) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  setVerifierGitBinForTests(undefined);
});

/**
 * Host hygiene — the outer session PATH may carry git guard wrappers; strip
 * any dir that ships a git-wrapper.sh so `git` in probes is the real binary.
 */
const CLEAN_PATH = (process.env["PATH"] ?? "")
  .split(path.delimiter)
  .filter((d) => d.length > 0 && !existsSync(path.join(d, "git-wrapper.sh")))
  .join(path.delimiter);
beforeAll(() => {
  process.env["PATH"] = CLEAN_PATH;
});

const gitIn = (root: string, args: string[], input?: string) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input,
  });

/** Commit a file carrying one verifier trailer pair, return its sha. */
async function trailerCommit(repo: string, file: string, trailerLine: string): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(repo, file), "x\n");
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-qm", `session work\n\n${trailerLine}`]);
  return (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

/** A plain (trailer-free) commit on top of HEAD, return its sha. */
async function cleanCommit(repo: string, file: string): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(repo, file), "y\n");
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-qm", "clean follow-up"]);
  return (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

const pushed08 = (data: { pushed: boolean; diagnostics: { ruleId: string }[] }) =>
  data.pushed === false || data.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-08");

/**
 * A fake `core.gitProxy`: consume the client's service-request pkt-line,
 * then splice the byte stream onto the REAL git server binary serving the
 * session's fake repo. git executes the configured proxy path directly
 * (no shell), so the fake path is baked in.
 */
function writeGitProxy(parent: string, fake: string): { proxy: string; log: string } {
  const proxy = path.join(parent, "fake-proxy.sh");
  const log = path.join(parent, "proxy.log");
  writeFileSync(
    proxy,
    `#!/bin/sh
hdr=$(dd bs=1 count=4 2>/dev/null)
len=$((0x$hdr))
req=$(dd bs=1 count=$((len-4)) 2>/dev/null)
echo "PROXY-EXEC $req" >> ${JSON.stringify(log)}
case "$req" in
  git-receive-pack*) exec git receive-pack ${JSON.stringify(fake)} ;;
  *) exec git upload-pack ${JSON.stringify(fake)} ;;
esac
`,
  );
  chmodSync(proxy, 0o755);
  return { proxy, log };
}

const WORKFLOW_STEPS = `      - run: forge correctness.gate --policy-only --base HEAD~1
      - run: forge policy.digest --verify
      - run: forge pinned.validate --mode ci
`;

function plantWorkflow(body: string): { root: string; rel: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx5-scaffold-"));
  dirs.push(root);
  const rel = ".github/workflows/forge-policy.yml";
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
  return { root, rel };
}

const adoptedWorkflow = (body: string): boolean => {
  const { root, rel } = plantWorkflow(body);
  return scaffoldTrustBoundary(root, "@operator").skipped.some((s) => s.includes(rel));
};

// ===========================================================================
// A. transport-level config keys the -c pins never cover
// ===========================================================================

describe("RFC-1616 r5 — transport MITM the config pins cannot reach", () => {
  it(
    "CX-72: `core.gitProxy` is not pinned — a git:// remote MITMs ls-remote, fetch and the push itself through a session binary; the trailer commit ships to the impostor remote outside the scan range, pushed:true, zero diagnostics",
    { timeout: 120_000 },
    async () => {
      const { repo, origin, parent } = await initRepoWithOrigin(dirs, { prefix: "cx5-gitproxy-" });
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      await cleanCommit(repo, "clean.txt");
      // The impostor "remote": a real bare repo whose develop sits exactly at
      // the trailer commit so the scan range starts after it.
      const fake = path.join(parent, "fake.git");
      gitIn(parent, ["init", "--bare", "-b", "develop", "fake.git"]);
      await gitExec(repo, ["push", fake, `${tSha}:refs/heads/develop`, "main:refs/heads/main"]);
      // repo-config transport lever the evidence env cannot see: every
      // git:// op on 'origin' is exec'd through the session's proxy binary.
      const { proxy, log } = writeGitProxy(parent, fake);
      await gitExec(repo, ["config", "remote.origin.url", "git://probe.invalid/repo"]);
      await gitExec(repo, ["config", "core.gitProxy", proxy]);
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      // Closed contract: `core.gitProxy` is a transport lever `-c` never
      // reaches, so the evidence preflight refuses the channel outright —
      // the digest names it (FLOW-PUSH-13) instead of trusting a proxied
      // ls-remote answer.
      expect
        .soft(
          digest.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-13"),
          `core.gitProxy is not refused — the evidence channel would exec the session's transport lever ` +
            `(fetched=${digest.fetched}, diagnostics=${JSON.stringify(digest.diagnostics.map((d) => d.ruleId))})`,
        )
        .toBe(true);
      expect
        .soft(
          digest.develop.remote,
          "the 'verified' remote tip is whatever the session proxy advertised — not the real origin",
        )
        .not.toBe(tSha);
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      // corroboration — the impostor remote received the trailer commit; the
      // real origin never saw it.
      if (data.pushed) {
        expect.soft(gitIn(fake, ["log", "--format=%B", "-1", tSha])).toContain("X-Verifier-Report");
        expect.soft(gitIn(origin, ["rev-list", "develop"]).includes(tSha)).toBe(false);
        expect
          .soft(readFileSync(log, "utf8"), "the session proxy binary was never exec'd")
          .toContain("receive-pack");
      }
      expect(
        pushed08(data),
        `pushFlow shipped through a MITM transport — the judged remote was the session's proxy ` +
          `(pushed=${data.pushed}, diagnostics=${JSON.stringify(data.diagnostics.map((d) => d.ruleId))})`,
      ).toBe(true);
      expect
        .soft(
          data.diagnostics.length,
          "the whole MITM push produced no diagnostic — remote identity is 'proven' by a consistent-but-attacker-chosen URL",
        )
        .not.toBe(0);
    },
  );

  it(
    "CX-73: a second `remote.origin.pushurl` is invisible to `remote get-url --push` — parity compares pushurl[0]==fetchUrl while `git push` delivers to ALL pushurls; the trailer commit lands on the REAL origin unflagged",
    { timeout: 120_000 },
    async () => {
      const { repo, origin, parent } = await initRepoWithOrigin(dirs, { prefix: "cx5-pushurl-" });
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      await cleanCommit(repo, "clean.txt");
      // fetch source: a session repo whose develop sits at the trailer commit.
      const fake = path.join(parent, "fake.git");
      gitIn(parent, ["init", "--bare", "-b", "develop", "fake.git"]);
      await gitExec(repo, ["push", fake, `${tSha}:refs/heads/develop`, "main:refs/heads/main"]);
      await gitExec(repo, ["remote", "set-url", "origin", fake]);
      // push destinations: fake first (what parity sees), real origin second
      // (what `git push` also hits — get-url --push only reports the first).
      await gitExec(repo, ["config", "--add", "remote.origin.pushurl", fake]);
      await gitExec(repo, ["config", "--add", "remote.origin.pushurl", origin]);
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      // Closed contract: the full pushurl SET is compared (`--push --all`),
      // and remote.origin.url is anchored on the committed
      // push.expectedRemote — either check names the repoint/split as an
      // error diagnostic and the push refuses.
      expect
        .soft(
          digest.diagnostics.some((d) => d.severity === "error"),
          `the pushurl split / remote repoint produced no error diagnostic ` +
            `(diagnostics=${JSON.stringify(digest.diagnostics.map((d) => d.ruleId))})`,
        )
        .toBe(true);
      expect
        .soft(
          digest.develop.remote !== tSha ||
            digest.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-14"),
          "the judged remote tip is the session pushurl's without an anchor diagnostic",
        )
        .toBe(true);
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      // the decisive corroboration — the verifier-trailer commit is now ON
      // the real origin, having never passed FLOW-PUSH-08:
      expect(
        gitIn(origin, ["rev-list", "develop"]).includes(tSha) === false,
        `the trailer commit reached the real origin through the uninspected pushurl — ` +
          `remote develop contains ${tSha.slice(0, 12)}`,
      ).toBe(true);
      expect(
        pushed08(data),
        `pushFlow shipped the trailer commit to a pushurl the identity check never compared ` +
          `(pushed=${data.pushed}, diagnostics=${JSON.stringify(data.diagnostics.map((d) => d.ruleId))})`,
      ).toBe(true);
    },
  );

  it(
    "CX-76: `remote.origin.proxy` + URL-scoped `http.<url>.*` — the generic `-c http.proxy=`/`http.sslVerify=` pins cannot cover remote- or URL-scoped twins; ls-remote answers come from a session MITM server",
    { timeout: 120_000 },
    async () => {
      const { repo, parent } = await initRepoWithOrigin(dirs, { prefix: "cx5-httpproxy-" });
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      const mainTip = gitIn(repo, ["rev-parse", "main"]).trim();
      // A fake smart-http server on loopback — it advertises whatever refs the
      // session wants the evidence channel to believe the remote has.
      const py = path.join(parent, "fakehttp.py");
      const port = 28100 + Math.floor(Math.random() * 2000);
      writeFileSync(
        py,
        `import http.server, sys
TSHA, MSHA, PORT = sys.argv[1], sys.argv[2], int(sys.argv[3])
caps = "multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done object-format=sha1"
def pkt(s): return ("%04x" % (len(s) + 4)).encode() + s.encode()
ADV = (b"001e# service=git-upload-pack\\n0000"
       + pkt(TSHA + " HEAD\\0" + caps + "\\n")
       + pkt(TSHA + " refs/heads/develop\\n")
       + pkt(MSHA + " refs/heads/main\\n") + b"0000")
class H(http.server.BaseHTTPRequestHandler):
  def do_GET(self):
    self.send_response(200)
    self.send_header("Content-Type", "application/x-git-upload-pack-advertisement")
    self.send_header("Content-Length", str(len(ADV)))
    self.end_headers()
    self.wfile.write(ADV)
  def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", PORT), H).serve_forever()
`,
      );
      const server = spawn("python3", [py, tSha, mainTip, String(port)], { stdio: "ignore" });
      spawned.push(server);
      await new Promise((r) => setTimeout(r, 800));
      await gitExec(repo, ["config", "remote.origin.url", "http://probe.invalid/repo"]);
      await gitExec(repo, ["config", "remote.origin.proxy", `http://127.0.0.1:${port}`]);
      const ls = await gitEvidence(repo, ["ls-remote", "origin", "refs/heads/develop"]);
      expect
        .soft(
          ls.stdout.includes(tSha) === false,
          `ls-remote on the trusted channel returned the session MITM's advertisement ` +
            `(exit=${ls.exitCode}, stdout=${ls.stdout.slice(0, 80)})`,
        )
        .toBe(true);
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      expect(
        digest.develop.remote !== tSha ||
          digest.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-09"),
        `the digest accepted the MITM's fabricated remote tip ` +
          `(remote=${digest.develop.remote}, diagnostics=${JSON.stringify(digest.diagnostics.map((d) => d.ruleId))})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// B. repo-config programs executing on admitted "read" argv
// ===========================================================================

describe("RFC-1616 r5 — repo-config program exec on the evidence channel", () => {
  it(
    "CX-74: the evidence allowlist mirrors READ_ONLY_GIT_QUERIES — a table whose contract TRUSTS repo config — so core.hooksPath / diff.*.textconv / filter.*.smudge execute a session binary inside trusted reads",
    { timeout: 120_000 },
    async () => {
      const { repo, parent } = await initRepoWithOrigin(dirs, { prefix: "cx5-cfgexec-" });
      const fired: string[] = [];
      // (a) core.hooksPath — the pinned fetch argv runs repo hooks; a
      // reference-transaction hook fires on every tracking-ref update.
      const hookMarker = path.join(parent, "hook.marker");
      const hooks = path.join(parent, "hooks");
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        path.join(hooks, "reference-transaction"),
        `#!/bin/sh\necho "HOOK-FIRED $1" >> ${JSON.stringify(hookMarker)}\n`,
      );
      chmodSync(path.join(hooks, "reference-transaction"), 0o755);
      await gitExec(repo, ["config", "core.hooksPath", hooks]);
      // force one tracking-ref update so the hook must fire — but the
      // session-channel delete itself fires the repo hook first, so the
      // marker is cleared before judging the EVIDENCE fetch alone.
      await gitExec(repo, ["update-ref", "-d", "refs/remotes/origin/main"]);
      if (existsSync(hookMarker)) rmSync(hookMarker);
      const fetch = await gitEvidence(repo, [
        "fetch",
        "--prune",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      // CX-132: fetch is refused at the argv layer — the hook lever is
      // unreachable because no transport op runs at all.
      expect(fetch.exitCode).not.toBe(0);
      if (existsSync(hookMarker)) fired.push("core.hooksPath reference-transaction");
      // (b) diff.*.textconv — a repo-config program rewriting patch bytes the
      // parser judges. `.git/info/attributes` is itself a shape violation
      // (CX-125): built-in `working-tree-encoding`/`text`/`ident` conversions
      // rewrite what `status`/`diff` hash, and no env or `-c` key disables
      // that file — the channel refuses before any diff runs.
      const tconvMarker = path.join(parent, "tconv.marker");
      const tconv = path.join(parent, "tconv.sh");
      writeFileSync(
        tconv,
        `#!/bin/sh\necho TEXTCONV >> ${JSON.stringify(tconvMarker)}\necho FORGED-PATCH-BYTES\n`,
      );
      chmodSync(tconv, 0o755);
      await gitExec(repo, ["config", "diff.pwn.textconv", tconv]);
      mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
      writeFileSync(path.join(repo, ".git", "info", "attributes"), "*.txt diff=pwn\n");
      const logp = await gitEvidence(repo, ["log", "-p", "-1", "--", "seed.txt"]);
      expect
        .soft(
          logp.exitCode === 0 || logp.stderr.startsWith("EVIDENCE-REFUSED"),
          `fixture: log -p neither answered nor refused (exit=${logp.exitCode})`,
        )
        .toBe(true);
      expect(
        logp.stdout,
        "the textconv program's output reached the trusted channel",
      ).not.toContain("FORGED-PATCH-BYTES");
      if (existsSync(tconvMarker) || logp.stdout.includes("FORGED-PATCH-BYTES"))
        fired.push("diff.pwn.textconv");
      // (c) filter.*.smudge — admitted `cat-file --filters` runs it and
      // returns attacker output as the blob's content.
      const smudgeMarker = path.join(parent, "smudge.marker");
      const smudge = path.join(parent, "smudge.sh");
      writeFileSync(
        smudge,
        `#!/bin/sh\necho SMUDGE >> ${JSON.stringify(smudgeMarker)}\necho FORGED-BLOB-CONTENT\n`,
      );
      chmodSync(smudge, 0o755);
      await gitExec(repo, ["config", "filter.pwn.smudge", smudge]);
      writeFileSync(path.join(repo, ".git", "info", "attributes"), "*.txt filter=pwn\n");
      const blob = await gitEvidence(repo, ["cat-file", "--filters", "HEAD:seed.txt"]);
      if (existsSync(smudgeMarker) || blob.stdout.includes("FORGED-BLOB-CONTENT"))
        fired.push("filter.pwn.smudge");
      expect(
        fired,
        `repo-config programs executed inside the trusted evidence channel: ${fired.join(", ")} — ` +
          "EVIDENCE_CONFIG_PINS pins none of hooksPath/diff.*.textconv/filter.*.smudge",
      ).toEqual([]);
    },
  );

  it(
    "CX-75: `['diff','--no-index',a,b]` is allowlisted at both levels — a trusted read that diff's arbitrary OPERATOR files (e.g. /etc/passwd, /proc/*/environ) into evidence stdout; nothing in the predicate limits diff to repo paths",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx5-noidx-" });
      const argv = ["diff", "--no-index", "/etc/passwd", "/dev/null"];
      expect
        .soft(
          isEvidenceGitQuery(argv),
          "the runtime evidence predicate admits diff --no-index — an arbitrary file read " +
            "on the trusted channel (and the identical shared table exempts it statically)",
        )
        .toBe(false);
      const r = await gitEvidence(repo, argv);
      expect(
        r.stdout.includes("root:") === false,
        `gitEvidence diff --no-index leaked /etc/passwd bytes into trusted stdout ` +
          `(exit=${r.exitCode}, ${r.stdout.length}B)`,
      ).toBe(true);
    },
  );

  it(
    "CX-81: the `fetch` admission covers arbitrary refspecs — `gitEvidence fetch origin '+src:refs/heads/<branch>'` rewrites a LOCAL integration branch on the read-only-plus-pinned-fetch channel; only 'not the checked-out branch' limits the write",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx5-fetchrw-" });
      // diverge remote develop from local main so the rewrite is observable:
      await cleanCommit(repo, "diverge.txt");
      await gitExec(repo, ["push", "origin", "develop"]);
      const argv = ["fetch", "origin", "+refs/heads/develop:refs/heads/main"];
      expect
        .soft(
          isEvidenceGitQuery(argv),
          "the evidence predicate admits a fetch refspec that force-updates refs/heads/main — " +
            "the 'one mutating op' exception is effectively arbitrary ref mutation",
        )
        .toBe(false);
      const before = gitIn(repo, ["rev-parse", "main"]).trim();
      const dev = gitIn(repo, ["rev-parse", "develop"]).trim();
      await gitEvidence(repo, argv);
      const after = gitIn(repo, ["rev-parse", "main"]).trim();
      expect(
        after === before && after !== dev,
        `the trusted fetch rewrote refs/heads/main ${before.slice(0, 9)} -> ${after.slice(0, 9)}`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// C. session-writable history topology the env scrub does not cover
// ===========================================================================

describe("RFC-1616 r5 — .git/info/grafts on the trusted channel", () => {
  it(
    "CX-79: .git/info/grafts rewrites commit parents for every git traversal — GIT_NO_REPLACE_OBJECTS does NOT gate it — so rev-list hides a mid-chain trailer commit and merge-base fabricates ancestry on the 'raw objects' channel",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx5-graft-" });
      const remoteTip = gitIn(repo, ["rev-parse", "refs/remotes/origin/develop"]).trim();
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      const cSha = await cleanCommit(repo, "clean.txt");
      // graft cSha's parent directly onto the pre-trail base — tSha drops out
      // of the develop walk even under the scrubbed evidence env.
      writeFileSync(path.join(repo, ".git", "info", "grafts"), `${cSha} ${remoteTip}\n`);
      const list = await gitEvidence(repo, ["rev-list", `${remoteTip}..develop`]);
      // Closed contract: a non-empty .git/info/grafts is a shape file no env
      // or config switch disables — the evidence channel refuses the read
      // outright rather than answering on rewritten topology.
      expect
        .soft(
          list.exitCode !== 0 || list.stdout.includes(tSha),
          "grafted parents hid the trailer commit from rev-list on the trusted channel — " +
            `the read must refuse or still see the trailer (exit=${list.exitCode}, stdout=${JSON.stringify(list.stdout)})`,
        )
        .toBe(true);
      // fabricated ancestry: graft a foreign root commit INTO develop's
      // ancestry — merge-base --is-ancestor (the FLOW-PUSH-03 check) lies.
      const tree = gitIn(repo, ["rev-parse", "HEAD^{tree}"]).trim();
      const foreign = gitIn(repo, ["commit-tree", tree, "-m", "foreign root"]).trim();
      writeFileSync(path.join(repo, ".git", "info", "grafts"), `${cSha} ${tSha} ${foreign}\n`);
      const anc = await gitEvidence(repo, ["merge-base", "--is-ancestor", foreign, "develop"]);
      expect(
        anc.exitCode !== 0,
        "a grafted parent made an unrelated commit report as an ancestor of develop — " +
          "the FLOW-PUSH-03 ancestry check trusts session-rewritable topology",
      ).toBe(true);
    },
  );
});

// ===========================================================================
// D. remote identity is consistency, never provenance
// ===========================================================================

describe("RFC-1616 r5 — remote identity is never anchored", () => {
  it(
    "CX-80: a wholesale `remote.origin.url` repoint passes every parity check — configured==fetchUrl==pushUrl — so flow.push reports pushed:true to a session-chosen remote with zero diagnostics and the real origin untouched",
    { timeout: 120_000 },
    async () => {
      const { repo, origin, parent } = await initRepoWithOrigin(dirs, { prefix: "cx5-repoint-" });
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      await cleanCommit(repo, "clean.txt");
      const fake = path.join(parent, "fake.git");
      gitIn(parent, ["init", "--bare", "-b", "develop", "fake.git"]);
      await gitExec(repo, ["push", fake, `${tSha}:refs/heads/develop`, "main:refs/heads/main"]);
      await gitExec(repo, ["remote", "set-url", "origin", fake]);
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect
        .soft(
          data.diagnostics.some((d) => d.severity === "error"),
          "a repointed remote produced no error diagnostic — the parity check proves " +
            "consistency (judged == pushed remote), never provenance (the operator's remote)",
        )
        .toBe(true);
      expect.soft(gitIn(origin, ["rev-list", "develop"]).includes(tSha)).toBe(false);
      expect(
        pushed08(data),
        `pushFlow shipped to a repointed remote with no trailer flag ` +
          `(pushed=${data.pushed}, diagnostics=${JSON.stringify(data.diagnostics.map((d) => d.ruleId))})`,
      ).toBe(true);
    },
  );

  it(
    "CX-82: --dry-run computes the verifier-trailer scan on session-planted refs/remotes/origin/* (collectDigest fetch:false has no verified tips) and returns verifierTrailerCommits:[] with no diagnostic — a false-clean preview",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx5-dryrun-" });
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      await cleanCommit(repo, "clean.txt");
      // plant the tracking ref AT the trailer commit — the dry-run scan range
      // then starts after it.
      await gitExec(repo, ["update-ref", "refs/remotes/origin/develop", tSha]);
      const digest = await collectDigest(repo, ambientIo, { fetch: false });
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: true });
      const flagged = (data.verifierTrailerCommits ?? []).some((h) => h.sha === tSha);
      expect(
        flagged || data.diagnostics.length > 0,
        `dry-run reported verifierTrailerCommits=${JSON.stringify(data.verifierTrailerCommits)} ` +
          `with diagnostics=${JSON.stringify(data.diagnostics.map((d) => d.ruleId))} — a clean ` +
          "scan verdict computed on refs the code itself calls a display-only preview",
      ).toBe(true);
    },
  );
});

// ===========================================================================
// E. adoption verdicts — CI structure the detector cannot see
// ===========================================================================

describe("RFC-1616 r5 — scaffold adoption of dead enforcement", () => {
  it(
    "CX-77: a run: block is judged per-line — `exit 0` on the first line / `set +e` + trailing `true` / `if false; then … fi` all leave the gate lines matching while the steps can never fail — adopted",
    { timeout: 60_000 },
    () => {
      const wf = (steps: string) =>
        `name: forge-policy
on: [push, pull_request]
jobs:
  policy-surface:
    runs-on: ubuntu-latest
    steps:
${steps}`;
      const deadFirst = wf(`      - run: |
          exit 0
          forge correctness.gate --policy-only --base HEAD~1
      - run: |
          exit 0
          forge policy.digest --verify
      - run: |
          exit 0
          forge pinned.validate --mode ci
`);
      const setE = wf(`      - run: |
          set +e
          forge correctness.gate --policy-only --base HEAD~1
          true
      - run: |
          set +e
          forge policy.digest --verify
          true
      - run: |
          set +e
          forge pinned.validate --mode ci
          true
`);
      const ifWrap = wf(`      - run: |
          if false; then
            forge correctness.gate --policy-only --base HEAD~1
            forge policy.digest --verify
            forge pinned.validate --mode ci
          fi
`);
      for (const [name, body] of [
        ["exit-0 dead code", deadFirst],
        ["set +e + true", setE],
        ["if-false wrap", ifWrap],
      ] as const) {
        expect(
          adoptedWorkflow(body),
          `the scaffold adopted a workflow whose gate lines are dead shell code (${name}) — ` +
            "the run: matcher checks each line in isolation and cannot see script structure",
        ).toBe(false);
      }
    },
  );

  it(
    "CX-78: `continue-on-error` is judged only as literal `true` — `${{ always() }}` / `'true'` still count as enforcing steps; and `on.push.types` (an invalid push subkey — GitHub rejects the workflow) still counts as a firing push trigger",
    { timeout: 60_000 },
    () => {
      const wf = (extra: string, steps: string) =>
        `name: forge-policy
on:
  push:
${extra}  pull_request:
jobs:
  policy-surface:
    runs-on: ubuntu-latest
    steps:
${steps}`;
      const coeExpr = wf(
        "",
        `      - continue-on-error: \${{ always() }}
        run: forge correctness.gate --policy-only --base HEAD~1
      - continue-on-error: \${{ always() }}
        run: forge policy.digest --verify
      - continue-on-error: \${{ always() }}
        run: forge pinned.validate --mode ci
`,
      );
      const coeStr = wf(
        "",
        `      - continue-on-error: 'true'
        run: forge correctness.gate --policy-only --base HEAD~1
      - continue-on-error: 'true'
        run: forge policy.digest --verify
      - continue-on-error: 'true'
        run: forge pinned.validate --mode ci
`,
      );
      const pushTypes = wf("    types: [created]\n", WORKFLOW_STEPS);
      for (const [name, body] of [
        ["continue-on-error ${{ always() }}", coeExpr],
        ["continue-on-error 'true'", coeStr],
        ["on.push.types (invalid subkey)", pushTypes],
      ] as const) {
        expect(
          adoptedWorkflow(body),
          `the scaffold adopted a workflow that cannot enforce (${name})`,
        ).toBe(false);
      }
    },
  );

  it(
    "CX-83: scaffoldTrustBoundary follows symlinks — a `.github/workflows/forge-policy.yml` symlinked to an operator file outside the workspace is CLOBBERED by the template and then reported adopted forever after",
    { timeout: 60_000 },
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "cx5-scaffold-link-"));
      dirs.push(root);
      const outside = path.join(root, "outside", "operator-policy.yml");
      mkdirSync(path.dirname(outside), { recursive: true });
      writeFileSync(outside, "# operator-owned file — must not be rewritten\n");
      const rel = ".github/workflows/forge-policy.yml";
      const dest = path.join(root, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      symlinkSync(outside, dest);
      const out = scaffoldTrustBoundary(root, "@operator");
      // Closed contract: the scaffold never follows a boundary-path symlink —
      // it unlinks the escape, reports the conflict, and lets the NEXT pass
      // install the real file. The path must never read as adopted in the
      // meantime.
      expect
        .soft(
          !existsSync(dest) || !lstatSync(dest).isSymbolicLink(),
          "the scaffold wrote the template THROUGH a session symlink — the boundary path " +
            "must be rejected or replaced, never followed outside the workspace",
        )
        .toBe(true);
      expect
        .soft(
          out.conflicts.some((c) => c.includes(rel)),
          "the removed symlinked artifact surfaced as a scaffold conflict, not silent adoption",
        )
        .toBe(true);
      expect
        .soft(
          readFileSync(outside, "utf8"),
          "the scaffold clobbered a file outside the workspace through the symlink",
        )
        .toBe("# operator-owned file — must not be rewritten\n");
      // second pass: the symlinked artifact is now reported as adopted —
      // `existsSync` + `readFileSync` still follow it.
      const again = scaffoldTrustBoundary(root, "@operator");
      expect(
        again.skipped.some((s) => s.includes(rel)) === false,
        "a symlinked boundary artifact reports '(already exists)' adoption",
      ).toBe(true);
    },
  );
});

// ===========================================================================
// F. env-filter gaps on caller-supplied env
// ===========================================================================

describe("RFC-1616 r5 — caller-supplied env levers", () => {
  it(
    "CX-84: filterEvidenceExtraEnv drops only the ORACLE_DROP_RE list — PATH (the lever verifierPath exists to replace) and proxy/CA redirect vars ride back into the trusted child; verifierSpawnEnv merges extraEnv with no filter at all",
    { timeout: 60_000 },
    () => {
      const filtered = filterEvidenceExtraEnv({
        PATH: "/tmp/evil-bin",
        http_proxy: "http://evil.invalid:3128",
        https_proxy: "http://evil.invalid:3128",
        SSL_CERT_FILE: "/tmp/evil-ca.pem",
        NODE_EXTRA_CA_CERTS: "/tmp/evil-ca.pem",
      });
      const leaked = Object.keys(filtered).sort();
      expect(
        leaked,
        `redirect levers survive filterEvidenceExtraEnv into the trusted subprocess: ${leaked.join(",")}`,
      ).toEqual([]);
      const spawnedEnv = verifierSpawnEnv({
        LD_PRELOAD: "/tmp/evil.so",
        NODE_OPTIONS: "--require /tmp/evil.js",
        PATH: "/tmp/evil-bin",
      });
      const preloadLeaks = ["LD_PRELOAD", "NODE_OPTIONS"].filter(
        (k) => spawnedEnv[k] !== undefined,
      );
      expect(
        preloadLeaks,
        `preload levers reach verifierSpawn children unfiltered: ${preloadLeaks.join(",")}`,
      ).toEqual([]);
      expect(
        spawnedEnv["PATH"],
        "verifierSpawnEnv lets caller env replace the rebuilt verifier PATH",
      ).not.toBe("/tmp/evil-bin");
    },
  );
});

// ===========================================================================
// G. hold probes — representative r4 fixes still closed
// ===========================================================================

describe("RFC-1616 r5 — closed-surface re-verification", () => {
  it(
    "R5-R1: CX-61 stays dead — a remote.origin.fetch refspec rewrite plus a planted tracking ref cannot pose as the remote: ls-remote-verified tips drive the scan and FLOW-PUSH-08 fires",
    { timeout: 120_000 },
    async () => {
      const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "cx5-hold-refspec-" });
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      await cleanCommit(repo, "clean.txt");
      await gitExec(repo, ["update-ref", "refs/remotes/origin/develop", tSha]);
      await gitExec(repo, [
        "config",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/decoy/*",
      ]);
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      // CX-94 (r7): the non-default remote.origin.fetch now refuses the
      // whole evidence channel — stronger than the decoy-only guard.
      expect(digest.fetched).toBe(false);
      expect(digest.digestId.startsWith("refused-")).toBe(true);
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(data.pushed).toBe(false);
      expect(data.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-13")).toBe(true);
      expect(gitIn(origin, ["rev-list", "develop"]).includes(tSha)).toBe(false);
    },
  );

  const PRELOAD_LEVERS = [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "DYLD_INSERT_LIBRARIES",
    "BASH_ENV",
    "ENV",
    "CDPATH",
    "IFS",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "RUBYLIB",
    "PERL5LIB",
    "PERL5OPT",
    "NODE_OPTIONS",
    "NODE_PATH",
    "GCONV_PATH",
    "LOCALDOMAIN",
  ];

  it(
    "R5-R2: CX-71 stays dead — a compiled LD_PRELOAD .so cannot fabricate a gitEvidence answer, and no preload/redirect lever survives verifierGitEnv's allowlist",
    { timeout: 120_000 },
    async () => {
      const cc = ["/usr/bin/cc", "/usr/bin/gcc"].find((b) => existsSync(b));
      if (cc !== undefined) {
        const dir = mkdtempSync(path.join(os.tmpdir(), "cx5-ld-"));
        dirs.push(dir);
        const src = path.join(dir, "pwn.c");
        const so = path.join(dir, "pwn.so");
        writeFileSync(
          src,
          `#include <unistd.h>
#include <stdlib.h>
#include <string.h>
__attribute__((constructor)) static void pwn(void) {
  const char *m = getenv("CX5_FORGE_ME");
  if (m != NULL) { (void)!write(1, m, strlen(m)); _exit(0); }
}
`,
        );
        execFileSync(cc, ["-shared", "-fPIC", "-o", so, src]);
        const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx5-ldrepo-" });
        const realHead = gitIn(repo, ["rev-parse", "HEAD"]).trim();
        const savedLd = process.env["LD_PRELOAD"];
        const savedPayload = process.env["CX5_FORGE_ME"];
        process.env["LD_PRELOAD"] = so;
        process.env["CX5_FORGE_ME"] = `${"0".repeat(39)}1\n`;
        try {
          const r = await gitEvidence(repo, ["rev-parse", "HEAD"]);
          expect(r.stdout.trim(), "LD_PRELOAD reached the trusted evidence child").toBe(realHead);
        } finally {
          if (savedLd === undefined) delete process.env["LD_PRELOAD"];
          else process.env["LD_PRELOAD"] = savedLd;
          if (savedPayload === undefined) delete process.env["CX5_FORGE_ME"];
          else process.env["CX5_FORGE_ME"] = savedPayload;
        }
      }
      const saved: Record<string, string | undefined> = {};
      for (const k of PRELOAD_LEVERS) {
        saved[k] = process.env[k];
        process.env[k] = "/tmp/cx5-lever";
      }
      let surviving: string[];
      try {
        const env = verifierGitEnv();
        surviving = PRELOAD_LEVERS.filter((k) => env[k] !== undefined);
      } finally {
        for (const k of PRELOAD_LEVERS) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      }
      expect(
        surviving,
        `session preload/redirect variables survive verifierGitEnv into the trusted git channel: ${surviving.join(",")}`,
      ).toEqual([]);
    },
  );

  it(
    "R5-R3: CX-64/65 stays dead — repo-config core.commentChar/trailer.separators cannot blind %(trailers): the evidence channel pins both, and FLOW-PUSH-08 still fires on a trailer commit",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx5-hold-trailers-" });
      await gitExec(repo, ["config", "core.commentChar", "X"]);
      await gitExec(repo, ["config", "trailer.separators", "="]);
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      const trailers = await gitEvidence(repo, ["log", "-1", "--format=%(trailers:only)", tSha]);
      expect(trailers.stdout).toContain("X-Verifier-Report");
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(pushed08(data)).toBe(true);
    },
  );

  it(
    "R5-R4: CX-70 stays dead — `gitEvidence(root, ['log', ...flags])` fails the static scan's allowlist AND the runtime predicate refuses ['log','--ext-diff'] argv",
    { timeout: 60_000 },
    async () => {
      const createSourceScanner = await loadSourceScanner();
      if (createSourceScanner !== undefined) {
        const FIXTURE_GIT_TS = `import { execFile } from "node:child_process";
export async function gitEvidence(root: string, args: string[]): Promise<string> {
  execFile("git", ["-C", root, ...args], () => {});
  return "";
}
`;
        const scan = (handler: string): boolean | undefined => {
          const root = mkdtempSync(path.join(os.tmpdir(), "cx5-scan-"));
          dirs.push(root);
          const put = (rel: string, body: string) => {
            const p = path.join(root, rel);
            mkdirSync(path.dirname(p), { recursive: true });
            writeFileSync(p, body);
            return p;
          };
          put("forge/os/flow/git.ts", FIXTURE_GIT_TS);
          const file = put("src/commands/ge.ts", handler);
          const scanner = createSourceScanner(root);
          const slices = scanner.handlerSlices(file, "ge.read");
          return slices.find((s) => s.file.endsWith("git.ts"))?.allowlistedGitEntry;
        };
        const dynTail = scan(`import { gitEvidence } from "../../forge/os/flow/git.ts";
export const cmd = {
  name: "ge.read",
  mutatesState: false,
  execute: async (input: any, ctx: any) => {
    const flags = ["--ext-diff"];
    await gitEvidence(ctx.workspaceRoot, ["log", ...flags]);
  },
};
`);
        expect(dynTail, "dynamic-tail gitEvidence argv must not be allowlisted").toBe(false);
      }
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx5-extdiff-" });
      const r = await gitEvidence(repo, ["log", "--ext-diff"]);
      expect(r.exitCode !== 0, "['log','--ext-diff'] reached the trusted subprocess").toBe(true);
    },
  );

  it(
    "R5-R5: adoption control — the real template workflow is adopted, and a `|| true` tail still refuses (the CX-66 line-level check works on same-line or-tails)",
    { timeout: 60_000 },
    () => {
      const { root, rel } = plantWorkflow(FORGE_POLICY_WORKFLOW);
      const out = scaffoldTrustBoundary(root, "@operator");
      expect(out.skipped.some((s) => s.includes(rel))).toBe(true);
      const toothless = `name: forge-policy
on: [push, pull_request]
jobs:
  policy-surface:
    runs-on: ubuntu-latest
    steps:
      - run: forge correctness.gate --policy-only --base HEAD~1 || true
      - run: forge policy.digest --verify || true
      - run: forge pinned.validate --mode ci || true
`;
      expect(adoptedWorkflow(toothless), "a || true workflow must not be adopted").toBe(false);
    },
  );
});
