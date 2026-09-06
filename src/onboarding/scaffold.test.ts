// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./scaffold.ts";

describe("onboarding/scaffold (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
