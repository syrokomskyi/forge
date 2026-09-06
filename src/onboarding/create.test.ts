// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./create.ts";

describe("onboarding/create (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
