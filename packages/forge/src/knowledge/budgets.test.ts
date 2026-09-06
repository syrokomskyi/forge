// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./budgets.ts";

describe("knowledge budgets (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
