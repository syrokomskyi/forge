// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./typescript-paths.ts";

describe("typescript-paths (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
