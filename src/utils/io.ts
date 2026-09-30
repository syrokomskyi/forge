/*
<MODULE_CONTRACT>
<purpose>
RFC-1152 (Wave 2a): the standalone-CLI ambient WorkspaceIO adapter. Forge
helpers take an optional `io?: WorkspaceIO` — when absent, `resolveIo` returns
this ambient adapter so the standalone `forge` CLI keeps working without a
kernel context. Kernel callers (`forge/os` handlers) pass `context.io` through.
</purpose>
<non-goals>
  <item>Do not record WriteIntents — forge CLI has no execution-report surface.</item>
  <item>Do not enforce sync parity — WorkspaceIO is async-only; sync helpers stay ambient.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>createDefaultIO is deliberately unused — forge keeps a minimal ambient adapter for the standalone CLI.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1152 Wave 2a: initial ambient adapter for forge standalone CLI.</item>
</CHANGE_SUMMARY>
*/

import {
  readFile as fsReadFile,
  mkdir as fsMkdir,
  rm as fsRm,
  readdir as fsReaddir,
  stat as fsStat,
  rename as fsRename,
  appendFile as fsAppendFile,
  copyFile as fsCopyFile,
  mkdtemp as fsMkdtemp,
  realpath as fsRealpath,
  glob as fsGlob,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { ExecOptions, ExecResult, WorkspaceIO } from "../types.ts";
import { writeFileAtomic } from "./fs-atomic.ts";

async function execImpl(command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          child.kill();
        }, opts.timeoutMs)
      : undefined;
    timer?.unref?.();
    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * The ambient adapter — real fs, no intent recording. Used by forge helpers
 * when no `io` is injected (standalone `forge` CLI path).
 */
export const ambientIo: WorkspaceIO = {
  async readFile(path) {
    return fsReadFile(path, "utf8");
  },
  async readFileBytes(path) {
    return fsReadFile(path);
  },
  async exists(path) {
    try {
      await fsStat(path);
      return true;
    } catch {
      return false;
    }
  },
  async glob(pattern, opts) {
    const results: string[] = [];
    for await (const entry of fsGlob(pattern, { cwd: opts?.cwd })) {
      results.push(entry);
    }
    return results;
  },
  async readdir(path) {
    const entries = await fsReaddir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }));
  },
  async stat(path) {
    const s = await fsStat(path);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs, size: s.size };
  },
  async realpath(path) {
    return fsRealpath(path);
  },
  async writeFile(path, content) {
    await fsMkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, content);
  },
  async appendFile(path, content) {
    await fsMkdir(dirname(path), { recursive: true });
    await fsAppendFile(path, content);
  },
  async mkdir(path) {
    await fsMkdir(path, { recursive: true });
  },
  async rm(path, opts) {
    await fsRm(path, { recursive: opts?.recursive ?? true, force: true });
  },
  async rename(src, dst) {
    await fsMkdir(dirname(dst), { recursive: true });
    await fsRename(src, dst);
  },
  async copyFile(src, dst) {
    await fsMkdir(dirname(dst), { recursive: true });
    await fsCopyFile(src, dst);
  },
  async mkdtemp(prefix) {
    return fsMkdtemp(prefix);
  },
  exec: execImpl,
};

/** Resolve the effective io for a helper: injected port or ambient default. */
export function resolveIo(io?: WorkspaceIO): WorkspaceIO {
  return io ?? ambientIo;
}
