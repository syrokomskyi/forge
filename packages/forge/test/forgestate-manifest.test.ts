import { describe, expect, it } from "vitest";

import { verifyManifest } from "../src/sdk/loader.js";

describe("forgeState capability declaration", () => {
  const base = {
    schema: "forge:plugin-manifest/v1",
    id: "test-plugin",
    version: "0.1.0",
    forgeRange: ">=10.2.0",
  };

  it("accepts forgeState: read (regression: capability-unknown rejection)", () => {
    const m = verifyManifest(
      { ...base, capabilities: { filesystem: "read", forgeState: "read" } },
      "/tmp/whatever",
    );
    expect(m.capabilities?.forgeState).toBe("read");
  });

  it("still rejects genuinely unknown capabilities", () => {
    expect(() =>
      verifyManifest({ ...base, capabilities: { teleport: true } }, "/tmp/whatever"),
    ).toThrow(/unknown capability/);
  });
});
