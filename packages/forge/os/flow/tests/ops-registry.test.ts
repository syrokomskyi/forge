/*
<MODULE_CONTRACT>
<purpose>ops-registry tests (RFC-1543 AC-2/AC-5): claim write lands under the
shared git dir, liveness requires pid-alive ∧ bootId-match ∧ fresh heartbeat,
dead records are swept by the next reader, and claimCoversPath honors the
exact/prefix contract.</purpose>
<non-goals>
  <item>No classifyDirt coverage — claim→class wiring lives in dirty-classify.test.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1543: op-claim registry probes</item>
  <item>RFC-1543: attribute shared-checkout dirt to live ops and expose peers (RFC-1543)</item>
</CHANGE_SUMMARY>
*/

import { rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import {
  claimCoversPath,
  claimOp,
  isClaimLive,
  liveClaims,
  OP_CLAIM_SCHEMA,
  releaseOp,
} from "../ops-registry.ts";
import { initRepo } from "./helpers.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function repo(): Promise<string> {
  const dir = await initRepo({ prefix: "ops-reg-" });
  dirs.push(dir);
  return dir;
}

async function opsDir(repo: string): Promise<string> {
  return join(repo, ".git", "forge", "ops");
}

describe("ops-registry — claim lifecycle (RFC-1543 AC-2)", () => {
  it("claimOp writes a forge/op-claim@1 record the reader reports live", async () => {
    const r = await repo();
    const ok = await claimOp(r, ambientIo, {
      opId: "op-1",
      command: "leitstand.ship",
      workspaceRoot: r,
      paths: ["docs/", "pnpm-lock.yaml"],
    });
    expect(ok).toBe(true);

    const live = await liveClaims(r, ambientIo);
    expect(live).toHaveLength(1);
    expect(live[0]?.schema).toBe(OP_CLAIM_SCHEMA);
    expect(live[0]?.pid).toBe(process.pid);
    expect(live[0]?.paths).toEqual(["docs/", "pnpm-lock.yaml"]);
    expect(live[0]?.bootId).toBeDefined();
  });

  it("releaseOp removes the record; a dead pid is swept on read", async () => {
    const r = await repo();
    await claimOp(r, ambientIo, {
      opId: "op-2",
      command: "ecosystem.commit",
      workspaceRoot: r,
      paths: ["docs/"],
    });
    await releaseOp(r, ambientIo, "op-2");
    expect(await liveClaims(r, ambientIo)).toEqual([]);

    // Hand-write a claim on a pid that cannot be alive.
    const ops = await opsDir(r);
    await mkdir(ops, { recursive: true });
    await writeFile(
      join(ops, "zombie.yaml"),
      [
        `schema: ${OP_CLAIM_SCHEMA}`,
        "opId: zombie",
        "command: mission.git.commit",
        "pid: 999999999",
        `host: ${(await import("node:os")).hostname()}`,
        "startedAt: 2026-11-09T00:00:00Z",
        "heartbeatAt: 2026-11-09T00:00:00Z",
        `workspaceRoot: ${r}`,
        "paths: [docs/]",
      ].join("\n"),
    );
    expect(await liveClaims(r, ambientIo)).toEqual([]);
    // Dead record was swept, not just filtered.
    expect(await ambientIo.exists(join(ops, "zombie.yaml"))).toBe(false);
  });

  it("an expired heartbeat disqualifies an otherwise-live pid", async () => {
    const r = await repo();
    const stale: import("../ops-registry.ts").OpClaim = {
      schema: OP_CLAIM_SCHEMA,
      opId: "stale-beat",
      command: "x",
      pid: process.pid,
      host: (await import("node:os")).hostname(),
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
      workspaceRoot: r,
      paths: ["docs/"],
    };
    expect(isClaimLive({ ...stale })).toBe(false);
    expect(isClaimLive({ ...stale, heartbeatAt: new Date().toISOString() })).toBe(true);
  });

  it("claimCoversPath matches exact paths and declared prefixes only", () => {
    const claim: import("../ops-registry.ts").OpClaim = {
      schema: OP_CLAIM_SCHEMA,
      opId: "c",
      command: "x",
      pid: 1,
      host: "h",
      startedAt: "t",
      heartbeatAt: "t",
      workspaceRoot: "/w",
      paths: ["docs/", "pnpm-lock.yaml"],
    };
    expect(claimCoversPath(claim, "pnpm-lock.yaml")).toBe(true);
    expect(claimCoversPath(claim, "docs/rfcs/x.md")).toBe(true);
    expect(claimCoversPath(claim, "docs")).toBe(false); // a FILE named docs is not under docs/
    expect(claimCoversPath(claim, "documentation/x.md")).toBe(false);
    expect(claimCoversPath(claim, "src/docs/x.ts")).toBe(false);
  });
});
