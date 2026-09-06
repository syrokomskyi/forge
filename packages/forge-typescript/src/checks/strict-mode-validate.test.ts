// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./strict-mode-validate.ts";

describe("strict-mode-validate (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
