// Anchor smoke test so `vitest run` has at least one suite in Phase 1.
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
