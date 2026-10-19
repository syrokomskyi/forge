/*
<MODULE_CONTRACT>
<purpose>RFC-1336: optional Ed25519 provenance signatures on delegation
entries (`authority.delegate --sign`). Signs the canonical JSON of the
entry under SIGNING_PRIVATE_KEY (hex-encoded 32-byte seed — the same
convention as werkstatt-shared/signing) and stores
"ed25519:<publicKeyHex>:<signatureHex>". Implemented on node:crypto —
forge carries no @noble dependency (FORGE-AUTONOMY-01).</purpose>
<non-goals>
  <item>Does not turn the registry into a security boundary — the signature is provenance evidence; the entry's authority still flows from declared policy.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1336: initial module — seed→PKCS8 reconstruction, canonical JSON, sign/verify.</item>
  <item>RFC-1336: step 1: forge authority module — delegation registry schema + resolver, four authority.* commands, optional Ed25519 signing</item>
</CHANGE_SUMMARY>
*/

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

/** PKCS8 DER prefix wrapping a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** SPKI DER prefix wrapping a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Deterministic sorted-key serialization — the signature's signed payload. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

export function publicKeyHexFromSeed(privateKeyHex: string): string {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(privateKeyHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url").toString("hex");
}

/** Sign a payload with a hex-encoded Ed25519 seed; returns "<pubHex>:<sigHex>". */
export function signDelegationPayload(privateKeyHex: string, payload: string): string {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(privateKeyHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, Buffer.from(payload, "utf8"), key);
  return `${publicKeyHexFromSeed(privateKeyHex)}:${signature.toString("hex")}`;
}

/** Verify a "ed25519:<pubHex>:<sigHex>"-shaped signature against a payload. */
export function verifyDelegationSignature(signature: string, payload: string): boolean {
  const bare = signature.startsWith("ed25519:") ? signature.slice("ed25519:".length) : signature;
  const [pubHex, sigHex] = bare.split(":");
  if (!pubHex || !sigHex || pubHex.length !== 64 || sigHex.length !== 128) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}
