// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./contract-registry.ts";

describe("contract-registry (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
