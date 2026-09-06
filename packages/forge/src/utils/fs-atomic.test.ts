// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./fs-atomic.ts";

describe("utils/fs-atomic (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
