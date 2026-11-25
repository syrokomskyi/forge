/*
<MODULE_CONTRACT>
<purpose>F-0394: flow.push's verifier-trailer scan reads the whole local
branch in batched judged consults instead of two judged consults per
commit — and the batch never narrows the scan: a framing it cannot prove
(\x1e inside a subject or trailer value) falls back to the exact
per-commit reads, and a planted tracking ref still cannot hide a trailer
commit (CX-82).</purpose>
<non-goals>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectDigest } from "../digest.ts";
import { consultProbe } from "../git.ts";
import { batchedCommitReads, pushFlow } from "../handlers/flow-push.ts";
import { gitExec, initRepoWithOrigin } from "./helpers.ts";

const dirs: string[] = [];
afterEach(async () => {
  consultProbe.current = null;
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function commit(repo: string, file: string, message: string): Promise<string> {
  await writeFile(join(repo, file), `${file}\n`);
  await gitExec(repo, ["add", file]);
  const r = await gitExec(repo, ["commit", "-qm", message]);
  if (r.exitCode !== 0) throw new Error(`commit failed: ${r.stderr}`);
  return (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

async function revList(repo: string, range: string): Promise<string[]> {
  return (await gitExec(repo, ["rev-list", range])).stdout.split("\n").filter(Boolean);
}

describe("flow.push batched verifier-trailer scan (F-0394)", () => {
  it("batched reads are byte-identical to the per-commit reads, merges included", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "flow-push-vb-" });
    await commit(repo, "a.txt", "plain work");
    await commit(repo, "b.txt", "session work\n\nX-Verifier-Report: r.yaml\nX-RFC: RFC-1");
    await commit(repo, "c.txt", "X-Policy-Digest: subject-shaped");
    await gitExec(repo, ["checkout", "-q", "-b", "side", "HEAD~2"]);
    await commit(repo, "d.txt", "side work\n\nX-Expectation-Origin: independent-verifier");
    await gitExec(repo, ["checkout", "-q", "main"]);
    const m = await gitExec(repo, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    expect(m.exitCode).toBe(0);
    const shas = await revList(repo, "main");
    const batched = await batchedCommitReads(repo, "main", shas);
    expect(batched).not.toBeNull();
    expect(batched!.size).toBe(shas.length);
    for (const sha of shas) {
      const trailers = await gitExec(repo, [
        "log",
        "-1",
        "--format=%(trailers:only,separator=%x00)%x00%e",
        sha,
      ]);
      const subject = await gitExec(repo, ["log", "-1", "--format=%s", sha]);
      expect(batched!.get(sha)!.trailers).toBe(trailers.stdout);
      expect(batched!.get(sha)!.subject).toBe(subject.stdout);
    }
  }, 60_000);

  it.each([
    ["a \\x1e inside the subject", "work\x1e0000000000000000000000000000000000000000"],
    ["a \\x1e inside a trailer value", "work\n\nX-Note: a\x1eb"],
  ])(
    "refuses the batch on %s (CX-33 framing) instead of trusting it",
    async (_label, message) => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "flow-push-vb-" });
      await commit(repo, "a.txt", message);
      const shas = await revList(repo, "HEAD");
      expect(await batchedCommitReads(repo, "HEAD", shas)).toBeNull();
    },
    60_000,
  );

  it("a \\x1e-framed commit still refuses FLOW-PUSH-08 through the per-commit fallback", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "flow-push-vb-" });
    const sha = await commit(repo, "a.txt", "session work\x1e\n\nX-Verifier-Report: r.yaml");
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: true });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-08");
    expect(data.verifierTrailerCommits?.map((h) => h.sha)).toContain(sha);
  }, 60_000);

  it("CX-82: a tracking ref planted at the trailer commit does not hide it", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "flow-push-vb-" });
    const sha = await commit(repo, "a.txt", "session work\n\nX-Expectation-Origin: verifier");
    await commit(repo, "b.txt", "later plain work");
    // The session plants origin/* at (and past) the trailer commit — a
    // `remote..local` range would exclude it.
    await gitExec(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await gitExec(repo, ["update-ref", "refs/remotes/origin/develop", "HEAD"]);
    await gitExec(repo, ["update-ref", "refs/heads/develop", "HEAD"]);
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: true });
    expect(data.pushed).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-08");
    expect(data.verifierTrailerCommits?.map((h) => h.sha)).toContain(sha);
  }, 60_000);

  it("scans N commits without per-commit consults", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "flow-push-vb-" });
    for (let i = 0; i < 25; i++) await commit(repo, `f${i}.txt`, `plain work ${i}`);
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const perCommit: string[][] = [];
    const batched: string[][] = [];
    consultProbe.current = (argv, channel) => {
      if (channel !== "evidence" || argv[0] !== "log") return;
      if (argv[1] === "-1") perCommit.push([...argv]);
      else if (argv[1]?.startsWith("--format=%x1e%H%x00")) batched.push([...argv]);
    };
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: true });
    consultProbe.current = null;
    expect(data.diagnostics).toEqual([]);
    expect(data.verifierTrailerCommits).toEqual([]);
    expect(perCommit.filter((a) => a.some((t) => t.includes("trailers:only")))).toEqual([]);
    expect(perCommit.filter((a) => a.includes("--format=%s"))).toEqual([]);
    // Two batched reads per distinct range — develop (25 commits ahead)
    // and main (the seed) — the consult count no longer scales with N.
    expect(batched.length).toBe(4);
  }, 60_000);
});
