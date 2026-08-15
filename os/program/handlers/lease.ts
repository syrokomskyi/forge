/*
<MODULE_CONTRACT>
<purpose>Command handler for program.packet.lease — manages the exclusive
local executor lease for a sealed packet. Supports start, heartbeat, release,
and recover actions (RFC-0856).</purpose>
<non-goals>
  <item>Do not store raw lease tokens — only the hash is persisted.</item>
  <item>Do not commit — lease files are untracked.</item>
  <item>Do not import from @warpgogol/* — forge must remain dependency-free.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0856: initial lease command handler.</item>
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
  gitHead,
} from "../discovery.ts";
import {
  generateLeaseToken,
  hashLeaseToken,
  readLease,
  writeLease,
  deleteLease,
  findActiveLeases,
  isLeaseStale,
  updateHeartbeat,
} from "../lease.ts";
import type { ProgramPacketLease } from "../schemas.ts";
import { validateLeaseStartTransition, type PacketViolation } from "../state.ts";
import type { ProgramManifest, RecoveryRecord } from "../schemas.ts";

export interface LeaseResultData {
  command: string;
  status: "pass" | "fail";
  program: string;
  packetId: string;
  action: string;
  leaseToken?: string;
  violations: PacketViolation[];
}

const DEFAULT_TIMEOUT_SECONDS = 3600; // 1 hour

export async function runLease(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<LeaseResultData>> {
  const program = input.flags.program as string | undefined;
  const packetId = input.flags.packet as string | undefined;
  const action = input.flags.action as string | undefined;

  if (!program || !packetId || !action) {
    return leaseFail(program ?? "<missing>", packetId ?? "<missing>", action ?? "<missing>", [
      { rule: "PROGRAM-PACKET-01", message: "--program, --packet, and --action are required" },
    ]);
  }

  switch (action) {
    case "start":
      return leaseStart(input, context, program, packetId);
    case "heartbeat":
      return leaseHeartbeat(context, program, packetId, input);
    case "release":
      return leaseRelease(context, program, packetId, input);
    case "recover":
      return leaseRecover(input, context, program, packetId);
    default:
      return leaseFail(program, packetId, action, [
        { rule: "PROGRAM-PACKET-01", message: `unknown action: ${action}` },
      ]);
  }
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function leaseStart(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
  program: string,
  packetId: string,
): Promise<ForgeCommandResult<LeaseResultData>> {
  const executor = input.flags.executor as string | undefined;
  if (!executor) {
    return leaseFail(program, packetId, "start", [
      { rule: "PROGRAM-PACKET-01", message: "--executor is required for --action=start" },
    ]);
  }

  const { workspaceRoot } = context;

  // Discover program
  let programLocation;
  try {
    programLocation = discoverProgram(workspaceRoot, program);
  } catch (err) {
    return leaseFail(program, packetId, "start", [
      { rule: "PROGRAM-PACKET-01", message: String((err as Error).message) },
    ]);
  }
  if (!programLocation) {
    return leaseFail(program, packetId, "start", [
      { rule: "PROGRAM-PACKET-01", message: `program ${program} not found` },
    ]);
  }

  const { manifest, programDir } = programLocation;
  const entry = findPacketEntry(manifest, packetId);
  if (!entry) {
    return leaseFail(program, packetId, "start", [
      { rule: "PROGRAM-PACKET-01", message: `packet ${packetId} not found` },
    ]);
  }

  let packet;
  try {
    packet = parsePacketFile(resolvePacketPath(programDir, entry));
  } catch (err) {
    return leaseFail(program, packetId, "start", [
      { rule: "PROGRAM-PACKET-01", message: String((err as Error).message) },
    ]);
  }

  // Check for existing leases
  const activeLeases = findActiveLeases(workspaceRoot, program);
  const hasActiveLease = activeLeases.some(
    (l) => l.packetId === packetId && !isLeaseStale(l.lease),
  );

  let head = "";
  try {
    head = gitHead(workspaceRoot);
  } catch {
    return leaseFail(program, packetId, "start", [
      { rule: "PROGRAM-PACKET-02", message: "failed to read git HEAD" },
    ]);
  }

  const violations = validateLeaseStartTransition(manifest, entry, packet, {
    head,
    steward: packet.steward,
    executor: executor as ProgramPacketLease["executor"],
    hasActiveLease,
  });

  if (violations.length > 0) {
    return leaseFail(program, packetId, "start", violations);
  }

  // Generate lease
  const rawToken = generateLeaseToken();
  const tokenHash = hashLeaseToken(rawToken);
  const now = new Date().toISOString();

  const lease: ProgramPacketLease = {
    schema: "forge/program-packet-lease@1",
    program,
    packetId,
    sealCommit: entry.sealCommit ?? head,
    executor: executor as ProgramPacketLease["executor"],
    tokenHash,
    startedAt: now,
    heartbeatAt: now,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };

  writeLease(workspaceRoot, program, lease);

  // Return raw token ONLY in data.leaseToken — never in logs.
  return {
    data: {
      command: "program.packet.lease",
      status: "pass",
      program,
      packetId,
      action: "start",
      leaseToken: rawToken,
      violations: [],
    },
    exitCode: 0,
    summary: `program.packet.lease: ${packetId} lease started for ${executor}`,
  };
}

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

async function leaseHeartbeat(
  context: ForgeRuntimeContext,
  program: string,
  packetId: string,
  input: ForgeCommandInput,
): Promise<ForgeCommandResult<LeaseResultData>> {
  const leaseToken = input.flags["lease-token"] as string | undefined;
  if (!leaseToken) {
    return leaseFail(program, packetId, "heartbeat", [
      { rule: "PROGRAM-PACKET-01", message: "--lease-token is required for --action=heartbeat" },
    ]);
  }

  const { workspaceRoot } = context;
  const existing = readLease(workspaceRoot, program, packetId);
  if (!existing) {
    return leaseFail(program, packetId, "heartbeat", [
      { rule: "PROGRAM-PACKET-05", message: "no lease found" },
    ]);
  }

  const tokenHash = hashLeaseToken(leaseToken);
  if (tokenHash !== existing.tokenHash) {
    return leaseFail(program, packetId, "heartbeat", [
      { rule: "PROGRAM-PACKET-11", message: "token mismatch" },
    ]);
  }

  updateHeartbeat(workspaceRoot, program, packetId);

  return {
    data: {
      command: "program.packet.lease",
      status: "pass",
      program,
      packetId,
      action: "heartbeat",
      violations: [],
    },
    exitCode: 0,
    summary: `program.packet.lease: ${packetId} heartbeat updated`,
  };
}

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

async function leaseRelease(
  context: ForgeRuntimeContext,
  program: string,
  packetId: string,
  input: ForgeCommandInput,
): Promise<ForgeCommandResult<LeaseResultData>> {
  const leaseToken = input.flags["lease-token"] as string | undefined;
  if (!leaseToken) {
    return leaseFail(program, packetId, "release", [
      { rule: "PROGRAM-PACKET-01", message: "--lease-token is required for --action=release" },
    ]);
  }

  const { workspaceRoot } = context;
  const existing = readLease(workspaceRoot, program, packetId);
  if (!existing) {
    return leaseFail(program, packetId, "release", [
      { rule: "PROGRAM-PACKET-05", message: "no lease found" },
    ]);
  }

  const tokenHash = hashLeaseToken(leaseToken);
  if (tokenHash !== existing.tokenHash) {
    return leaseFail(program, packetId, "release", [
      { rule: "PROGRAM-PACKET-11", message: "token mismatch" },
    ]);
  }

  deleteLease(workspaceRoot, program, packetId);

  return {
    data: {
      command: "program.packet.lease",
      status: "pass",
      program,
      packetId,
      action: "release",
      violations: [],
    },
    exitCode: 0,
    summary: `program.packet.lease: ${packetId} lease released`,
  };
}

// ---------------------------------------------------------------------------
// recover
// ---------------------------------------------------------------------------

async function leaseRecover(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
  program: string,
  packetId: string,
): Promise<ForgeCommandResult<LeaseResultData>> {
  const steward = input.flags.steward as string | undefined;
  const reason = input.flags.reason as string | undefined;
  if (!steward || !reason) {
    return leaseFail(program, packetId, "recover", [
      {
        rule: "PROGRAM-PACKET-01",
        message: "--steward and --reason are required for --action=recover",
      },
    ]);
  }

  const { workspaceRoot } = context;
  const existing = readLease(workspaceRoot, program, packetId);
  if (!existing) {
    return leaseFail(program, packetId, "recover", [
      { rule: "PROGRAM-PACKET-05", message: "no lease to recover" },
    ]);
  }

  // Only recover stale leases
  if (!isLeaseStale(existing)) {
    return leaseFail(program, packetId, "recover", [
      { rule: "PROGRAM-PACKET-05", message: "lease is not stale — cannot recover active lease" },
    ]);
  }

  // Write recovery record
  const recoveryDir = path.join(
    workspaceRoot,
    "docs",
    "plans",
    programLocationDir(workspaceRoot, program),
    "recoveries",
  );
  fs.mkdirSync(recoveryDir, { recursive: true });

  const head = gitHead(workspaceRoot);
  const recovery: RecoveryRecord = {
    schema: "forge/program-packet-recovery@1",
    program,
    packetId,
    previousLeaseDigest: existing.tokenHash,
    reason,
    actor: steward as RecoveryRecord["actor"],
    observedHead: head,
    target: "blocked",
    recoveredAt: new Date().toISOString(),
  };

  const recoveryPath = path.join(recoveryDir, `${packetId}-${Date.now()}.json`);
  writeFileAtomic(recoveryPath, JSON.stringify(recovery, null, 2) + "\n");

  // Delete the stale lease
  deleteLease(workspaceRoot, program, packetId);

  // Update manifest: packet state → blocked
  const manifestPath = path.join(
    workspaceRoot,
    "docs",
    "plans",
    programLocationDir(workspaceRoot, program),
    "program.yaml",
  );
  const manifestRaw = fs.readFileSync(manifestPath, "utf8");
  const manifestParsed = parseYaml(manifestRaw) as ProgramManifest;
  const idx = manifestParsed.packets.findIndex((p) => p.packetId === packetId);
  if (idx !== -1) {
    manifestParsed.packets[idx].state = "blocked";
    writeFileAtomic(manifestPath, stringifyYaml(manifestParsed));
  }

  return {
    data: {
      command: "program.packet.lease",
      status: "pass",
      program,
      packetId,
      action: "recover",
      violations: [],
    },
    exitCode: 0,
    summary: `program.packet.lease: ${packetId} recovered (stale lease cleared, recovery record written)`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function programLocationDir(workspaceRoot: string, program: string): string {
  // Find the directory name under docs/plans/ that contains this program
  const plansDir = path.join(workspaceRoot, "docs", "plans");
  if (!fs.existsSync(plansDir)) return program;
  for (const entry of fs.readdirSync(plansDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(plansDir, entry.name, "program.yaml");
    if (!fs.existsSync(manifestPath)) continue;
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    if (parsed.program === program) return entry.name;
  }
  return program;
}

function leaseFail(
  program: string,
  packetId: string,
  action: string,
  violations: PacketViolation[],
): ForgeCommandResult<LeaseResultData> {
  return {
    data: {
      command: "program.packet.lease",
      status: "fail",
      program,
      packetId,
      action,
      violations,
    },
    exitCode: 1,
    summary: `program.packet.lease: ${packetId} ${action} failed with ${violations.length} violation(s)`,
  };
}
