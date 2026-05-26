import { describe, expect, it } from "vitest";
import { extractTemplateExpressions } from "../../src/shared/templateExpressionExtractor";

describe("extractTemplateExpressions", () => {
  it("captures double-quoted attribute values (Vue/HTML)", () => {
    const result = extractTemplateExpressions(
      `<button @click="trackFeature('checkout.completed')" class="btn">`,
    );
    expect(result).toContain("trackFeature('checkout.completed')");
    expect(result).toContain("btn");
  });

  it("captures Svelte/Astro-style {expression} tokens", () => {
    const result = extractTemplateExpressions(
      `<button on:click={() => trackFeature("signup")}>`,
    );
    // current regex extracts content between { and }
    expect(result.some((r) => r.includes("trackFeature"))).toBe(true);
  });

  it("returns an empty array when no patterns match", () => {
    expect(extractTemplateExpressions("plain text")).toEqual([]);
  });
});
