import { describe, expect, it } from "vitest";

import {
  EVENTRA_SDK_PACKAGE,
  EVENTRA_SDK_SHIM,
  MAX_EVENT_NAME_LENGTH,
  isEventraSdkModuleSpecifier,
  isValidEventName,
  normalizeEventName,
} from "../../src/analysis/sdk/eventraSdk";

describe("isEventraSdkModuleSpecifier", () => {
  it("matches the exact package specifier", () => {
    expect(isEventraSdkModuleSpecifier(EVENTRA_SDK_PACKAGE)).toBe(true);
  });

  it("matches a deep subpath of the package", () => {
    expect(isEventraSdkModuleSpecifier(`${EVENTRA_SDK_PACKAGE}/dist/client`)).toBe(true);
  });

  it("normalizes backslash path separators before comparing", () => {
    // A specifier using backslashes as separators for a genuine subpath still matches once normalized.
    expect(isEventraSdkModuleSpecifier("@eventra_dev\\eventra-sdk\\dist\\client")).toBe(true);
  });

  it("rejects an unrelated module specifier", () => {
    expect(isEventraSdkModuleSpecifier("some-other-package")).toBe(false);
  });

  it("rejects a specifier that merely starts with the same characters but isn't a subpath", () => {
    expect(isEventraSdkModuleSpecifier(`${EVENTRA_SDK_PACKAGE}-extra`)).toBe(false);
  });
});

describe("normalizeEventName", () => {
  it("returns the trimmed value for a valid name", () => {
    expect(normalizeEventName("  user.signup  ")).toBe("user.signup");
  });

  it("accepts every allowed character class", () => {
    expect(normalizeEventName("Event_Name-1:2.3/4")).toBe("Event_Name-1:2.3/4");
  });

  it("rejects an empty (or whitespace-only) value", () => {
    expect(normalizeEventName("")).toBeNull();
    expect(normalizeEventName("   ")).toBeNull();
  });

  it("rejects a value longer than the max length", () => {
    const tooLong = "a".repeat(MAX_EVENT_NAME_LENGTH + 1);
    expect(normalizeEventName(tooLong)).toBeNull();
  });

  it("accepts a value exactly at the max length", () => {
    const exact = "a".repeat(MAX_EVENT_NAME_LENGTH);
    expect(normalizeEventName(exact)).toBe(exact);
  });

  it("rejects a value with disallowed characters", () => {
    expect(normalizeEventName("user signup!")).toBeNull();
    expect(normalizeEventName("emoji🎉event")).toBeNull();
  });
});

describe("isValidEventName", () => {
  it("returns true for a valid event name", () => {
    expect(isValidEventName("checkout.completed")).toBe(true);
  });

  it("returns false for an invalid event name", () => {
    expect(isValidEventName("")).toBe(false);
    expect(isValidEventName("has space")).toBe(false);
  });
});

describe("EVENTRA_SDK_SHIM", () => {
  it("declares the SDK module with a track() method", () => {
    expect(EVENTRA_SDK_SHIM).toContain(`declare module "${EVENTRA_SDK_PACKAGE}"`);
    expect(EVENTRA_SDK_SHIM).toContain("track(name: string, options?: TrackOptions): void;");
  });
});
