// @vitest-environment node

import { describe, expect, it } from "vitest";

import { byteHash } from "./hash.ts";

describe("byteHash", () => {
  it("produces a sha256-prefixed hex digest for a string", () => {
    const hash = byteHash("test");
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("produces a sha256-prefixed hex digest for bytes", () => {
    const hash = byteHash(new Uint8Array([1, 2, 3]));
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic for same input", () => {
    expect(byteHash("abc")).toBe(byteHash("abc"));
  });

  it("produces different hashes for different inputs", () => {
    expect(byteHash("abc")).not.toBe(byteHash("abd"));
  });
});
