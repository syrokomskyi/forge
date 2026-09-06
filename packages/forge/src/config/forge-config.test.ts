// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./forge-config.ts";

describe("forge-config (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
