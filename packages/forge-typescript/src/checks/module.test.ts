// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./module.ts";

describe("typescript-checks module (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
