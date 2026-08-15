/*
<MODULE_CONTRACT>
<purpose>Register the program packet control plane commands with the forge
kernel registry (RFC-0856).</purpose>
<non-goals>
  <item>Do not implement command logic here — handlers live in handlers/*.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0856: initial program module registration.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export const forgeProgramModule: ForgeModule = {
  name: "forge-program",
  version: "0.1.0",

  async register(registry) {
    const { runValidate } = await import("./handlers/validate.ts");
    const { runSeal } = await import("./handlers/seal.ts");
    const { runLease } = await import("./handlers/lease.ts");
    const { runComplete } = await import("./handlers/complete.ts");

    registry.registerCommand({
      name: "program.packet.validate",
      description:
        "Validate a program packet against schema, source hashes, branch/head, " +
        "and state machine rules. Read-only. " +
        "Usage: program.packet.validate --program=RFC-XXXX --packet=NNN-foo --phase=draft --json",
      scope: "workspace",
      supportsAllSites: false,
      flags: {
        program: {
          kind: "string",
          required: true,
          description: "Program RFC id (e.g. RFC-0855).",
        },
        packet: {
          kind: "string",
          required: true,
          description: "Packet id (e.g. 010-node-24).",
        },
        phase: {
          kind: "string",
          description: "Validation phase: draft, sealed, active, or completion.",
        },
        json: {
          kind: "boolean",
          description: "Machine-readable JSON output.",
        },
      },
      reads: ["docs/plans/**/program.yaml", "docs/plans/**/*.md"],
      cacheable: false,
      execute: runValidate,
    });

    registry.registerCommand({
      name: "program.packet.seal",
      description:
        "Steward finalizes a packet against the predecessor's completion commit, " +
        "updates packet state from draft to sealed, and records the seal in the " +
        "program manifest. Does not commit — use ecosystem.commit after. " +
        "Usage: program.packet.seal --program=RFC-XXXX --packet=NNN-foo " +
        "--steward=human:id --idempotency-key=<key> --json",
      scope: "workspace",
      supportsAllSites: false,
      mutatesState: true,
      flags: {
        program: {
          kind: "string",
          required: true,
          description: "Program RFC id.",
        },
        packet: {
          kind: "string",
          required: true,
          description: "Packet id to seal.",
        },
        steward: {
          kind: "string",
          required: true,
          description: "Steward actor id (human:<id> or agent:<id>).",
        },
        "idempotency-key": {
          kind: "string",
          description: "Idempotency key for retry-safe sealing.",
        },
        json: {
          kind: "boolean",
          description: "Machine-readable JSON output.",
        },
      },
      writes: ["docs/plans/**/program.yaml", "docs/plans/**/*.md"],
      reads: ["docs/plans/**/program.yaml", "docs/plans/**/*.md"],
      cacheable: false,
      execute: runSeal,
    });

    registry.registerCommand({
      name: "program.packet.lease",
      description:
        "Manage the exclusive local executor lease for a sealed packet. " +
        "Actions: start, heartbeat, release, recover. " +
        "Raw lease tokens are never persisted — only the SHA-256 hash. " +
        "Usage: program.packet.lease --program=RFC-XXXX --packet=NNN-foo " +
        "--action=start --executor=agent:id --json",
      scope: "workspace",
      supportsAllSites: false,
      flags: {
        program: {
          kind: "string",
          required: true,
          description: "Program RFC id.",
        },
        packet: {
          kind: "string",
          required: true,
          description: "Packet id.",
        },
        action: {
          kind: "string",
          required: true,
          description: "Lease action: start, heartbeat, release, or recover.",
        },
        executor: {
          kind: "string",
          description: "Executor actor id (required for --action=start).",
        },
        steward: {
          kind: "string",
          description: "Steward actor id (required for --action=recover).",
        },
        "lease-token": {
          kind: "string",
          description: "Opaque lease token (required for heartbeat and release).",
        },
        reason: {
          kind: "string",
          description: "Recovery reason (required for --action=recover).",
        },
        json: {
          kind: "boolean",
          description: "Machine-readable JSON output.",
        },
      },
      writes: [".forge/program-leases/**"],
      reads: ["docs/plans/**/program.yaml", "docs/plans/**/*.md"],
      cacheable: false,
      execute: runLease,
    });

    registry.registerCommand({
      name: "program.packet.complete",
      description:
        "Steward validates the implementation range, writes the completion report, " +
        "and updates the program manifest. Supports --bootstrap for packet 000. " +
        "Does not commit — use ecosystem.commit after. " +
        "Usage: program.packet.complete --program=RFC-XXXX --packet=NNN-foo " +
        "--steward=human:id --lease-token=<token> --implementation-head=<sha> --json",
      scope: "workspace",
      supportsAllSites: false,
      mutatesState: true,
      flags: {
        program: {
          kind: "string",
          required: true,
          description: "Program RFC id.",
        },
        packet: {
          kind: "string",
          required: true,
          description: "Packet id to complete.",
        },
        steward: {
          kind: "string",
          required: true,
          description: "Steward actor id (must differ from executor).",
        },
        "lease-token": {
          kind: "string",
          description: "Lease token (required for non-bootstrap).",
        },
        "implementation-head": {
          kind: "string",
          description: "SHA of the implementation head commit (required for non-bootstrap).",
        },
        "idempotency-key": {
          kind: "string",
          description: "Idempotency key for retry-safe completion.",
        },
        bootstrap: {
          kind: "boolean",
          description: "Bootstrap completion (packet 000 only).",
        },
        "seal-commit": {
          kind: "string",
          description: "Seal commit SHA (required for --bootstrap).",
        },
        json: {
          kind: "boolean",
          description: "Machine-readable JSON output.",
        },
      },
      writes: ["docs/plans/**/completions/**", "docs/plans/**/program.yaml"],
      reads: ["docs/plans/**/program.yaml", "docs/plans/**/*.md"],
      cacheable: false,
      execute: runComplete,
    });
  },
};
