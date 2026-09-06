// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./diagnostic-helpers.ts";

describe("diagnostic-helpers (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
