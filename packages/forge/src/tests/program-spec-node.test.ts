/*
<MODULE_CONTRACT>
<purpose>Unit tests for RFC-0857 spec-node seal validation — verify that
spec-node packets with null resolvedRfc are rejected at seal boundary
(PROGRAM-PACKET-12) and that phase-aware lease schema accepts preparation
and execution phases.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0857: spec-node seal validation and phase-aware lease tests.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect } from "vitest";
import {
  validateSealTransition,
  type PacketViolation,
} from "../../os/program/state.ts";
import {
  programPacketLeaseSchema,
  programPacketPreparationSchema,
  type ProgramManifest,
  type ProgramPacket,
  type ProgramPacketIndexEntry,
} from "../../os/program/schemas.ts";

function makeManifest(packets: ProgramPacketIndexEntry[]): ProgramManifest {
  return {
    schema: "forge/program@1",
    program: "RFC-0855",
    title: "Test",
    branch: "main",
    state: "executing",
    currentPacket: "140-test",
    steward: "human:alice",
    sequential: true,
    parallelism: 1,
    packets,
  };
}

function makePacket(): ProgramPacket {
  return {
    schema: "forge/program-packet@1",
    program: "RFC-0855",
    packetId: "140-test",
    state: "draft",
    governingDecision: "werkstatt-release-certification/CERT-002",
    decisionKind: "spec-node",
    resolvedRfc: null,
    dependsOnPacket: "130-predecessor",
    baseCommit: "abc123",
    branch: "main",
    steward: "human:alice",
    normativeSources: [{ path: "docs/rfcs/rfc-0857.md", sha256: "a".repeat(64) }],
    allowedFiles: ["packages/forge/**"],
    forbiddenFiles: [],
    permittedTransitionDiagnostics: [],
    requiredValidations: [],
  };
}

function makeEntry(overrides?: Partial<ProgramPacketIndexEntry>): ProgramPacketIndexEntry {
  return {
    order: 1,
    packetId: "140-test",
    file: "140-test.md",
    state: "draft",
    governingDecision: "werkstatt-release-certification/CERT-002",
    decisionKind: "spec-node",
    resolvedRfc: null,
    dependsOnPacket: "130-predecessor",
    baseCommit: "abc123",
    sealCommit: null,
    completion: null,
    ...overrides,
  };
}

function makePredecessorEntry(completed = true): ProgramPacketIndexEntry {
  return {
    order: 0,
    packetId: "130-predecessor",
    file: "130-predecessor.md",
    state: completed ? "completed" : "sealed",
    governingDecision: "RFC-0856",
    decisionKind: "rfc",
    resolvedRfc: "RFC-0856",
    dependsOnPacket: null,
    baseCommit: null,
    sealCommit: "def456",
    completion: completed ? "ghi789" : null,
  };
}

describe("RFC-0857: spec-node seal validation", () => {
  it("rejects spec-node packet with null resolvedRfc", () => {
    const manifest = makeManifest([makePredecessorEntry(), makeEntry()]);
    const packet = makePacket();
    const entry = makeEntry();

    const violations = validateSealTransition(manifest, entry, packet, {
      branch: "main",
      head: "abc123",
      isClean: true,
      hasActiveLease: false,
    });

    const specNodeViolation = violations.find((v) => v.rule === "PROGRAM-PACKET-12");
    expect(specNodeViolation).toBeDefined();
    expect(specNodeViolation!.message).toContain("resolvedRfc: null");
  });

  it("accepts spec-node packet with non-null resolvedRfc", () => {
    const manifest = makeManifest([makePredecessorEntry(), makeEntry({ resolvedRfc: "RFC-0865" })]);
    const packet = makePacket();
    const entry = makeEntry({ resolvedRfc: "RFC-0865" });

    const violations = validateSealTransition(manifest, entry, packet, {
      branch: "main",
      head: "abc123",
      isClean: true,
      hasActiveLease: false,
    });

    const specNodeViolation = violations.find((v) => v.rule === "PROGRAM-PACKET-12");
    expect(specNodeViolation).toBeUndefined();
  });

  it("does not apply PROGRAM-PACKET-12 to rfc-kind packets", () => {
    const manifest = makeManifest([makePredecessorEntry(), makeEntry({ decisionKind: "rfc", resolvedRfc: "RFC-0856" })]);
    const packet = makePacket();
    (packet as Partial<ProgramPacket>).decisionKind = "rfc";
    (packet as Partial<ProgramPacket>).resolvedRfc = "RFC-0856";
    const entry = makeEntry({ decisionKind: "rfc", resolvedRfc: "RFC-0856" });

    const violations = validateSealTransition(manifest, entry, packet, {
      branch: "main",
      head: "abc123",
      isClean: true,
      hasActiveLease: false,
    });

    const specNodeViolation = violations.find((v) => v.rule === "PROGRAM-PACKET-12");
    expect(specNodeViolation).toBeUndefined();
  });
});

describe("RFC-0857: phase-aware lease schema", () => {
  it("accepts preparation phase lease with null sealCommit", () => {
    const lease = {
      schema: "forge/program-packet-lease@1",
      program: "RFC-0855",
      packetId: "140-test",
      phase: "preparation",
      actor: "human:steward",
      baseCommit: "abc123",
      sealCommit: null,
      tokenHash: "b".repeat(64),
      startedAt: "2026-08-15T10:00:00Z",
      heartbeatAt: "2026-08-15T10:00:00Z",
      timeoutSeconds: 3600,
    };

    const result = programPacketLeaseSchema.safeParse(lease);
    expect(result.success).toBe(true);
  });

  it("accepts execution phase lease with non-null sealCommit", () => {
    const lease = {
      schema: "forge/program-packet-lease@1",
      program: "RFC-0855",
      packetId: "140-test",
      phase: "execution",
      actor: "agent:bot1",
      baseCommit: "abc123",
      sealCommit: "def456",
      tokenHash: "b".repeat(64),
      startedAt: "2026-08-15T10:00:00Z",
      heartbeatAt: "2026-08-15T10:00:00Z",
      timeoutSeconds: 3600,
    };

    const result = programPacketLeaseSchema.safeParse(lease);
    expect(result.success).toBe(true);
  });

  it("rejects lease missing phase field", () => {
    const lease = {
      schema: "forge/program-packet-lease@1",
      program: "RFC-0855",
      packetId: "140-test",
      actor: "agent:bot1",
      baseCommit: "abc123",
      sealCommit: "def456",
      tokenHash: "b".repeat(64),
      startedAt: "2026-08-15T10:00:00Z",
      heartbeatAt: "2026-08-15T10:00:00Z",
      timeoutSeconds: 3600,
    };

    const result = programPacketLeaseSchema.safeParse(lease);
    expect(result.success).toBe(false);
  });
});

describe("RFC-0857: preparation report schema", () => {
  it("accepts a valid preparation report", () => {
    const prep = {
      schema: "forge/program-packet-preparation@1",
      program: "RFC-0855",
      packetId: "140-resolved-certification-profile",
      baseCommit: "abc123",
      preparationCommits: ["def456"],
      preparationHead: "def456",
      changedFiles: ["docs/rfcs/rfc-0865.md"],
      governingDecision: "werkstatt-release-certification/CERT-002",
      resolvedRfc: "RFC-0865",
      materializationCommit: "def456",
      validations: [{ command: "rfc.validate --id RFC-0865", status: "pass", evidenceDigest: "sha256:abc" }],
      cleanTrees: true,
      preparedBy: "human:steward",
    };

    const result = programPacketPreparationSchema.safeParse(prep);
    expect(result.success).toBe(true);
  });

  it("rejects preparation report with empty resolvedRfc", () => {
    const prep = {
      schema: "forge/program-packet-preparation@1",
      program: "RFC-0855",
      packetId: "140-test",
      baseCommit: "abc123",
      preparationCommits: ["def456"],
      preparationHead: "def456",
      changedFiles: [],
      governingDecision: "werkstatt-release-certification/CERT-002",
      resolvedRfc: "",
      materializationCommit: "def456",
      validations: [],
      cleanTrees: true,
      preparedBy: "human:steward",
    };

    const result = programPacketPreparationSchema.safeParse(prep);
    expect(result.success).toBe(false);
  });
});
