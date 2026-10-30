/*
<MODULE_CONTRACT>
<purpose>
RFC-1453: executes `page` acceptance probes against the served output of a
named `target`. A session groups probes by target, runs the project's
`outcomeBuild` binding once per target, starts `outcomeServe` once per
target, fetches each probe path, and evaluates status + selector +
textPattern against the served HTML. A probe that cannot run reports
`unverified` — never `pass` without having executed.
</purpose>
<non-goals>
  <item>Do not name consumer commands — projects bind outcomeBuild/outcomeServe in forge.yaml; forge stays project-agnostic.</item>
  <item>Do not run browser checks (console errors, layout) — Forge evaluates static HTML only (RFC-1453 nonGoal).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1453: outcome session — per-target build+serve, tri-state page verdicts, process-tree teardown.</item>
  <item>RFC-1453: executed outcome probes, IMP-14 surface gate, outcome.serve + V-47/V-48</item>
</CHANGE_SUMMARY>
*/

import { spawn } from "node:child_process";
import { parseHTML } from "linkedom";
import { loadForgeConfig } from "../../src/config/forge-config.ts";
import type { AcceptanceProbe, ProbeResult } from "./types.ts";

type PageProbe = Extract<AcceptanceProbe, { probe: "page" }>;

const BUILD_TIMEOUT_MS = 15 * 60_000;
const SERVE_HANDSHAKE_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL_CHARS = 2000;

interface ServeHandle {
  url: string;
  child: ReturnType<typeof spawn>;
}

interface TargetState {
  /** Set after the first attempt — build+serve are shared across probes of the same target. */
  outcome: { kind: "ready"; serve: ServeHandle } | { kind: "unverified"; detail: string };
}

export interface OutcomeSession {
  runPageProbe(probe: PageProbe): Promise<ProbeResult>;
  dispose(): Promise<void>;
}

function tailOf(text: string): string {
  const t = text.trim();
  return t.length > OUTPUT_TAIL_CHARS ? `…${t.slice(-OUTPUT_TAIL_CHARS)}` : t;
}

/** Substitutes the {target} placeholder in a binding command line. */
export function substituteTarget(command: string, target: string): string {
  return command.replaceAll("{target}", target);
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      output += d.toString();
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      resolve({ exitCode: null, timedOut: true, output });
    }, timeoutMs);
    timer.unref?.();
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut: false, output });
    };
    child.on("close", finish);
    child.on("error", () => finish(null));
  });
}

/**
 * Spawns the serve binding and resolves on the first stdout line that parses
 * as {"url": string, "pid": number}. `detached` creates a process group on
 * posix so the whole tree can be killed later; on Windows the tree is killed
 * via taskkill /T.
 */
function startServe(command: string, cwd: string): Promise<{ serve?: ServeHandle; detail?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      resolve({ detail: `outcomeServe printed no {"url","pid"} JSON line within ${SERVE_HANDSHAKE_TIMEOUT_MS}ms` });
    }, SERVE_HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
    const fail = (detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(child);
      resolve({ detail });
    };
    child.stdout?.on("data", (d: Buffer) => {
      if (settled) return;
      buffer += d.toString();
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // not the handshake line — keep reading
        }
        const rec = parsed as Record<string, unknown>;
        if (typeof rec?.["url"] !== "string" || typeof rec?.["pid"] !== "number") continue;
        settled = true;
        clearTimeout(timer);
        resolve({ serve: { url: rec["url"], child } });
        return;
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      fail(`outcomeServe exited before printing the JSON line (code ${code})`);
    });
    child.on("error", (err) => {
      if (settled) return;
      fail(`outcomeServe failed to start: ${String(err)}`);
    });
  });
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else if (child.pid !== undefined) {
      // Negative pid kills the detached process group.
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

function evaluateHtml(html: string, probe: PageProbe): { verdict: "pass" | "fail"; detail: string } {
  const { document } = parseHTML(html);
  if (!probe.selector) {
    if (!probe.textPattern) {
      return { verdict: "pass", detail: "fetched with expected status (no selector/textPattern)" };
    }
    const re = new RegExp(probe.textPattern, "m");
    const ok = re.test(document.body?.textContent ?? "");
    return { verdict: ok ? "pass" : "fail", detail: `textPattern ${ok ? "matched" : "did not match"} body text` };
  }
  const matches = document.querySelectorAll(probe.selector);
  if (matches.length === 0) {
    return { verdict: "fail", detail: `selector "${probe.selector}" matched 0 elements` };
  }
  if (!probe.textPattern) {
    return { verdict: "pass", detail: `selector "${probe.selector}" matched ${matches.length} element(s)` };
  }
  const re = new RegExp(probe.textPattern, "m");
  const hit = Array.from(matches).some((el: Element) => re.test(el.textContent ?? ""));
  return {
    verdict: hit ? "pass" : "fail",
    detail: hit
      ? `selector matched ${matches.length} element(s); textPattern matched`
      : `selector matched ${matches.length} element(s); textPattern did not match`,
  };
}

/**
 * Creates a per-invocation outcome session. The caller MUST `dispose()` it in
 * a `finally` so served process trees are stopped.
 */
export function createOutcomeSession(opts: {
  workspaceRoot: string;
  forgeRoot?: string;
}): OutcomeSession {
  const { workspaceRoot, forgeRoot } = opts;
  const states = new Map<string, TargetState>();
  const serves: ServeHandle[] = [];
  let bindings: { outcomeBuild: string | null; outcomeServe: string | null } | null = null;
  let bindingsError: string | null = null;

  function loadBindings(): { outcomeBuild: string | null; outcomeServe: string | null } | string {
    if (bindingsError) return bindingsError;
    if (!bindings) {
      try {
        const config = loadForgeConfig(workspaceRoot, forgeRoot);
        bindings = {
          outcomeBuild: config.bindings?.commands.outcomeBuild ?? null,
          outcomeServe: config.bindings?.commands.outcomeServe ?? null,
        };
      } catch (err) {
        bindingsError = `forge.yaml could not be loaded: ${String(err)}`;
        return bindingsError;
      }
    }
    return bindings;
  }

  async function prepareTarget(target: string): Promise<TargetState> {
    const cached = states.get(target);
    if (cached) return cached;

    const bound = loadBindings();
    let state: TargetState;
    if (typeof bound === "string") {
      state = { outcome: { kind: "unverified", detail: bound } };
    } else if (!bound.outcomeBuild || !bound.outcomeServe) {
      state = {
        outcome: {
          kind: "unverified",
          detail: "no outcomeBuild/outcomeServe binding in forge.yaml",
        },
      };
    } else {
      const build = await runShell(substituteTarget(bound.outcomeBuild, target), workspaceRoot, BUILD_TIMEOUT_MS);
      if (build.timedOut) {
        state = {
          outcome: {
            kind: "unverified",
            detail: `outcomeBuild timed out after ${BUILD_TIMEOUT_MS}ms — ${tailOf(build.output)}`,
          },
        };
      } else if (build.exitCode !== 0) {
        state = {
          outcome: {
            kind: "unverified",
            detail: `outcomeBuild exited ${build.exitCode} — ${tailOf(build.output)}`,
          },
        };
      } else {
        const started = await startServe(substituteTarget(bound.outcomeServe, target), workspaceRoot);
        if (started.serve) {
          serves.push(started.serve);
          state = { outcome: { kind: "ready", serve: started.serve } };
        } else {
          state = { outcome: { kind: "unverified", detail: started.detail ?? "outcomeServe failed" } };
        }
      }
    }
    states.set(target, state);
    return state;
  }

  return {
    async runPageProbe(probe: PageProbe): Promise<ProbeResult> {
      if (!probe.target) {
        return {
          probe,
          ok: false,
          verdict: "unverified",
          detail: 'page probe has no "target" (V-47) — cannot select a build/serve binding',
        };
      }
      const state = await prepareTarget(probe.target);
      if (state.outcome.kind === "unverified") {
        return { probe, ok: false, verdict: "unverified", detail: state.outcome.detail };
      }
      const url = `${state.outcome.serve.url}${probe.path}`;
      let response: Response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      } catch (err) {
        return {
          probe,
          ok: false,
          verdict: "unverified",
          detail: `fetch ${url} failed: ${String(err)}`,
        };
      }
      const expectedStatus = probe.expectStatus ?? 200;
      if (response.status !== expectedStatus) {
        return {
          probe,
          ok: false,
          verdict: "fail",
          detail: `status ${response.status} (expected ${expectedStatus})`,
        };
      }
      const html = await response.text();
      const evaluated = evaluateHtml(html, probe);
      return {
        probe,
        ok: evaluated.verdict === "pass",
        verdict: evaluated.verdict,
        detail: `${url} → ${evaluated.detail}`,
      };
    },

    async dispose(): Promise<void> {
      for (const serve of serves) {
        killProcessTree(serve.child);
      }
      serves.length = 0;
      states.clear();
    },
  };
}
