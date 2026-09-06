// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./compact.ts";

describe("knowledge compact (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
