/*
<MODULE_CONTRACT>
<purpose>Command handler for program.packet.validate — read-only validation
of a program packet against schema, source hashes, branch/head, and state
machine rules (RFC-0856).</purpose>
<non-goals>
  <item>Do not mutate files — validate is read-only.</item>
  <item>Do not import from @warpgogol/* — forge must remain dependency-free.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0856: initial validate command handler.</item>
</CHANGE_SUMMARY>
*/

import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import {
  discoverProgram,
  findPacketEntry,
  resolvePacketPath,
  parsePacketFile,
  verifyNormativeSources,
  gitBranch,
  gitHead,
  gitIsClean,
} from "../discovery.ts";
import { findActiveLeases, isLeaseStale } from "../lease.ts";
import { validateSealTransition, type PacketViolation } from "../state.ts";

export interface ValidateResultData {
  command: string;
  status: "pass" | "fail";
  program: string;
  packetId: string;
  phase: string;
  branch: string;
  head: string;
  violations: PacketViolation[];
}

export async function runValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ValidateResultData>> {
  const program = input.flags.program as string | undefined;
  const packetId = input.flags.packet as string | undefined;
  const phase = (input.flags.phase as string | undefined) ?? "draft";

  if (!program || !packetId) {
    return {
      data: {
        command: "program.packet.validate",
        status: "fail",
        program: program ?? "<missing>",
        packetId: packetId ?? "<missing>",
        phase,
        branch: "",
        head: "",
        violations: [
          {
            rule: "PROGRAM-PACKET-01",
            message: "both --program and --packet are required",
          },
        ],
      },
      exitCode: 1,
      summary: "program.packet.validate: missing required flags",
    };
  }

  const { workspaceRoot } = context;

  // Discover program
  let programLocation;
  try {
    programLocation = discoverProgram(workspaceRoot, program);
  } catch (err) {
    return failResult(program, packetId, phase, [
      {
        rule: "PROGRAM-PACKET-01",
        message: String((err as Error).message),
      },
    ]);
  }

  if (!programLocation) {
    return failResult(program, packetId, phase, [
      {
        rule: "PROGRAM-PACKET-01",
        message: `program ${program} not found in docs/plans/`,
      },
    ]);
  }

  const { manifest, programDir } = programLocation;

  // Find packet entry
  const entry = findPacketEntry(manifest, packetId);
  if (!entry) {
    return failResult(program, packetId, phase, [
      {
        rule: "PROGRAM-PACKET-01",
        message: `packet ${packetId} not found in program manifest`,
      },
    ]);
  }

  // Parse packet file
  let packet;
  try {
    packet = parsePacketFile(resolvePacketPath(programDir, entry));
  } catch (err) {
    return failResult(program, packetId, phase, [
      {
        rule: "PROGRAM-PACKET-01",
        message: String((err as Error).message),
      },
    ]);
  }

  const violations: PacketViolation[] = [];

  // Verify normative source hashes
  const hashViolations = verifyNormativeSources(workspaceRoot, packet);
  for (const v of hashViolations) {
    violations.push({
      rule: "PROGRAM-PACKET-07",
      path: v.path,
      message: `normative source hash mismatch: expected ${v.expected}, got ${v.actual}`,
    });
  }

  // Check git state
  let branch = "";
  let head = "";
  try {
    branch = gitBranch(workspaceRoot);
    head = gitHead(workspaceRoot);
  } catch {
    violations.push({
      rule: "PROGRAM-PACKET-02",
      message: "failed to read git state",
    });
  }

  // Check for active leases
  const activeLeases = findActiveLeases(workspaceRoot, program);
  const hasActiveLease = activeLeases.some(
    (l) => l.packetId === packetId && !isLeaseStale(l.lease),
  );

  // Validate seal transition (covers most validation rules)
  let isClean = false;
  try {
    isClean = gitIsClean(workspaceRoot);
  } catch {
    // ignore
  }

  const sealViolations = validateSealTransition(manifest, entry, packet, {
    branch,
    head,
    isClean,
    hasActiveLease,
  });
  violations.push(...sealViolations);

  const status = violations.length === 0 ? "pass" : "fail";

  return {
    data: {
      command: "program.packet.validate",
      status,
      program,
      packetId,
      phase,
      branch,
      head,
      violations,
    },
    exitCode: status === "pass" ? 0 : 1,
    summary:
      status === "pass"
        ? `program.packet.validate: ${packetId} passed (${phase})`
        : `program.packet.validate: ${packetId} failed with ${violations.length} violation(s)`,
  };
}

function failResult(
  program: string,
  packetId: string,
  phase: string,
  violations: PacketViolation[],
): ForgeCommandResult<ValidateResultData> {
  return {
    data: {
      command: "program.packet.validate",
      status: "fail",
      program,
      packetId,
      phase,
      branch: "",
      head: "",
      violations,
    },
    exitCode: 1,
    summary: `program.packet.validate: ${packetId} failed with ${violations.length} violation(s)`,
  };
}
