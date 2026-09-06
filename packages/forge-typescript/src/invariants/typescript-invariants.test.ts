// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./typescript-invariants.ts";

describe("typescript-invariants (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
