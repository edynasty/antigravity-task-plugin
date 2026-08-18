/**
 * Final tool title composition unit tests (pure, no runner/process).
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_TITLE_CHARS,
  NO_TASK_PLACEHOLDER,
  TITLE_TRUNCATION_SUFFIX,
  composeTitle,
  titleExcerpt,
} from "../src/title";

describe("titleExcerpt", () => {
  test("takes the first non-empty line and trims it", () => {
    expect(titleExcerpt("  first line  \nsecond line")).toBe("first line");
    expect(titleExcerpt("first\nsecond")).toBe("first");
  });

  test("redacts credential-shaped content before bounding", () => {
    expect(titleExcerpt(`sk-ant-1234567890abcdef1234567890abcdef ${"y".repeat(80)}`)).toBe(
      `[REDACTED] ${"y".repeat(49)}${TITLE_TRUNCATION_SUFFIX}`,
    );
    expect(titleExcerpt("api_key=abc12345xyz rest")).toBe("[REDACTED] rest");
  });

  test("bounds the excerpt to 60 chars with a trailing ellipsis", () => {
    expect(titleExcerpt("x".repeat(80))).toBe(`${"x".repeat(60)}${TITLE_TRUNCATION_SUFFIX}`);
    expect(titleExcerpt("x".repeat(60))).toBe("x".repeat(60));
    expect(titleExcerpt("x".repeat(60)).length).toBeLessThanOrEqual(60);
  });

  test("blank or whitespace-only tasks yield the no-task placeholder", () => {
    expect(titleExcerpt("")).toBe(NO_TASK_PLACEHOLDER);
    expect(titleExcerpt("   \n\t")).toBe(NO_TASK_PLACEHOLDER);
    expect(titleExcerpt("\n\n  \n")).toBe(NO_TASK_PLACEHOLDER);
  });
});

describe("composeTitle", () => {
  test("formats success and failure kinds with model and excerpt", () => {
    expect(composeTitle("SUCCESS", "claude-sonnet-4-6", "git push origin main")).toBe(
      "antigravity-task: SUCCESS (claude-sonnet-4-6) — git push origin main",
    );
    expect(composeTitle("status", "claude-sonnet-4-6", "Final read-only verification")).toBe(
      "antigravity-task: status (claude-sonnet-4-6) — Final read-only verification",
    );
  });

  test("a null model becomes unknown", () => {
    expect(composeTitle("SUCCESS", null, "t")).toBe("antigravity-task: SUCCESS (unknown) — t");
  });

  test("a 60-char excerpt, kind and model stay within the 140-char cap", () => {
    const exact = composeTitle("SUCCESS", "claude-sonnet-4-6", "x".repeat(60));
    expect(exact.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(exact).not.toContain(TITLE_TRUNCATION_SUFFIX);

    const truncated = composeTitle("duplicate-result", "claude-sonnet-4-6", "x".repeat(61));
    expect(truncated.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(truncated).toContain(TITLE_TRUNCATION_SUFFIX);
  });

  test("never embeds the second task line", () => {
    const title = composeTitle("SUCCESS", null, "first line\nsecond line with secrets");
    expect(title).toBe("antigravity-task: SUCCESS (unknown) — first line");
  });
});
