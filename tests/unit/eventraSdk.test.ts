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

  it("cuts a value longer than the max length, as the SDK does", () => {
    const tooLong = "a".repeat(MAX_EVENT_NAME_LENGTH + 1);
    expect(normalizeEventName(tooLong)).toBe("a".repeat(MAX_EVENT_NAME_LENGTH));
  });

  it("accepts a value exactly at the max length", () => {
    const exact = "a".repeat(MAX_EVENT_NAME_LENGTH);
    expect(normalizeEventName(exact)).toBe(exact);
  });

  it("accepts punctuation and emoji, which the SDK sends as they are", () => {
    expect(normalizeEventName("user signup!")).toBe("user signup!");
    expect(normalizeEventName("emoji🎉event")).toBe("emoji🎉event");
  });

  it("rejects a value with control characters", () => {
    expect(normalizeEventName("tab\tseparated")).toBeNull();
    expect(normalizeEventName("line\nbreak")).toBeNull();
  });

  it("accepts a leading $, as PostHog names its own events", () => {
    expect(normalizeEventName("$pageview")).toBe("$pageview");
    expect(normalizeEventName("$pageleave")).toBe("$pageleave");
  });

  it("accepts spaces, including together with colons (third-party style names)", () => {
    expect(normalizeEventName("App: User Sign Up")).toBe("App: User Sign Up");
    expect(normalizeEventName("Order Completed")).toBe("Order Completed");
    expect(normalizeEventName("a  b")).toBe("a  b");
  });

  it("trims outer spaces but keeps inner ones", () => {
    expect(normalizeEventName("  App: User Sign Up  ")).toBe("App: User Sign Up");
  });

  it("cuts names with spaces at 64 characters too", () => {
    const exact = `${"a ".repeat(31)}ab`;
    expect(exact).toHaveLength(MAX_EVENT_NAME_LENGTH);
    expect(normalizeEventName(exact)).toBe(exact);
    expect(normalizeEventName(`${exact}x`)).toBe(exact);
  });
});

describe("isValidEventName", () => {
  it("returns true for a valid event name", () => {
    expect(isValidEventName("checkout.completed")).toBe(true);
    expect(isValidEventName("has space")).toBe(true);
  });

  it("returns false for an invalid event name", () => {
    expect(isValidEventName("")).toBe(false);
    expect(isValidEventName("has\tTab")).toBe(false);
    expect(isValidEventName("   ")).toBe(false);
  });
});

describe("EVENTRA_SDK_SHIM", () => {
  it("declares the SDK module with a track() method", () => {
    expect(EVENTRA_SDK_SHIM).toContain(`declare module "${EVENTRA_SDK_PACKAGE}"`);
    expect(EVENTRA_SDK_SHIM).toContain("track(name: string, options?: TrackOptions): void;");
  });
});
