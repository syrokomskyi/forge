// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./package-exports-validate.ts";

describe("package-exports-validate (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
