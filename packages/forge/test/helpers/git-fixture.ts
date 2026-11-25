/* Shared git fixture for integration-queue tests — a real repo with controllable history. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export interface FixtureRepo {
  dir: string;
  commitFile(path: string, content: string, message: string): string;
  head(): string;
}

export function createFixtureRepo(dir: string): FixtureRepo {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "develop"], dir);
  git(["config", "user.name", "Fixture"], dir);
  git(["config", "user.email", "fixture@test"], dir);
  git(["config", "commit.gpgsign", "false"], dir);

  const repo: FixtureRepo = {
    dir,
    commitFile(path, content, message) {
      writeFileSync(join(dir, path), content);
      git(["add", path], dir);
      git(["commit", "-q", "-m", message], dir);
      return git(["rev-parse", "HEAD"], dir).trim();
    },
    head() {
      return git(["rev-parse", "HEAD"], dir).trim();
    },
  };
  repo.commitFile("seed.txt", "seed\n", "seed commit");
  return repo;
}

/** Build a commit chain diverging from the repo's current head — simulating session work. */
export function buildSessionChain(
  repo: FixtureRepo,
  files: Array<[string, string]>,
): { chain: string[]; tip: string; treeDigest: string } {
  git(["checkout", "-q", "-b", `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`], repo.dir);
  const chain: string[] = [];
  for (const [path, content] of files) {
    chain.push(repo.commitFile(path, content, `session work: ${path}`));
  }
  const tip = repo.head();
  const treeDigest = git(["rev-parse", "HEAD^{tree}"], repo.dir).trim();
  git(["checkout", "-q", "develop"], repo.dir);
  return { chain, tip, treeDigest };
}
