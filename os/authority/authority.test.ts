/*
<MODULE_CONTRACT>
<purpose>RFC-1336: authority module tests — delegation schema, loader
absence-tolerance/fail-closed parse, resolveDelegation matching matrix
(scope/site/agent/grantedBy/expiry/revocation), delegationActor wildcard
binding, signature round-trip, and the delegate/revoke command handlers.</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1336: initial test suite.</item>
  <item>RFC-1336: step 1: forge authority module — delegation registry schema + resolver, four authority.* commands, optional Ed25519 signing</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  delegationActor,
  delegationEntrySchema,
  loadDelegations,
  resolveDelegation,
  type AuthorityDelegations,
  type DelegationEntry,
} from "../../src/authority/delegations.ts";
import {
  canonicalJson,
  signDelegationPayload,
  verifyDelegationSignature,
} from "../../src/authority/signing.ts";
import { runAuthorityDelegate } from "./handlers/delegate.ts";
import { runAuthorityDelegateRevoke } from "./handlers/delegate-revoke.ts";
import { runAuthorityDelegationValidate } from "./handlers/delegation-validate.ts";
import type { ForgeCommandInput, ForgeFlagValue, ForgeRuntimeContext } from "../../src/types.ts";

let tmpDir: string;
let sandboxDir: string;

const LOG = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

function cmd(flags: Record<string, ForgeFlagValue>): ForgeCommandInput {
  return { argv: [], flags };
}

function ctx(extra?: Partial<ForgeRuntimeContext>): ForgeRuntimeContext {
  return {
    workspaceRoot: tmpDir,
    logger: LOG,
    dryRun: false,
    outputFormat: "json",
    ...extra,
  };
}

function grant(partial: Partial<DelegationEntry> = {}): DelegationEntry {
  return delegationEntrySchema.parse({
    id: "del-0001",
    scope: "editorial.signoff",
    grantedTo: "agent:devin",
    grantedBy: "human:andrii",
    sites: ["acme"],
    grantedAt: "2026-10-19T10:00:00.000Z",
    ...partial,
  });
}

function registry(entries: DelegationEntry[]): AuthorityDelegations {
  return { schema: "forge/authority-delegations@1", delegations: entries };
}

beforeEach(async () => {
  // systems-cache/<id> is a sibling of the workspace root (RFC-0790 layout).
  sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "authority-test-"));
  tmpDir = path.join(sandboxDir, "workshop");
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(path.join(sandboxDir, "systems-cache", "acme"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(sandboxDir, { recursive: true, force: true });
});

describe("delegationEntrySchema", () => {
  test("round-trips a full entry", () => {
    const entry = grant({ note: "ship unattended", expiresAt: "2026-11-01T00:00:00.000Z" });
    expect(entry.id).toBe("del-0001");
    expect(entry.sites).toEqual(["acme"]);
  });

  test("rejects a human grantee — humans never need delegation", () => {
    const result = delegationEntrySchema.safeParse({ ...grant(), grantedTo: "human:x" });
    expect(result.success).toBe(false);
  });

  test("rejects a non-human grantor — provenance must name a human", () => {
    const result = delegationEntrySchema.safeParse({ ...grant(), grantedBy: "agent:devin" });
    expect(result.success).toBe(false);
  });
});

describe("loadDelegations", () => {
  test("absent registry resolves to zero delegations (RFC-1336 unchanged behavior)", async () => {
    const r = await loadDelegations(tmpDir);
    expect(r.delegations).toEqual([]);
  });

  test("corrupted registry throws — gates must never fail open", async () => {
    await fs.writeFile(path.join(tmpDir, "authority.delegations.yaml"), "delegations: [unclosed\n");
    await expect(loadDelegations(tmpDir)).rejects.toThrow(/authority\.delegations\.yaml/);
  });
});

describe("resolveDelegation", () => {
  const base = {
    scope: "editorial.signoff",
    agent: "agent:devin",
    site: "acme",
  };

  test("matches an active grant", () => {
    expect(resolveDelegation(registry([grant()]), base)?.id).toBe("del-0001");
  });

  test("no registry grant → null (the missing-delegation error path)", () => {
    expect(resolveDelegation(registry([]), base)).toBeNull();
  });

  test("revoked grant does not match", () => {
    const g = grant({ revokedAt: "2026-10-19T12:00:00.000Z" });
    expect(resolveDelegation(registry([g]), base)).toBeNull();
  });

  test("expired grant does not match", () => {
    const g = grant({ expiresAt: "2026-01-01T00:00:00.000Z" });
    expect(resolveDelegation(registry([g]), base, new Date("2026-10-19"))).toBeNull();
  });

  test("wrong-site grant does not match a site query", () => {
    const g = grant({ sites: ["other-site"] });
    expect(resolveDelegation(registry([g]), base)).toBeNull();
  });

  test("workspace grant covers every site", () => {
    const g = grant({ sites: "workspace" });
    expect(resolveDelegation(registry([g]), { ...base, site: "anywhere" })?.id).toBe("del-0001");
  });

  test("site-listed grant does not cover a site-less workspace query", () => {
    const g = grant({ sites: ["acme"] });
    expect(resolveDelegation(registry([g]), { ...base, site: undefined })).toBeNull();
  });

  test("agent mismatch does not match; wildcard does", () => {
    const specific = grant({ grantedTo: "agent:other" });
    expect(resolveDelegation(registry([specific]), base)).toBeNull();
    const wild = grant({ grantedTo: "agent:*" });
    expect(resolveDelegation(registry([wild]), base)?.id).toBe("del-0001");
  });

  test("grantedBy binding rejects a grant from a different human (audit F2)", () => {
    const g = grant({ grantedBy: "human:mallory" });
    expect(resolveDelegation(registry([g]), { ...base, grantedBy: "human:andrii" })).toBeNull();
  });

  test("most recent matching grant wins", () => {
    const older = grant({ id: "del-0001", grantedAt: "2026-10-01T00:00:00.000Z" });
    const newer = grant({ id: "del-0002", grantedAt: "2026-10-15T00:00:00.000Z" });
    expect(resolveDelegation(registry([older, newer]), base)?.id).toBe("del-0002");
  });
});

describe("delegationActor", () => {
  test("explicit grant names its actor", () => {
    expect(delegationActor(grant())).toBe("agent:devin");
  });

  test("wildcard requires a session agent id", () => {
    const wild = grant({ grantedTo: "agent:*" });
    expect(delegationActor(wild, "agent:devin")).toBe("agent:devin");
    expect(delegationActor(wild)).toBeNull();
    expect(delegationActor(wild, "not-an-agent")).toBeNull();
  });
});

describe("signing", () => {
  const seed = "ab".repeat(32);

  test("round-trips a signature over the canonical payload", () => {
    const payload = canonicalJson({ scope: "x", id: "del-0001" });
    const sig = `ed25519:${signDelegationPayload(seed, payload)}`;
    expect(verifyDelegationSignature(sig, payload)).toBe(true);
    expect(verifyDelegationSignature(sig, payload + "x")).toBe(false);
  });
});

describe("authority.delegate", () => {
  test("writes a site-scoped grant and serializes the registry", async () => {
    const res = await runAuthorityDelegate(
      cmd({
        scope: "editorial.signoff",
        to: "agent:devin",
        by: "human:andrii",
        site: ["acme"],
      }),
      ctx(),
    );
    expect(res.data?.delegation?.id).toBe("del-0001");
    const reloaded = await loadDelegations(tmpDir);
    expect(reloaded.delegations).toHaveLength(1);
    expect(reloaded.delegations[0]?.grantedBy).toBe("human:andrii");
    expect(res.data?.bordbuch?.skipped).toBe(true); // no kernel host in tests
  });

  test("absent --site means a workspace grant", async () => {
    const res = await runAuthorityDelegate(
      cmd({ scope: "rfc.decision", to: "agent:devin", by: "human:andrii" }),
      ctx(),
    );
    expect(res.data?.delegation?.sites).toBe("workspace");
  });

  test("rejects a non-delegable scope before any write", async () => {
    await expect(
      runAuthorityDelegate(
        cmd({ scope: "sternsystem.handover", to: "agent:devin", by: "human:andrii" }),
        ctx(),
      ),
    ).rejects.toThrow(/non-delegable/);
    expect((await loadDelegations(tmpDir)).delegations).toHaveLength(0);
  });

  test("rejects an unknown site", async () => {
    await expect(
      runAuthorityDelegate(
        cmd({
          scope: "editorial.signoff",
          to: "agent:devin",
          by: "human:andrii",
          site: ["ghost"],
        }),
        ctx(),
      ),
    ).rejects.toThrow(/ghost/);
  });

  test("rejects a human grantee identity", async () => {
    await expect(
      runAuthorityDelegate(
        cmd({ scope: "editorial.signoff", to: "human:andrii", by: "human:andrii" }),
        ctx(),
      ),
    ).rejects.toThrow(/agent/);
  });
});

describe("authority.delegate.revoke", () => {
  test("revokes an active grant; a second run is an idempotent no-op", async () => {
    await runAuthorityDelegate(
      cmd({ scope: "version.major", to: "agent:devin", by: "human:andrii" }),
      ctx(),
    );
    const res = await runAuthorityDelegateRevoke(
      cmd({ id: "del-0001", by: "human:andrii" }),
      ctx(),
    );
    expect(res.data?.revokedAt).toBeTruthy();
    const reloaded = await loadDelegations(tmpDir);
    expect(reloaded.delegations[0]?.revokedAt).toBeTruthy();
    expect(reloaded.delegations[0]?.revokedBy).toBe("human:andrii");

    const again = await runAuthorityDelegateRevoke(cmd({ id: "del-0001" }), ctx());
    expect(again.data?.alreadyRevoked).toBe(true);
    expect(again.exitCode).toBe(0);
  });

  test("revoking an unknown id fails", async () => {
    await expect(runAuthorityDelegateRevoke(cmd({ id: "del-9999" }), ctx())).rejects.toThrow(
      /del-9999/,
    );
  });
});

describe("authority.delegation.validate", () => {
  test("absent registry passes clean", async () => {
    const res = await runAuthorityDelegationValidate(cmd({}), ctx());
    expect(res.data?.status).toBe("pass");
    expect(res.exitCode).toBe(0);
  });

  test("agent:* wildcard warns (DELEG-06) without failing", async () => {
    await runAuthorityDelegate(
      cmd({ scope: "rfc.decision", to: "agent:*", by: "human:andrii" }),
      ctx(),
    );
    const res = await runAuthorityDelegationValidate(cmd({}), ctx());
    expect(res.data?.status).toBe("pass");
    expect(res.data?.warnings.some((w) => w.ruleId === "DELEG-06")).toBe(true);
  });

  test("non-delegable scope in registry is DELEG-04", async () => {
    await fs.writeFile(
      path.join(tmpDir, "authority.delegations.yaml"),
      [
        "schema: forge/authority-delegations@1",
        "delegations:",
        "  - id: del-0001",
        "    scope: sternsystem.handover",
        "    grantedTo: agent:devin",
        "    grantedBy: human:andrii",
        "    sites: workspace",
        "    grantedAt: '2026-10-19T10:00:00Z'",
      ].join("\n"),
    );
    const res = await runAuthorityDelegationValidate(cmd({}), ctx());
    expect(res.data?.status).toBe("fail");
    expect(res.data?.errors.some((e) => e.ruleId === "DELEG-04")).toBe(true);
  });
});
