// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./upgrade.ts";

describe("onboarding/upgrade (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
