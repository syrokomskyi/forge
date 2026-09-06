// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./doctor.ts";

describe("onboarding/doctor (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
