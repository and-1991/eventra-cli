import { describe, expect, it } from "vitest";
import { hash } from "../../src/shared/hash";

describe("hash", () => {
  it("returns a stable md5 hex string", () => {
    expect(hash("hello")).toMatch(/^[a-f0-9]{32}$/);
    expect(hash("hello")).toBe(hash("hello"));
  });

  it("returns different digests for different inputs", () => {
    expect(hash("a")).not.toBe(hash("b"));
  });
});
