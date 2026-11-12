/*
<MODULE_CONTRACT>
<purpose>RFC-1579 CORR-AUDIT-04 `bindings.verify.substance` — the verify
slot must prove more than tests or types. Error when
`bindings.commands.verify` is null, equals the `test` or `typecheck`
binding, or consists only of `test`, `typecheck`, `build:check`, `tsc`, or
`vitest` invocations. A configuration auditor: never differential, blocking
whenever present. `correctness.mode: exempt` skips it.</purpose>
<non-goals>
  <item>Do not run the verify command — the audit is static.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial auditor.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
</CHANGE_SUMMARY>
*/

import { parse as parseYaml } from "yaml";

import type { AuditorOutput } from "./types.ts";

const TRIVIAL = new Set(["test", "typecheck", "build:check", "tsc", "vitest"]);
const RUNNERS = new Set([
  "pnpm",
  "npm",
  "yarn",
  "bun",
  "npx",
  "bunx",
  "turbo",
  "exec",
  "run",
  "dlx",
]);
/** Runner flags that take a value (`--filter <pkg>`, `-F <pkg>`, `-C <dir>`). */
const VALUE_FLAGS = new Set(["--filter", "-F", "-C", "--dir", "--workspace", "--cwd"]);

function normalize(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim();
}

/** The script or binary a single shell segment invokes, after runner words and flags. */
export function invokedTarget(segment: string): string | null {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[A-Z_][A-Z0-9_]*=/.test(t)) {
      i += 1; // env assignment
      continue;
    }
    if (RUNNERS.has(t)) {
      i += 1;
      continue;
    }
    if (t.startsWith("-")) {
      i += VALUE_FLAGS.has(t) && !t.includes("=") ? 2 : 1;
      continue;
    }
    return t;
  }
  return null;
}

/** True when every segment of the command only runs tests or type checks. */
export function isTrivialVerify(cmd: string): boolean {
  const segments = cmd
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return true;
  return segments.every((seg) => {
    const target = invokedTarget(seg);
    return target === null || TRIVIAL.has(target);
  });
}

export function auditVerifySubstance(
  forgeYaml: string | undefined,
  exempt: boolean,
): AuditorOutput {
  if (exempt)
    return { findings: [], unverifiable: 0, skipped: ["bindings.verify.substance: exempt"] };
  let commands: Record<string, unknown> = {};
  try {
    const doc = (forgeYaml ? parseYaml(forgeYaml) : {}) as {
      bindings?: { commands?: Record<string, unknown> };
    };
    commands = doc?.bindings?.commands ?? {};
  } catch {
    commands = {};
  }
  const verify =
    typeof commands["verify"] === "string" ? normalize(commands["verify"] as string) : null;
  const test = typeof commands["test"] === "string" ? normalize(commands["test"] as string) : null;
  const typecheck =
    typeof commands["typecheck"] === "string" ? normalize(commands["typecheck"] as string) : null;
  let reason: string | null = null;
  if (!verify) reason = "bindings.commands.verify is null — the verify slot proves nothing";
  else if (verify === test)
    reason = `bindings.commands.verify equals bindings.commands.test ("${verify}")`;
  else if (verify === typecheck)
    reason = `bindings.commands.verify equals bindings.commands.typecheck ("${verify}")`;
  else if (isTrivialVerify(verify)) {
    reason = `bindings.commands.verify ("${verify}") only runs test/typecheck/build:check/tsc/vitest`;
  }
  if (!reason) return { findings: [], unverifiable: 0, skipped: [] };
  return {
    findings: [
      {
        check: "bindings.verify.substance",
        subject: "bindings.commands.verify",
        severity: "error",
        message: `${reason} — bind a command that checks domain behaviour on a real substrate`,
        location: { file: "forge.yaml", line: 1 },
      },
    ],
    unverifiable: 0,
    skipped: [],
  };
}
