// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./forge-module.ts";

describe("forge-module (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
