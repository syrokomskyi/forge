/*
<MODULE_CONTRACT>
<purpose>Command handler for program.packet.seal — Steward finalizes a packet
against the predecessor's completion commit, updates packet state from draft
to sealed, and records the seal in the program manifest (RFC-0856).</purpose>
<non-goals>
  <item>Do not commit — seal writes files only; canonical commit is separate.</item>
  <item>Do not import from @warpgogol/* — forge must remain dependency-free.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0856: initial seal command handler.</item>
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
import type { ProgramManifest, ProgramPacket } from "../schemas.ts";

export interface SealResultData {
  command: string;
  status: "pass" | "fail";
  program: string;
  packetId: string;
  filesModified: string[];
  violations: PacketViolation[];
}

export async function runSeal(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SealResultData>> {
  const program = input.flags.program as string | undefined;
  const packetId = input.flags.packet as string | undefined;
  const steward = input.flags.steward as string | undefined;
  const idempotencyKey = input.flags["idempotency-key"] as string | undefined;

  if (!program || !packetId || !steward) {
    return {
      data: {
        command: "program.packet.seal",
        status: "fail",
        program: program ?? "<missing>",
        packetId: packetId ?? "<missing>",
        filesModified: [],
        violations: [
          {
            rule: "PROGRAM-PACKET-01",
            message: "--program, --packet, and --steward are required",
          },
        ],
      },
      exitCode: 1,
      summary: "program.packet.seal: missing required flags",
    };
  }

  const { workspaceRoot } = context;

  // Discover program
  let programLocation;
  try {
    programLocation = discoverProgram(workspaceRoot, program);
  } catch (err) {
    return sealFail(program, packetId, [
      { rule: "PROGRAM-PACKET-01", message: String((err as Error).message) },
    ]);
  }

  if (!programLocation) {
    return sealFail(program, packetId, [
      { rule: "PROGRAM-PACKET-01", message: `program ${program} not found` },
    ]);
  }

  const { manifest, manifestPath, programDir } = programLocation;

  // Find packet entry
  const entry = findPacketEntry(manifest, packetId);
  if (!entry) {
    return sealFail(program, packetId, [
      { rule: "PROGRAM-PACKET-01", message: `packet ${packetId} not found` },
    ]);
  }

  // Parse packet file
  let packet: ProgramPacket;
  try {
    packet = parsePacketFile(resolvePacketPath(programDir, entry));
  } catch (err) {
    return sealFail(program, packetId, [
      { rule: "PROGRAM-PACKET-01", message: String((err as Error).message) },
    ]);
  }

  // Verify normative source hashes
  const hashViolations = verifyNormativeSources(workspaceRoot, packet);
  if (hashViolations.length > 0) {
    return sealFail(program, packetId, hashViolations.map((v) => ({
      rule: "PROGRAM-PACKET-07",
      path: v.path,
      message: `normative source hash mismatch: expected ${v.expected}, got ${v.actual}`,
    })));
  }

  // Git state
  let branch = "";
  let head = "";
  try {
    branch = gitBranch(workspaceRoot);
    head = gitHead(workspaceRoot);
  } catch {
    return sealFail(program, packetId, [
      { rule: "PROGRAM-PACKET-02", message: "failed to read git state" },
    ]);
  }

  // Check for active leases
  const activeLeases = findActiveLeases(workspaceRoot, program);
  const hasActiveLease = activeLeases.some(
    (l) => l.packetId === packetId && !isLeaseStale(l.lease),
  );

  let isClean = false;
  try {
    isClean = gitIsClean(workspaceRoot);
  } catch {
    // ignore
  }

  // Validate transition
  const violations = validateSealTransition(manifest, entry, packet, {
    branch,
    head,
    isClean,
    hasActiveLease,
  });

  if (violations.length > 0) {
    return sealFail(program, packetId, violations);
  }

  // --- Perform seal ---
  const filesModified: string[] = [];

  // 1. Update packet file: state → sealed, baseCommit → head (for non-bootstrap)
  const packetPath = resolvePacketPath(programDir, entry);
  const packetRaw = fs.readFileSync(packetPath, "utf8");
  const packetFmMatch = packetRaw.match(/^---\n([\s\S]*?)\n---/);
  if (!packetFmMatch) {
    return sealFail(program, packetId, [
      { rule: "PROGRAM-PACKET-01", message: "missing frontmatter in packet file" },
    ]);
  }
  const packetFm = parseYaml(packetFmMatch[1]) as Record<string, unknown>;
  packetFm.state = "sealed";
  if (entry.dependsOnPacket === null) {
    // Bootstrap packet: baseCommit stays null (set by completion)
  } else {
    packetFm.baseCommit = head;
  }
  const newPacketFm = stringifyYaml(packetFm);
  const newPacketRaw = `---\n${newPacketFm}---\n${packetRaw.slice(packetFmMatch[0].length)}`;
  writeFileAtomic(packetPath, newPacketRaw);
  filesModified.push(path.relative(workspaceRoot, packetPath));

  // 2. Update program manifest: packet state → sealed
  const manifestRaw = fs.readFileSync(manifestPath, "utf8");
  const manifestParsed = parseYaml(manifestRaw) as ProgramManifest;
  const packetIdx = manifestParsed.packets.findIndex((p) => p.packetId === packetId);
  if (packetIdx === -1) {
    return sealFail(program, packetId, [
      { rule: "PROGRAM-PACKET-01", message: "packet not found in manifest" },
    ]);
  }
  manifestParsed.packets[packetIdx].state = "sealed";
  if (entry.dependsOnPacket !== null) {
    manifestParsed.packets[packetIdx].baseCommit = head;
  }
  const newManifestRaw = stringifyYaml(manifestParsed);
  writeFileAtomic(manifestPath, newManifestRaw);
  filesModified.push(path.relative(workspaceRoot, manifestPath));

  return {
    data: {
      command: "program.packet.seal",
      status: "pass",
      program,
      packetId,
      filesModified,
      violations: [],
    },
    exitCode: 0,
    summary: `program.packet.seal: ${packetId} sealed on ${branch}@${head.slice(0, 8)}`,
  };
}

function sealFail(
  program: string,
  packetId: string,
  violations: PacketViolation[],
): ForgeCommandResult<SealResultData> {
  return {
    data: {
      command: "program.packet.seal",
      status: "fail",
      program,
      packetId,
      filesModified: [],
      violations,
    },
    exitCode: 1,
    summary: `program.packet.seal: ${packetId} failed with ${violations.length} violation(s)`,
  };
}
