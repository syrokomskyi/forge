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


/** Scoped WorkspaceIOPort factory — one implementation behind every filesystem-shaped
   port (workspace, primaryState, future state spaces). `root` is the sandbox root;
   `grant()` reports the effective grant per call so capability changes evaluate fresh;
   `onDeny` raises the capability violation with the caller's capability dimension. */
function makeScopedPort(
  root: string,
  grant: () => string,
  onDeny: (capability: string, detail: string) => never,
  capability: string,
) {
  const scopedTo = (p: string): string => {
    const resolved = pathResolve(root, p);
    if (!resolved.startsWith(pathResolve(root))) {
      onDeny(capability, `path escape outside ${capability} root: ${p}`);
    }
    return resolved;
  };
  return {
    async readFile(p: string) {
      if (grant() === "none") onDeny(capability, `readFile with ${capability}:none`);
      return readFile(scopedTo(p), "utf8");
    },
    async writeFile(p: string, content: string) {
      if (grant() !== "readwrite") onDeny(capability, `writeFile with ${capability}:${grant()}`);
      const target = scopedTo(p);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    async writeFileBytes(p: string, content: Uint8Array) {
      if (grant() !== "readwrite") onDeny(capability, `writeFileBytes with ${capability}:${grant()}`);
      const target = scopedTo(p);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    async exists(p: string) {
      if (grant() === "none") return false;
      try {
        await access(scopedTo(p));
        return true;
      } catch {
        return false;
      }
    },
    async list(dir: string) {
      if (grant() === "none") onDeny(capability, `list with ${capability}:none`);
      return readdir(scopedTo(dir));
    },
    async readlink(p: string) {
      if (grant() === "none") onDeny(capability, `readlink with ${capability}:none`);
      return readlink(scopedTo(p));
    },
    async symlink(target: string, linkPath: string) {
      if (grant() !== "readwrite") onDeny(capability, `symlink with ${capability}:${grant()}`);
      await symlink(target, scopedTo(linkPath));
    },
    async unlink(p: string) {
      if (grant() !== "readwrite") onDeny(capability, `unlink with ${capability}:${grant()}`);
      await unlink(scopedTo(p));
    },
    async readFileBytes(p: string) {
      if (grant() === "none") onDeny(capability, `readFileBytes with ${capability}:none`);
      return new Uint8Array(await readFile(scopedTo(p)));
    },
    async rename(from: string, to: string) {
      if (grant() !== "readwrite") onDeny(capability, `rename with ${capability}:${grant()}`);
      await rename(scopedTo(from), scopedTo(to));
    },
    async rm(p: string, opts?: { recursive?: boolean }) {
      if (grant() !== "readwrite") onDeny(capability, `rm with ${capability}:${grant()}`);
      await rm(scopedTo(p), { recursive: opts?.recursive ?? false, force: true });
    },
    async stat(p: string) {
      if (grant() === "none") onDeny(capability, `stat with ${capability}:none`);
      const st = await stat(scopedTo(p));
      return { size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() };
    },
    async readdir(p: string) {
      if (grant() === "none") onDeny(capability, `readdir with ${capability}:none`);
      const entries = await readdir(scopedTo(p), { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }));
    },
    async mkdir(p: string) {
      if (grant() !== "readwrite") onDeny(capability, `mkdir with ${capability}:${grant()}`);
      await mkdir(scopedTo(p), { recursive: true });
    },
  };
}


/** Deferred-root space port — state spaces whose root resolves per call (the gitdir
   pointer can change across the process lifetime in theory, and context construction
   is synchronous). Each method resolves the root fresh and delegates to the shared
   scoped implementation. A null root (no git state) degrades reads to absent-shape
   and refuses writes with a plain error — never a capability violation, since the
   cause is topology, not grants. */
function makeDeferredSpacePort(
  capability: string,
  grant: () => string,
  onDeny: (capability: string, detail: string) => never,
  resolveRoot: () => Promise<string | null>,
) {
  const space = async () => {
    const root = await resolveRoot();
    if (root === null) return null;
    return makeScopedPort(root, grant, onDeny, capability);
  };
  const unreachable = (): never => {
    throw new Error(`${capability} unreachable: no git state resolvable from workspace`);
  };
  return {
    async readFile(p: string) {
      const s = await space();
      if (!s) throw new Error(`${capability} unreadable: no git state resolvable from workspace`);
      return s.readFile(p);
    },
    async writeFile(p: string, content: string) {
      const s = await space();
      if (!s) unreachable();
      return s!.writeFile(p, content);
    },
    async writeFileBytes(p: string, content: Uint8Array) {
      const s = await space();
      if (!s) unreachable();
      return s!.writeFileBytes(p, content);
    },
    async exists(p: string) {
      const s = await space();
      if (!s) return false;
      return s.exists(p);
    },
    async list(dir: string) {
      const s = await space();
      if (!s) throw new Error(`${capability} unreadable: no git state resolvable from workspace`);
      return s.list(dir);
    },
    async readlink(p: string) {
      const s = await space();
      if (!s) throw new Error(`${capability} unreadable: no git state resolvable from workspace`);
      return s.readlink(p);
    },
    async symlink(target: string, linkPath: string) {
      const s = await space();
      if (!s) unreachable();
      return s!.symlink(target, linkPath);
    },
    async unlink(p: string) {
      const s = await space();
      if (!s) unreachable();
      return s!.unlink(p);
    },
    async readFileBytes(p: string) {
      const s = await space();
      if (!s) throw new Error(`${capability} unreadable: no git state resolvable from workspace`);
      return s.readFileBytes(p);
    },
    async rename(from: string, to: string) {
      const s = await space();
      if (!s) unreachable();
      return s!.rename(from, to);
    },
    async rm(p: string, opts?: { recursive?: boolean }) {
      const s = await space();
      if (!s) unreachable();
      return s!.rm(p, opts);
    },
    async stat(p: string) {
      const s = await space();
      if (!s) throw new Error(`${capability} unreadable: no git state resolvable from workspace`);
      return s.stat(p);
    },
    async readdir(p: string) {
      const s = await space();
      if (!s) throw new Error(`${capability} unreadable: no git state resolvable from workspace`);
      return s.readdir(p);
    },
    async mkdir(p: string) {
      const s = await space();
      if (!s) unreachable();
      return s!.mkdir(p);
    },
  };
}

/** Build a capability-enforcing PluginContext for one activated plugin. */
export function createPluginContext(manifest: PluginManifest, host: ContextHostServices): PluginContext {
  const caps = manifest.capabilities ?? {};
  const pid = manifest.id;
  const fsGrant = caps.filesystem ?? "none";

  const deny = (capability: string, detail: string): never => {
    throw new CapabilityViolation(capability, pid, detail);
  };

  return {
    workspace: makeScopedPort(host.workspaceRoot, () => fsGrant, deny, "filesystem"),
    primaryState: makeDeferredSpacePort(
      "primaryState",
      () => caps.primaryState ?? "none",
      deny,
      async () => {
        const common = await resolveGitCommonDir(host.workspaceRoot);
        if (!common) return null;
        // common is <primary>/.git — the space root is the primary checkout itself,
        // mirroring resolveWorkshopPaths primaryRoot semantics one-to-one.
        return dirname(common);
      },
    ),
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
        const grant = caps.processSpawn;
        if (!grant) deny("processSpawn", `spawn refused: ${cmd}`);
        if (Array.isArray(grant)) {
          const base = cmd.split("/").pop() ?? cmd;
          if (!(grant.includes(cmd) || grant.includes(base))) {
            deny("processSpawn", `binary not in manifest allowlist: ${cmd}`);
          }
        }
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
