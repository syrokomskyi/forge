/*
<MODULE_CONTRACT>
<purpose>
PluginContext factory (Werkstatt RFC-1648) — every port enforces the manifest's
capability declarations at runtime. Omitted capabilities are default-deny: a
manifest without a capability block receives no filesystem write, no network, no
spawn, no git mutation. This is auditability, not a sandbox.
</purpose>
<non-goals><item>No static circumvention scan — that lives in the contract node.</item></non-goals>
<CHANGE_SUMMARY><item>RFC-1648 (WP-5): initial capability-enforcing context.</item></CHANGE_SUMMARY>
*/

import { access, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, resolve as pathResolve } from "node:path";
import { promisify } from "node:util";

import { CapabilityViolation, type PluginContext, type PluginManifest } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface ContextHostServices {
  /** Repo/workspace root the plugin is scoped to. */
  workspaceRoot: string;
  bindings?: Record<string, unknown>;
  hooks?: {
    evidenceConsult?: PluginContext["evidence"]["consult"];
    registerNode?: PluginContext["contracts"]["registerNode"];
  };
}

/* Dual-use commands (tag/branch/config) are conservative-denied: listing refs
   belongs to for-each-ref plumbing, config reads to file parsing. A security
   boundary refuses false negatives at the cost of false-positive friction. */
const MUTATING_GIT_OPS = new Set(["commit", "push", "update-ref", "checkout", "reset", "rebase", "merge", "cherry-pick", "apply", "commit-tree", "tag", "branch", "am", "stash", "rm", "mv", "clean", "gc", "fetch", "pull", "clone", "init", "add", "notes", "replace", "filter-branch", "update-index", "write-tree", "symbolic-ref", "worktree", "reflog", "config"]);

/* Git global flags consuming a separate value token — the subcommand is the first
   positional after these are skipped. `--flag=value` forms self-skip. */
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"]);

export function gitSubcommand(args: string[]): string | undefined {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (GIT_VALUE_FLAGS.has(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith("-")) {
      i += 1;
      continue;
    }
    return a;
  }
  return undefined;
}

/* Resolve the git COMMON dir without spawning git: in a primary checkout .git is the
   dir itself; in a worktree it is a pointer file (`gitdir: <common>/worktrees/<name>`)
   and the common dir is two levels up. Returns null when no git state exists. */
export async function resolveGitCommonDir(workspaceRoot: string): Promise<string | null> {
  const dotGit = pathResolve(workspaceRoot, ".git");
  try {
    const st = await lstat(dotGit);
    if (st.isDirectory()) return dotGit;
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  try {
    const content = await readFile(dotGit, "utf8");
    const m = content.match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    const gitdirPath = pathResolve(workspaceRoot, m[1].trim());
    // <common>/worktrees/<name> — strip the two trailing segments.
    const parts = gitdirPath.split("/").filter((p) => p.length > 0);
    if (parts.length < 3) return null;
    return "/" + parts.slice(0, -2).join("/");
  } catch {
    return null;
  }
}

/** Build a capability-enforcing PluginContext for one activated plugin. */
export function createPluginContext(manifest: PluginManifest, host: ContextHostServices): PluginContext {
  const caps = manifest.capabilities ?? {};
  const pid = manifest.id;
  const fsGrant = caps.filesystem ?? "none";

  const deny = (capability: string, detail: string): never => {
    throw new CapabilityViolation(capability, pid, detail);
  };

  const scoped = (path: string): string => {
    const resolved = pathResolve(host.workspaceRoot, path);
    if (!resolved.startsWith(pathResolve(host.workspaceRoot))) {
      deny("filesystem", `path escape outside workspace root: ${path}`);
    }
    return resolved;
  };

  return {
    workspace: {
      async readFile(path) {
        if (fsGrant === "none") deny("filesystem", "readFile with filesystem:none");
        return readFile(scoped(path), "utf8");
      },
      async writeFile(path, content) {
        if (fsGrant !== "readwrite") deny("filesystem", `writeFile with filesystem:${fsGrant}`);
        const target = scoped(path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      },
      async exists(path) {
        if (fsGrant === "none") return false;
        try {
          await access(scoped(path));
          return true;
        } catch {
          return false;
        }
      },
      async list(dir) {
        if (fsGrant === "none") deny("filesystem", "list with filesystem:none");
        return readdir(scoped(dir));
      },
      async readlink(path) {
        if (fsGrant === "none") deny("filesystem", "readlink with filesystem:none");
        return readlink(scoped(path));
      },
      async symlink(target, linkPath) {
        if (fsGrant !== "readwrite") deny("filesystem", `symlink with filesystem:${fsGrant}`);
        // The link PATH is sandboxed; the link TARGET is not re-validated — scoped()
        // is a textual check, so a link pointing outside the root escapes on follow.
        // readwrite is a trusted-within-workspace grant (it can already overwrite
        // forge.yaml and hooks); symlink creation is consistent with that trust level.
        // Plugins needing strict containment must not receive readwrite.
        await symlink(target, scoped(linkPath));
      },
      async unlink(path) {
        if (fsGrant !== "readwrite") deny("filesystem", `unlink with filesystem:${fsGrant}`);
        await unlink(scoped(path));
      },
      async readFileBytes(path) {
        if (fsGrant === "none") deny("filesystem", "readFileBytes with filesystem:none");
        return new Uint8Array(await readFile(scoped(path)));
      },
      async rename(from, to) {
        if (fsGrant !== "readwrite") deny("filesystem", `rename with filesystem:${fsGrant}`);
        await rename(scoped(from), scoped(to));
      },
      async rm(path, opts) {
        if (fsGrant !== "readwrite") deny("filesystem", `rm with filesystem:${fsGrant}`);
        await rm(scoped(path), { recursive: opts?.recursive ?? false, force: true });
      },
      async stat(path) {
        if (fsGrant === "none") deny("filesystem", "stat with filesystem:none");
        const st = await stat(scoped(path));
        return { size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() };
      },
    },
    evidence: {
      consult: host.hooks?.evidenceConsult ?? (async () => ({ hit: false })),
    },
    contracts: {
      registerNode: host.hooks?.registerNode ?? (() => ({ ok: false as const, errors: ["contract registration unavailable in this host"] })),
    },
    bindings: {
      get<T>(key: string): T | undefined {
        return host.bindings?.[key] as T | undefined;
      },
      require<T>(key: string): T {
        const v = host.bindings?.[key];
        if (v === undefined) throw new Error(`required binding missing: ${key}`);
        return v as T;
      },
    },
    git: {
      async exec(args) {
        // Redirection flags escape the workspace scope for reads AND writes — refused outright.
        for (const a of args) {
          if (a === "-C" || a === "--git-dir" || a === "--work-tree" || a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) {
            deny("filesystem", `git scope redirection refused: ${a}`);
          }
        }
        if (!caps.gitMutation) {
          const subcommand = gitSubcommand(args);
          if (subcommand && MUTATING_GIT_OPS.has(subcommand)) {
            deny("gitMutation", `mutating git op refused: git ${subcommand}`);
          }
        }
        const { stdout } = await execFileAsync("git", args, { cwd: host.workspaceRoot });
        return stdout;
      },
    },
    process: {
      async spawn(cmd, args, opts) {
        if (!caps.processSpawn) deny("processSpawn", `spawn refused: ${cmd}`);
        const timeoutMs = opts?.timeoutMs ?? 120_000; // mandatory timeouts — hanging commands die as executor error
        try {
          const { stdout, stderr } = await execFileAsync(cmd, args, {
            cwd: opts?.cwd ?? host.workspaceRoot,
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
          });
          return { stdout, stderr, exitCode: 0 };
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; code?: number };
          return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: typeof e.code === "number" ? e.code : 1 };
        }
      },
    },
    network: {
      async fetch(url, init) {
        if (!caps.network) deny("network", `fetch refused: ${url}`);
        const res = await fetch(url, init);
        return { status: res.status, body: await res.text() };
      },
    },
    forgeState: {
      journal: {
        async tail(count) {
          if ((caps.forgeState ?? "none") === "none") deny("forgeState", "journal.tail with forgeState:none");
          const common = await resolveGitCommonDir(host.workspaceRoot);
          if (!common) return [];
          const journalPath = pathResolve(common, "forge", "journal.jsonl");
          let text: string;
          try {
            text = await readFile(journalPath, "utf8");
          } catch {
            return [];
          }
          const lines = text.split("\n").filter((l) => l.trim().length > 0);
          const records = [];
          for (const line of lines.slice(-count)) {
            try {
              records.push(JSON.parse(line));
            } catch {
              records.push({ event: "torn-line" });
            }
          }
          return records;
        },
        async size() {
          if ((caps.forgeState ?? "none") === "none") deny("forgeState", "journal.size with forgeState:none");
          const common = await resolveGitCommonDir(host.workspaceRoot);
          if (!common) return 0;
          try {
            const text = await readFile(pathResolve(common, "forge", "journal.jsonl"), "utf8");
            return text.split("\n").filter((l) => l.trim().length > 0).length;
          } catch {
            return 0;
          }
        },
      },
    },
    env: {
      get(key) {
        if (!(caps.envKeys ?? []).includes(key)) {
          deny("env", `env key not declared in manifest envKeys: ${key}`);
        }
        return process.env[key];
      },
      declared(key) {
        return (caps.envKeys ?? []).includes(key);
      },
    },
    log: {
      info: (msg) => console.log(`[${pid}] ${msg}`),
      warn: (msg) => console.warn(`[${pid}] ${msg}`),
      error: (msg) => console.error(`[${pid}] ${msg}`),
    },
    paths: {
      resolve: (...parts) => pathResolve(host.workspaceRoot, ...parts),
      root: () => host.workspaceRoot,
    },
  };
}
