/*
<MODULE_CONTRACT>
<purpose>RFC-1580: run one oracle through the frozen `checkRun` binding —
the template is split into an argv vector and `{file}` becomes exactly one
argument (DNA-89, no shell), `FORGE_CORRECTNESS_DIR` points at a fresh
per-oracle directory, and a timeout kills the run (RFC-1576 timeout class).</purpose>
<non-goals>
  <item>No retry, no output parsing — the exit code and the attestation files are the evidence.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: initial runner.</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
</CHANGE_SUMMARY>
*/

import { spawn } from "node:child_process";

import { gitEnvForCwd } from "../../rfc/verification-origin.ts";

export interface OracleRun {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** RFC-1576 failure class. */
  failureClass: "none" | "exit" | "timeout" | "spawn";
  outputTail: string;
}

export function checkRunArgv(template: string, file: string): string[] {
  const tokens = template
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  return tokens.map((t) => t.split("{file}").join(file));
}

export function runOracle(opts: {
  cwd: string;
  template: string;
  file: string;
  runDir: string;
  timeoutMs: number;
}): Promise<OracleRun> {
  const argv = checkRunArgv(opts.template, opts.file);
  const command = argv.join(" ");
  const started = Date.now();
  return new Promise((resolve) => {
    if (argv.length === 0) {
      resolve({
        command,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        failureClass: "spawn",
        outputTail: "empty checkRun",
      });
      return;
    }
    let tail = "";
    let settled = false;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      env: { ...gitEnvForCwd(), FORGE_CORRECTNESS_DIR: opts.runDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        command,
        exitCode: null,
        timedOut: true,
        durationMs: Date.now() - started,
        failureClass: "timeout",
        outputTail: tail,
      });
    }, opts.timeoutMs);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - started,
        failureClass: "spawn",
        outputTail: err.message,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        exitCode: code,
        timedOut: false,
        durationMs: Date.now() - started,
        failureClass: code === 0 ? "none" : "exit",
        outputTail: tail,
      });
    });
  });
}
