/*
<MODULE_CONTRACT>
<purpose>Unit tests for program packet schemas — verify strict rejection of
unknown fields, required fields, and type constraints (RFC-0856).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0856: initial schema tests.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect } from "vitest";
import {
  programManifestSchema,
  programPacketSchema,
  programPacketLeaseSchema,
  programPacketCompletionSchema,
  recoveryRecordSchema,
} from "../../os/program/schemas.ts";

describe("programManifestSchema", () => {
  it("accepts a valid manifest", () => {
    const manifest = {
      schema: "forge/program@1",
      program: "RFC-0855",
      title: "Test program",
      branch: "main",
      state: "preparing",
      currentPacket: "000-test",
      steward: "human:alice",
      sequential: true,
      parallelism: 1,
      packets: [
        {
          order: 0,
          packetId: "000-test",
          file: "000-test.md",
          state: "draft",
          governingDecision: "RFC-0856",
          decisionKind: "rfc",
          resolvedRfc: "RFC-0856",
          dependsOnPacket: null,
          baseCommit: null,
          sealCommit: null,
          completion: null,
        },
      ],
    };

    const result = programManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields", () => {
    const manifest = {
      schema: "forge/program@1",
      program: "RFC-0855",
      title: "Test",
      branch: "main",
      state: "preparing",
      currentPacket: "000-test",
      steward: "human:alice",
      sequential: true,
      parallelism: 1,
      packets: [],
      extraField: "should fail",
    };

    const result = programManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("rejects parallelism !== 1", () => {
    const manifest = {
      schema: "forge/program@1",
      program: "RFC-0855",
      title: "Test",
      branch: "main",
      state: "preparing",
      currentPacket: "000-test",
      steward: "human:alice",
      sequential: true,
      parallelism: 2,
      packets: [],
    };

    const result = programManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("rejects empty packets array", () => {
    const manifest = {
      schema: "forge/program@1",
      program: "RFC-0855",
      title: "Test",
      branch: "main",
      state: "preparing",
      currentPacket: "000-test",
      steward: "human:alice",
      sequential: true,
      parallelism: 1,
      packets: [],
    };

    const result = programManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });
});

describe("programPacketSchema", () => {
  it("accepts a valid packet", () => {
    const packet = {
      schema: "forge/program-packet@1",
      program: "RFC-0855",
      packetId: "000-test",
      state: "draft",
      governingDecision: "RFC-0856",
      decisionKind: "rfc",
      resolvedRfc: "RFC-0856",
      dependsOnPacket: null,
      baseCommit: null,
      branch: "main",
      steward: "human:alice",
      normativeSources: [{ path: "docs/rfcs/rfc-0856.md", sha256: "a".repeat(64) }],
      allowedFiles: ["packages/forge/**"],
      forbiddenFiles: ["missions/**"],
      permittedTransitionDiagnostics: [],
      requiredValidations: [
        { command: "pnpm test", expectedStatus: "pass", expectedDiagnostics: [] },
      ],
    };

    const result = programPacketSchema.safeParse(packet);
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields", () => {
    const packet = {
      schema: "forge/program-packet@1",
      program: "RFC-0855",
      packetId: "000-test",
      state: "draft",
      governingDecision: "RFC-0856",
      decisionKind: "rfc",
      resolvedRfc: "RFC-0856",
      dependsOnPacket: null,
      baseCommit: null,
      branch: "main",
      steward: "human:alice",
      normativeSources: [],
      allowedFiles: [],
      forbiddenFiles: [],
      permittedTransitionDiagnostics: [],
      requiredValidations: [],
      extra: true,
    };

    const result = programPacketSchema.safeParse(packet);
    expect(result.success).toBe(false);
  });

  it("rejects empty allowedFiles", () => {
    const packet = {
      schema: "forge/program-packet@1",
      program: "RFC-0855",
      packetId: "000-test",
      state: "draft",
      governingDecision: "RFC-0856",
      decisionKind: "rfc",
      resolvedRfc: "RFC-0856",
      dependsOnPacket: null,
      baseCommit: null,
      branch: "main",
      steward: "human:alice",
      normativeSources: [],
      allowedFiles: [],
      forbiddenFiles: [],
      permittedTransitionDiagnostics: [],
      requiredValidations: [],
    };

    const result = programPacketSchema.safeParse(packet);
    expect(result.success).toBe(false);
  });

  it("rejects invalid sha256", () => {
    const packet = {
      schema: "forge/program-packet@1",
      program: "RFC-0855",
      packetId: "000-test",
      state: "draft",
      governingDecision: "RFC-0856",
      decisionKind: "rfc",
      resolvedRfc: "RFC-0856",
      dependsOnPacket: null,
      baseCommit: null,
      branch: "main",
      steward: "human:alice",
      normativeSources: [{ path: "test.md", sha256: "short" }],
      allowedFiles: ["packages/**"],
      forbiddenFiles: [],
      permittedTransitionDiagnostics: [],
      requiredValidations: [],
    };

    const result = programPacketSchema.safeParse(packet);
    expect(result.success).toBe(false);
  });
});

describe("programPacketLeaseSchema", () => {
  it("accepts a valid lease", () => {
    const lease = {
      schema: "forge/program-packet-lease@1",
      program: "RFC-0855",
      packetId: "000-test",
      sealCommit: "abc123",
      executor: "agent:bot1",
      tokenHash: "b".repeat(64),
      startedAt: "2026-08-15T10:00:00Z",
      heartbeatAt: "2026-08-15T10:00:00Z",
      timeoutSeconds: 3600,
    };

    const result = programPacketLeaseSchema.safeParse(lease);
    expect(result.success).toBe(true);
  });

  it("rejects same steward and executor pattern for actor", () => {
    // The schema itself doesn't check steward vs executor, but it validates format
    const lease = {
      schema: "forge/program-packet-lease@1",
      program: "RFC-0855",
      packetId: "000-test",
      sealCommit: "abc123",
      executor: "invalid-format",
      tokenHash: "b".repeat(64),
      startedAt: "2026-08-15T10:00:00Z",
      heartbeatAt: "2026-08-15T10:00:00Z",
      timeoutSeconds: 3600,
    };

    const result = programPacketLeaseSchema.safeParse(lease);
    expect(result.success).toBe(false);
  });
});

describe("programPacketCompletionSchema", () => {
  it("accepts a valid completion", () => {
    const completion = {
      schema: "forge/program-packet-completion@1",
      program: "RFC-0855",
      packetId: "000-test",
      baseCommit: "abc123",
      sealCommit: "def456",
      implementationCommits: ["ghi789"],
      implementationHead: "ghi789",
      changedFiles: ["packages/forge/foo.ts"],
      validations: [{ command: "pnpm test", status: "pass", evidenceDigest: "sha256:abc" }],
      remainingTransitionDiagnostics: [],
      unexpectedDiagnostics: [],
      recoveryStatus: "not-applicable",
      cleanTrees: true,
      completedBy: "human:alice",
    };

    const result = programPacketCompletionSchema.safeParse(completion);
    expect(result.success).toBe(true);
  });

  it("rejects non-empty unexpectedDiagnostics", () => {
    const completion = {
      schema: "forge/program-packet-completion@1",
      program: "RFC-0855",
      packetId: "000-test",
      baseCommit: "abc123",
      sealCommit: "def456",
      implementationCommits: ["ghi789"],
      implementationHead: "ghi789",
      changedFiles: [],
      validations: [],
      remainingTransitionDiagnostics: [],
      unexpectedDiagnostics: ["something"],
      recoveryStatus: "not-applicable",
      cleanTrees: true,
      completedBy: "human:alice",
    };

    const result = programPacketCompletionSchema.safeParse(completion);
    expect(result.success).toBe(false);
  });

  it("rejects cleanTrees: false", () => {
    const completion = {
      schema: "forge/program-packet-completion@1",
      program: "RFC-0855",
      packetId: "000-test",
      baseCommit: "abc123",
      sealCommit: "def456",
      implementationCommits: ["ghi789"],
      implementationHead: "ghi789",
      changedFiles: [],
      validations: [],
      remainingTransitionDiagnostics: [],
      unexpectedDiagnostics: [],
      recoveryStatus: "not-applicable",
      cleanTrees: false,
      completedBy: "human:alice",
    };

    const result = programPacketCompletionSchema.safeParse(completion);
    expect(result.success).toBe(false);
  });
});

describe("recoveryRecordSchema", () => {
  it("accepts a valid recovery record", () => {
    const recovery = {
      schema: "forge/program-packet-recovery@1",
      program: "RFC-0855",
      packetId: "000-test",
      previousLeaseDigest: "c".repeat(64),
      reason: "executor timeout",
      actor: "human:alice",
      observedHead: "abc123",
      target: "blocked",
      recoveredAt: "2026-08-15T10:00:00Z",
    };

    const result = recoveryRecordSchema.safeParse(recovery);
    expect(result.success).toBe(true);
  });
});
