/**
 * UTF-16-safe truncation: a cut never lands between the halves of a
 * surrogate pair, so emoji / non-BMP CJK never degrade into U+FFFD.
 */
import { describe, expect, test } from "bun:test";
import { truncateUtf16 } from "../src/utf16";

describe("truncateUtf16", () => {
  test("short text is returned unchanged", () => {
    expect(truncateUtf16("hello", 10)).toBe("hello");
  });

  test("plain ASCII truncates at the cap", () => {
    expect(truncateUtf16("hello world", 5)).toBe("hello");
  });

  test("a cut inside a surrogate pair backs off to keep the pair whole", () => {
    expect(truncateUtf16("ab\u{1F600}cd", 3)).toBe("ab");
  });

  test("a cut exactly after a surrogate pair keeps it", () => {
    expect(truncateUtf16("ab\u{1F600}cd", 4)).toBe("ab\u{1F600}");
  });

  test("a non-BMP CJK character is not split either", () => {
    expect(truncateUtf16("\u{20BB7}x", 1)).toBe("");
    expect(truncateUtf16("\u{20BB7}x", 2)).toBe("\u{20BB7}");
  });

  test("a cut landing on the pair boundary at the string end stays intact", () => {
    expect(truncateUtf16("x\u{1F600}", 3)).toBe("x\u{1F600}");
  });

  test("maxCodeUnits 0 or negative yields the empty string", () => {
    expect(truncateUtf16("abc", 0)).toBe("");
    expect(truncateUtf16("abc", -1)).toBe("");
  });
});