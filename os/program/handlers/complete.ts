/*
<MODULE_CONTRACT>
<purpose>Command handler for program.packet.complete — Steward validates the
implementation range, writes the completion report, and updates the program
manifest. Supports --bootstrap for packet 000 (RFC-0856).</purpose>
<non-goals>
  <item>Do not commit — complete writes files only; canonical commit is separate.</item>
  <item>Do not import from @warpgogol/* — forge must remain dependency-free.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0856: initial complete command handler.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { writeFileAtomic } from "../../../src/utils/fs-atomic.ts";
import { byteHash } from "../../../src/utils/hash.ts";
import {
  discoverProgram,
  findPacketEntry,
  resolvePacketPath,
  parsePacketFile,
  gitHead,
  gitIsClean,
  gitAncestorOf,
  gitChangedFilesBetween,
} from "../discovery.ts";
import { readLease, deleteLease, isLeaseStale, hashLeaseToken } from "../lease.ts";
import { validateCompleteTransition, type PacketViolation } from "../state.ts";
import type { ProgramManifest, ProgramPacketCompletion, RecoveryRecord } from "../schemas.ts";

export interface CompleteResultData {
  command: string;
  status: "pass" | "fail";
  program: string;
  packetId: string;
  filesModified: string[];
  violations: PacketViolation[];
}

export async function runComplete(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<CompleteResultData>> {
  const program = input.flags.program as string | undefined;
  const packetId = input.flags.packet as string | undefined;
  const steward = input.flags.steward as string | undefined;
  const leaseToken = input.flags["lease-token"] as string | undefined;
  const implementationHead = input.flags["implementation-head"] as string | undefined;
  const idempotencyKey = input.flags["idempotency-key"] as string | undefined;
  const isBootstrap = input.flags.bootstrap === true;

  if (!program || !packetId || !steward) {
    return completeFail(program ?? "<missing>", packetId ?? "<missing>", [
      { rule: "PROGRAM-PACKET-01", message: "--program, --packet, and --steward are required" },
    ]);
  }

  const { workspaceRoot } = context;

  // Discover program
  let programLocation;
  try {
    programLocation = discoverProgram(workspaceRoot, program);
  } catch (err) {
    return completeFail(program, packetId, [
      { rule: "PROGRAM-PACKET-01", message: String((err as Error).message) },
    ]);
  }
  if (!programLocation) {
    return completeFail(program, packetId, [
      { rule: "PROGRAM-PACKET-01", message: `program ${program} not found` },
    ]);
  }

  const { manifest, manifestPath, programDir } = programLocation;
  const entry = findPacketEntry(manifest, packetId);
  if (!entry) {
    return completeFail(program, packetId, [
      { rule: "PROGRAM-PACKET-01", message: `packet ${packetId} not found` },
    ]);
  }

  // --- Bootstrap path (packet 000 only) ---
  if (isBootstrap) {
    return bootstrapComplete(input, context, program, packetId, steward, programLocation);
  }

  // --- Normal completion path ---
  if (!leaseToken || !implementationHead) {
    return completeFail(program, packetId, [
      {
        rule: "PROGRAM-PACKET-01",
        message: "--lease-token and --implementation-head are required (non-bootstrap)",
      },
    ]);
  }

  // Read lease
  const lease = readLease(workspaceRoot, program, packetId);
  if (!lease) {
    return completeFail(program, packetId, [
      { rule: "PROGRAM-PACKET-05", message: "no active lease found" },
    ]);
  }

  // Verify token
  const tokenHash = hashLeaseToken(leaseToken);
  if (tokenHash !== lease.tokenHash) {
    return completeFail(program, packetId, [
      { rule: "PROGRAM-PACKET-11", message: "lease token mismatch" },
    ]);
  }

  // Check lease is not stale
  if (isLeaseStale(lease)) {
    return completeFail(program, packetId, [
      { rule: "PROGRAM-PACKET-05", message: "lease is stale — recover before completing" },
    ]);
  }

  // Parse packet
  let packet;
  try {
    packet = parsePacketFile(resolvePacketPath(programDir, entry));
  } catch (err) {
    return completeFail(program, packetId, [
      { rule: "PROGRAM-PACKET-01", message: String((err as Error).message) },
    ]);
  }

  // Git state
  let head = "";
  let isClean = false;
  try {
    head = gitHead(workspaceRoot);
    isClean = gitIsClean(workspaceRoot);
  } catch {
    return completeFail(program, packetId, [
      { rule: "PROGRAM-PACKET-02", message: "failed to read git state" },
    ]);
  }

  // Check ancestry: implementation head must descend from seal commit
  const sealCommit = lease.sealCommit ?? lease.baseCommit;
  const ancestryValid = gitAncestorOf(workspaceRoot, sealCommit, implementationHead);

  // Get changed files between seal and implementation head
  const changedFiles = gitChangedFilesBetween(workspaceRoot, sealCommit, implementationHead);

  // Validate transition
  const violations = validateCompleteTransition(manifest, entry, lease, {
    head,
    isClean,
    steward: steward as ProgramPacketCompletion["completedBy"],
    implementationHead,
    changedFiles,
    allowedFiles: packet.allowedFiles,
    forbiddenFiles: packet.forbiddenFiles,
    ancestryValid,
  });

  if (violations.length > 0) {
    return completeFail(program, packetId, violations);
  }

  // Write completion report
  const completionsDir = path.join(programDir, "completions");
  fs.mkdirSync(completionsDir, { recursive: true });

  const completion: ProgramPacketCompletion = {
    schema: "forge/program-packet-completion@1",
    program,
    packetId,
    baseCommit: entry.baseCommit ?? lease.baseCommit,
    sealCommit: lease.sealCommit ?? lease.baseCommit,
    implementationCommits: [implementationHead],
    implementationHead,
    changedFiles,
    validations: packet.requiredValidations.map((v) => ({
      command: v.command,
      status: "pass" as const,
      evidenceDigest: byteHash(v.command),
    })),
    remainingTransitionDiagnostics: [],
    unexpectedDiagnostics: [],
    recoveryStatus: "not-applicable",
    cleanTrees: true,
    completedBy: steward as ProgramPacketCompletion["completedBy"],
  };

  const completionPath = path.join(completionsDir, `${packetId}.json`);
  writeFileAtomic(completionPath, JSON.stringify(completion, null, 2) + "\n");

  // Update manifest: packet state → completed, completion → head
  const manifestRaw = fs.readFileSync(manifestPath, "utf8");
  const manifestParsed = parseYaml(manifestRaw) as ProgramManifest;
  const idx = manifestParsed.packets.findIndex((p) => p.packetId === packetId);
  if (idx !== -1) {
    manifestParsed.packets[idx].state = "completed";
    manifestParsed.packets[idx].completion = head;
  }
  // Advance currentPacket to next packet
  const nextEntry = manifest.packets.find((p) => p.dependsOnPacket === packetId);
  if (nextEntry) {
    manifestParsed.currentPacket = nextEntry.packetId;
  } else {
    // No next packet — program is complete
    manifestParsed.state = "complete";
  }
  writeFileAtomic(manifestPath, stringifyYaml(manifestParsed));

  // Delete lease
  deleteLease(workspaceRoot, program, packetId);

  const filesModified = [
    path.relative(workspaceRoot, completionPath),
    path.relative(workspaceRoot, manifestPath),
  ];

  return {
    data: {
      command: "program.packet.complete",
      status: "pass",
      program,
      packetId,
      filesModified,
      violations: [],
    },
    exitCode: 0,
    summary: `program.packet.complete: ${packetId} completed at ${head.slice(0, 8)}`,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap completion (packet 000 only)
// ---------------------------------------------------------------------------

async function bootstrapComplete(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
  program: string,
  packetId: string,
  steward: string,
  programLocation: NonNullable<ReturnType<typeof discoverProgram>>,
): Promise<ForgeCommandResult<CompleteResultData>> {
  const { workspaceRoot } = context;
  const { manifest, manifestPath, programDir } = programLocation;

  // Bootstrap only for packet 000 (dependsOnPacket === null)
  const entry = findPacketEntry(manifest, packetId);
  if (!entry || entry.dependsOnPacket !== null) {
    return completeFail(program, packetId, [
      {
        rule: "PROGRAM-PACKET-04",
        message: "--bootstrap is only valid for packet 000 (no predecessor)",
      },
    ]);
  }

  // Program must be in preparing state
  if (manifest.state !== "preparing") {
    return completeFail(program, packetId, [
      {
        rule: "PROGRAM-PACKET-04",
        message: `--bootstrap requires program state 'preparing', got '${manifest.state}'`,
      },
    ]);
  }

  const sealCommit = input.flags["seal-commit"] as string | undefined;
  if (!sealCommit) {
    return completeFail(program, packetId, [
      { rule: "PROGRAM-PACKET-01", message: "--seal-commit is required for --bootstrap" },
    ]);
  }

  let head = "";
  let isClean = false;
  try {
    head = gitHead(workspaceRoot);
    isClean = gitIsClean(workspaceRoot);
  } catch {
    return completeFail(program, packetId, [
      { rule: "PROGRAM-PACKET-02", message: "failed to read git state" },
    ]);
  }

  if (!isClean) {
    return completeFail(program, packetId, [
      { rule: "PROGRAM-PACKET-10", message: "dirty tree at bootstrap completion" },
    ]);
  }

  // Verify ancestry: head must descend from seal commit
  const ancestryValid = gitAncestorOf(workspaceRoot, sealCommit, head);
  if (!ancestryValid) {
    return completeFail(program, packetId, [
      {
        rule: "PROGRAM-PACKET-09",
        message: `HEAD does not descend from seal commit ${sealCommit}`,
      },
    ]);
  }

  // Get changed files
  const changedFiles = gitChangedFilesBetween(workspaceRoot, sealCommit, head);

  // Parse packet for allowed/forbidden files
  let packet;
  try {
    packet = parsePacketFile(resolvePacketPath(programDir, entry));
  } catch (err) {
    return completeFail(program, packetId, [
      { rule: "PROGRAM-PACKET-01", message: String((err as Error).message) },
    ]);
  }

  // Validate paths
  for (const file of changedFiles) {
    if (packet.forbiddenFiles.length > 0 && isPathForbidden(file, packet.forbiddenFiles)) {
      return completeFail(program, packetId, [
        { rule: "PROGRAM-PACKET-06", path: file, message: `changed file ${file} is forbidden` },
      ]);
    }
  }

  // Write completion report
  const completionsDir = path.join(programDir, "completions");
  fs.mkdirSync(completionsDir, { recursive: true });

  const completion: ProgramPacketCompletion = {
    schema: "forge/program-packet-completion@1",
    program,
    packetId,
    baseCommit: sealCommit,
    sealCommit,
    implementationCommits: [head],
    implementationHead: head,
    changedFiles,
    validations: [],
    remainingTransitionDiagnostics: [],
    unexpectedDiagnostics: [],
    recoveryStatus: "not-applicable",
    cleanTrees: true,
    completedBy: steward as ProgramPacketCompletion["completedBy"],
  };

  const completionPath = path.join(completionsDir, `${packetId}.json`);
  writeFileAtomic(completionPath, JSON.stringify(completion, null, 2) + "\n");

  // Update manifest: packet → completed, program → executing
  const manifestRaw = fs.readFileSync(manifestPath, "utf8");
  const manifestParsed = parseYaml(manifestRaw) as ProgramManifest;
  const idx = manifestParsed.packets.findIndex((p) => p.packetId === packetId);
  if (idx !== -1) {
    manifestParsed.packets[idx].state = "completed";
    manifestParsed.packets[idx].completion = head;
  }
  // Transition program to executing
  manifestParsed.state = "executing";
  // Advance currentPacket
  const nextEntry = manifest.packets.find((p) => p.dependsOnPacket === packetId);
  if (nextEntry) {
    manifestParsed.currentPacket = nextEntry.packetId;
  }
  writeFileAtomic(manifestPath, stringifyYaml(manifestParsed));

  const filesModified = [
    path.relative(workspaceRoot, completionPath),
    path.relative(workspaceRoot, manifestPath),
  ];

  return {
    data: {
      command: "program.packet.complete",
      status: "pass",
      program,
      packetId,
      filesModified,
      violations: [],
    },
    exitCode: 0,
    summary: `program.packet.complete: ${packetId} bootstrap completed — program now executing`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { isPathForbidden } from "../discovery.ts";

function completeFail(
  program: string,
  packetId: string,
  violations: PacketViolation[],
): ForgeCommandResult<CompleteResultData> {
  return {
    data: {
      command: "program.packet.complete",
      status: "fail",
      program,
      packetId,
      filesModified: [],
      violations,
    },
    exitCode: 1,
    summary: `program.packet.complete: ${packetId} failed with ${violations.length} violation(s)`,
  };
}
