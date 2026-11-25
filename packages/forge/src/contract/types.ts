/*
<MODULE_CONTRACT>
<purpose>
Contract-evidence graph schema types (Werkstatt RFC-1646) — the atom of protection,
the closed input vocabulary, verdicts, immutable evidence records, and the frozen
change unit. Schema-only: no evaluation or storage logic lives here.
</purpose>
<non-goals>
  <item>Not the scheduler, not the executor runtime — those consume these types.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1646 (WP-3): initial schema contracts.</item>
</CHANGE_SUMMARY>
*/

/** The atom of protection. Nodes form a DAG via declared dependsOn edges. */
export interface ContractNode {
  /** Stable namespaced id, e.g. "forge.rfc.validate.V-25"; plugin nodes are prefixed by plugin id. */
  id: string;
  kind: "validator" | "oracle" | "auditor" | "invariant";
  /** Plugin id or "core". */
  owner: string;
  inputs: InputDecl[];
  substrate: "static" | "execution" | "review" | "external";
  severity: "blocking" | "advisory";
  /** SDK-registered executor reference. */
  executorRef: string;
  /** Semver — part of the evidence key. */
  executorVersion: string;
  /** Node ids; DAG enforced at load. */
  dependsOn: string[];
  cachePolicy: "content-addressed" | "uncacheable";
  /** Human/agent-facing explanation template. */
  description: string;
}

/** Closed input vocabulary — anything outside it cannot be declared. */
export type InputDecl =
  | { kind: "file-glob"; pattern: string }
  | { kind: "file-content"; path: string }
  | { kind: "git-ref"; ref: string }
  | { kind: "node-verdict"; nodeId: string }
  | { kind: "command-output"; command: string; args: string[] }
  | { kind: "environment"; keys: string[] };

export const INPUT_KINDS = [
  "file-glob",
  "file-content",
  "git-ref",
  "node-verdict",
  "command-output",
  "environment",
] as const;

export interface InputFingerprint {
  nodeId: string;
  /** sha256 over canonical input serialization. */
  digest: string;
  /** Per-input digests — explainability. Keyed by input index. */
  inputs: Record<string, string>;
  /** Evidence metadata, not part of digest. */
  computedAt: string;
}

export interface Violation {
  ruleId: string;
  message: string;
  severity: "blocking" | "advisory";
  file?: string;
  line?: number;
}

export type Verdict =
  | { status: "pass" }
  | { status: "fail"; violations: Violation[] }
  | { status: "uncacheable-pass" }
  | { status: "error"; message: string };

/** Immutable, content-addressed evidence. Written once, never migrated. */
export interface EvidenceRecord {
  schema: "forge:evidence/v1";
  /** sha256(nodeId + inputDigest + executorVersion) */
  key: string;
  nodeId: string;
  inputFingerprint: InputFingerprint;
  verdict: Verdict;
  executorVersion: string;
  startedAt: string;
  durationMs: number;
  /** The frozen unit under evaluation. */
  changeUnitId: string;
  /** Content-addressed blobs (logs, reports). */
  artifactRefs: string[];
}

/**
 * The unit of evaluation — frozen at creation, immutable thereafter.
 * `frozenRefs` holds the resolved values of every git-ref input the graph
 * declares, captured at unit creation: nodes never read live mutable git
 * state, so the frozen values are the only legal resolution source.
 */
export interface ChangeUnit {
  id: string;
  /** sha256 of the frozen tree object. */
  treeDigest: string;
  /** Integration target ref at creation. */
  baseRef: string;
  createdAt: string;
  frozenRefs: Record<string, string>;
  metadata: Record<string, string>;
}

/** Typed configuration error for fail-closed registration refusal. */
export interface RegistrationError {
  ruleId:
    | "CG-REG-01" // unknown input kind
    | "CG-REG-02" // dependsOn cycle
    | "CG-REG-03" // missing executor
    | "CG-REG-04" // namespace violation
    | "CG-REG-05" // undeclared/unknown dependency
    | "CG-REG-06" // duplicate node id
    | "CG-REG-07"; // banned command-output input
  message: string;
  nodeId?: string;
}
