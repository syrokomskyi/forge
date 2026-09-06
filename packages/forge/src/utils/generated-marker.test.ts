// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./generated-marker.ts";

describe("utils/generated-marker (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
