/*
<MODULE_CONTRACT>
<purpose>State machine logic for program packet transitions.
Validates allowed transitions and produces violation records.</purpose>
<non-goals>
  <item>Do not mutate files — state validation only.</item>
  <item>Do not import from @warpgogol/* — forge must remain dependency-free.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0856: initial state machine logic.</item>
</CHANGE_SUMMARY>
*/

import type {
  ProgramManifest,
  ProgramPacket,
  ProgramPacketIndexEntry,
  ProgramPacketLease,
  ProgramActor,
} from "./schemas.ts";

// ---------------------------------------------------------------------------
// Violation type
// ---------------------------------------------------------------------------

export interface PacketViolation {
  rule: string;
  path?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Transition validation
// ---------------------------------------------------------------------------

/**
 * Validate that a seal transition is allowed.
 */
export function validateSealTransition(
  manifest: ProgramManifest,
  entry: ProgramPacketIndexEntry,
  packet: ProgramPacket,
  options: {
    branch: string;
    head: string;
    isClean: boolean;
    hasActiveLease: boolean;
  },
): PacketViolation[] {
  const violations: PacketViolation[] = [];

  // PROGRAM-PACKET-02: wrong branch
  if (options.branch !== manifest.branch) {
    violations.push({
      rule: "PROGRAM-PACKET-02",
      message: `wrong branch: expected ${manifest.branch}, got ${options.branch}`,
    });
  }

  // PROGRAM-PACKET-10: dirty tree at sealed boundary
  if (!options.isClean) {
    violations.push({
      rule: "PROGRAM-PACKET-10",
      message: "dirty tree at seal boundary — commit or stash changes first",
    });
  }

  // PROGRAM-PACKET-05: active or stale lease exists
  if (options.hasActiveLease) {
    violations.push({
      rule: "PROGRAM-PACKET-05",
      message: "active or stale lease exists — recover before sealing",
    });
  }

  // Packet must be in draft state
  if (packet.state !== "draft") {
    violations.push({
      rule: "PROGRAM-PACKET-04",
      message: `packet state is ${packet.state}, expected draft`,
    });
  }

  // PROGRAM-PACKET-03: predecessor must be completed (unless bootstrap)
  if (entry.dependsOnPacket !== null) {
    const predecessor = manifest.packets.find(
      (p) => p.packetId === entry.dependsOnPacket,
    );
    if (!predecessor) {
      violations.push({
        rule: "PROGRAM-PACKET-03",
        message: `predecessor packet ${entry.dependsOnPacket} not found in manifest`,
      });
    } else if (predecessor.state !== "completed") {
      violations.push({
        rule: "PROGRAM-PACKET-03",
        message: `predecessor packet ${entry.dependsOnPacket} is ${predecessor.state}, expected completed`,
      });
    } else if (predecessor.completion && entry.baseCommit !== predecessor.completion) {
      violations.push({
        rule: "PROGRAM-PACKET-09",
        message: `baseCommit ${entry.baseCommit} does not match predecessor completion ${predecessor.completion}`,
      });
    }
  }

  // baseCommit must be set for sealed packet (unless bootstrap with null predecessor)
  if (entry.dependsOnPacket !== null && entry.baseCommit === null) {
    violations.push({
      rule: "PROGRAM-PACKET-09",
      message: "baseCommit is null for a non-bootstrap packet",
    });
  }

  // allowedFiles must be non-empty
  if (packet.allowedFiles.length === 0) {
    violations.push({
      rule: "PROGRAM-PACKET-06",
      message: "allowedFiles is empty — packet must define at least one allowed path",
    });
  }

  return violations;
}

/**
 * Validate that a lease start transition is allowed.
 */
export function validateLeaseStartTransition(
  manifest: ProgramManifest,
  entry: ProgramPacketIndexEntry,
  packet: ProgramPacket,
  options: {
    head: string;
    steward: ProgramActor;
    executor: ProgramActor;
    hasActiveLease: boolean;
  },
): PacketViolation[] {
  const violations: PacketViolation[] = [];

  // PROGRAM-PACKET-04: role collision
  if (options.steward === options.executor) {
    violations.push({
      rule: "PROGRAM-PACKET-04",
      message: `role collision: steward and executor are the same (${options.steward})`,
    });
  }

  // Packet must be sealed
  if (packet.state !== "sealed") {
    violations.push({
      rule: "PROGRAM-PACKET-04",
      message: `packet state is ${packet.state}, expected sealed`,
    });
  }

  // PROGRAM-PACKET-05: active or stale lease exists
  if (options.hasActiveLease) {
    violations.push({
      rule: "PROGRAM-PACKET-05",
      message: "active or stale lease already exists for this packet",
    });
  }

  // PROGRAM-PACKET-02: HEAD must match sealCommit
  if (entry.sealCommit && options.head !== entry.sealCommit) {
    violations.push({
      rule: "PROGRAM-PACKET-02",
      message: `HEAD ${options.head} does not match sealCommit ${entry.sealCommit}`,
    });
  }

  return violations;
}

/**
 * Validate that a completion transition is allowed.
 */
export function validateCompleteTransition(
  manifest: ProgramManifest,
  entry: ProgramPacketIndexEntry,
  lease: ProgramPacketLease,
  options: {
    head: string;
    isClean: boolean;
    steward: ProgramActor;
    implementationHead: string;
    changedFiles: string[];
    allowedFiles: string[];
    forbiddenFiles: string[];
    ancestryValid: boolean;
  },
): PacketViolation[] {
  const violations: PacketViolation[] = [];

  // PROGRAM-PACKET-04: steward must differ from executor
  if (options.steward === lease.executor) {
    violations.push({
      rule: "PROGRAM-PACKET-04",
      message: "completion steward must differ from lease executor",
    });
  }

  // PROGRAM-PACKET-10: dirty tree
  if (!options.isClean) {
    violations.push({
      rule: "PROGRAM-PACKET-10",
      message: "dirty tree at completion boundary",
    });
  }

  // PROGRAM-PACKET-09: ancestry
  if (!options.ancestryValid) {
    violations.push({
      rule: "PROGRAM-PACKET-09",
      message: "implementation commits do not descend from seal commit",
    });
  }

  // PROGRAM-PACKET-09: implementation head must match
  if (options.head !== options.implementationHead) {
    violations.push({
      rule: "PROGRAM-PACKET-09",
      message: `HEAD ${options.head} does not match declared implementationHead ${options.implementationHead}`,
    });
  }

  // PROGRAM-PACKET-06: path validation
  for (const file of options.changedFiles) {
    if (options.forbiddenFiles.length > 0 && isPathForbidden(file, options.forbiddenFiles)) {
      violations.push({
        rule: "PROGRAM-PACKET-06",
        path: file,
        message: `changed file ${file} is in forbidden list`,
      });
    }
    if (!isPathAllowed(file, options.allowedFiles)) {
      violations.push({
        rule: "PROGRAM-PACKET-06",
        path: file,
        message: `changed file ${file} is not in allowed list`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Path helpers (imported from discovery for convenience)
// ---------------------------------------------------------------------------

import { isPathAllowed, isPathForbidden } from "./discovery.ts";
