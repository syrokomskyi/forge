// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./parse.ts";

describe("knowledge parse (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
