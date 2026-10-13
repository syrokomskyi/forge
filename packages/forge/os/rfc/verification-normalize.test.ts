// @vitest-environment node
import { describe, expect, test } from "vitest";

import { byteHashHex, normalizeProbes } from "./verification-evidence.ts";
import type { AcceptanceProbe } from "./types.ts";

const hash = (probes: AcceptanceProbe[]) => byteHashHex(normalizeProbes(probes));

describe("normalizeProbes — acceptanceHash identity (RFC-1271)", () => {
  test("key order inside a probe does not change the hash", () => {
    const a = [
      { probe: "file-exists", path: "src/a.ts", criterion: "AC-1" },
    ] as AcceptanceProbe[];
    const b = [
      { criterion: "AC-1", probe: "file-exists", path: "src/a.ts" },
    ] as unknown as AcceptanceProbe[];
    expect(hash(a)).toBe(hash(b));
  });

  test("a field unique to a LATER probe changes the hash (union-keys regression)", () => {
    // Regression: whitelisting keys from probes[0] only drops criterion/
    // pattern fields that exist solely on later probes — a retarget passes
    // undetected.
    const base = [
      { probe: "file-exists", path: "src/a.ts" },
      { probe: "file-contains", path: "src/b.ts", pattern: "alpha", criterion: "AC-2" },
    ] as AcceptanceProbe[];
    const retargeted = [
      { probe: "file-exists", path: "src/a.ts" },
      { probe: "file-contains", path: "src/b.ts", pattern: "alpha", criterion: "AC-9" },
    ] as AcceptanceProbe[];
    expect(hash(base)).not.toBe(hash(retargeted));
  });

  test("a nested expect/schemaInline field change changes the hash (deep-bind regression)", () => {
    // Regression: an array replacer whitelists keys recursively — nested
    // probe interiors (expect.exitCode, schemaInline) serialize as {} and
    // never reach acceptanceHash.
    const base = [
      { probe: "run", command: "werkstatt run x.validate", expect: { exitCode: 0 }, criterion: "AC-1" },
    ] as AcceptanceProbe[];
    const nestedChanged = [
      { probe: "run", command: "werkstatt run x.validate", expect: { exitCode: 1 }, criterion: "AC-1" },
    ] as AcceptanceProbe[];
    expect(hash(base)).not.toBe(hash(nestedChanged));

    const schemaA = [
      { probe: "json-schema", artifact: "out.json", schemaInline: { type: "object" } },
    ] as AcceptanceProbe[];
    const schemaB = [
      { probe: "json-schema", artifact: "out.json", schemaInline: { type: "array" } },
    ] as AcceptanceProbe[];
    expect(hash(schemaA)).not.toBe(hash(schemaB));
  });

  test("probe ordering changes the hash (list identity is ordered)", () => {
    const p1 = { probe: "file-exists", path: "src/a.ts" } as AcceptanceProbe;
    const p2 = { probe: "file-exists", path: "src/b.ts" } as AcceptanceProbe;
    expect(hash([p1, p2])).not.toBe(hash([p2, p1]));
  });
});
