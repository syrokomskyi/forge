// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./tsconfig-validate.ts";

describe("tsconfig-validate (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
