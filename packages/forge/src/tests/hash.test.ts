import { test, expect, describe } from "vitest";
import { byteHash } from "../utils/hash.ts";

describe("byteHash", () => {
  test("returns sha256-prefixed hex string", () => {
    const result = byteHash("hello");
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("is deterministic for same input", () => {
    expect(byteHash("test")).toBe(byteHash("test"));
  });

  test("differs for different input", () => {
    expect(byteHash("a")).not.toBe(byteHash("b"));
  });

  test("accepts Uint8Array", () => {
    const data = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    expect(byteHash(data)).toBe(byteHash("hello"));
  });

  test("matches known SHA-256 value", () => {
    // SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(byteHash("hello")).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("empty string produces valid hash", () => {
    expect(byteHash("")).toMatch(/^sha256:[0-9a-f]{64}$/);
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(byteHash("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
