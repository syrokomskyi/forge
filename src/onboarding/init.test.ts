// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./init.ts";

describe("onboarding/init (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
