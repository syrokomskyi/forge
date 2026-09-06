// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./phantom-deps-validate.ts";

describe("phantom-deps-validate (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
