/*
<MODULE_CONTRACT>
<purpose>
RFC-1464: invoke adapters for the cheap execution tier — `command` spawns
argv through the injected exec port; `openai-http` declares the binding shape
and resolves env refs (transport deferred to binding operator config).
</purpose>
<non-goals>
  <item>No ambient child_process/fetch — the kernel io port is the only execution channel.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1464: command + openai-http invoke adapters (env-ref config only)</item>
  <item>RFC-1464: delegate mechanical task classes to cheap tier — agent.delegate, tiers.validate, invoke adapters</item>
  <item>RFC-1464: apply r1 repairs — envelope via DELEGATE_ENVELOPE env, real boundary diff, gate flags, DEL renumber</item>
</CHANGE_SUMMARY>
*/

export interface DelegateBinding {
  provider: string;
  model?: string;
  endpoint?: string;
  invoke:
    | { kind: "command"; argv: string[]; env?: Record<string, string> }
    | { kind: "openai-http"; model: string; endpointRef: string; keyRef: string };
}

export interface TaskEnvelope {
  class: string;
  schema: Record<string, unknown>;
  input: Record<string, unknown>;
  boundary: string[];
}

export interface InvokeResult {
  ok: boolean;
  output: string;
  error?: string;
  /** Paths the delegate reported touching (parsed from output when emitted). */
  filesModified?: string[];
}

export function loadBinding(raw: unknown, tier: string): DelegateBinding | null {
  const tiers = (raw as { agentTiers?: Record<string, unknown> } | null)?.agentTiers;
  const b = tiers?.[tier] as DelegateBinding | undefined;
  if (!b || typeof b.provider !== "string" || !b.invoke) return null;
  return b;
}

export function validateBindingShape(binding: DelegateBinding): string | null {
  const inv = binding.invoke;
  if (inv.kind === "command") {
    if (!Array.isArray(inv.argv) || inv.argv.length === 0) {
      return "invoke.argv must be a non-empty string array";
    }
    return null;
  }
  if (inv.kind === "openai-http") {
    if (!inv.model || !inv.endpointRef || !inv.keyRef) {
      return "openai-http binding requires { model, endpointRef, keyRef }";
    }
    return null;
  }
  return `unknown invoke.kind "${(inv as { kind?: string }).kind}"`;
}

export interface DelegateIo {
  exec?(
    cmd: string,
    args: string[],
    opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
}

export async function invokeCheapTier(
  binding: DelegateBinding,
  envelope: TaskEnvelope,
  io: DelegateIo,
  workspaceRoot: string,
): Promise<InvokeResult> {
  const shape = validateBindingShape(binding);
  if (shape !== null) return { ok: false, output: "", error: shape };
  if (binding.invoke.kind === "openai-http") {
    return {
      ok: false,
      output: "",
      error:
        "openai-http transport is deferred to binding operator config — declare a command adapter or wire the endpoint binding",
    };
  }
  if (typeof io.exec !== "function") {
    return { ok: false, output: "", error: "no exec port on io — command invoke requires a kernel or ambient io adapter" };
  }
  const [cmd, ...args] = binding.invoke.argv;
  try {
    // The ExecOptions port has no stdin — the task envelope travels via a
    // dedicated env var; the shim reads DELEGATE_ENVELOPE.
    const res = await io.exec(cmd!, args, {
      env: { ...(binding.invoke.env ?? {}), DELEGATE_ENVELOPE: JSON.stringify(envelope) },
      cwd: workspaceRoot,
      timeoutMs: 300_000,
    });
    let filesModified: string[] | undefined;
    try {
      const out = JSON.parse(res.stdout) as { filesModified?: unknown };
      if (Array.isArray(out.filesModified)) {
        filesModified = out.filesModified.filter((f): f is string => typeof f === "string");
      }
    } catch { /* non-JSON output is fine */ }
    return {
      ok: res.exitCode === 0,
      output: res.stdout,
      error: res.exitCode === 0 ? undefined : res.stderr || `exit ${res.exitCode}`,
      filesModified,
    };
  } catch (err) {
    return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}
