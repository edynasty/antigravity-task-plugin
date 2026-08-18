/**
 * Gateway prompt building (Todo 13): OpenAI messages are validated at the HTTP
 * boundary and converted into a single role-labeled task prompt for the agy
 * CLI. The framing is the documented contract of the gateway.
 */
import { describe, expect, test } from "bun:test";
import { parsePrompt, promptFromMessages } from "../../src/gateway/prompt";

describe("parsePrompt boundary validation", () => {
  test("non-record input is rejected", () => {
    expect(parsePrompt("nope")).toEqual({ ok: false, reason: "messages must be an array" });
    expect(parsePrompt(null)).toEqual({ ok: false, reason: "messages must be an array" });
    expect(parsePrompt({ messages: "nope" })).toEqual({ ok: false, reason: "messages must be an array" });
  });

  test("empty messages array is rejected", () => {
    expect(parsePrompt({ messages: [] })).toEqual({ ok: false, reason: "messages must not be empty" });
  });

  test("a non-record message is rejected", () => {
    expect(parsePrompt({ messages: ["hello"] })).toEqual({ ok: false, reason: "message 0 must be an object" });
  });

  test("an unknown role is rejected", () => {
    expect(parsePrompt({ messages: [{ role: "tool", content: "x" }] })).toEqual({ ok: false, reason: "message 0 role must be one of system, user, assistant" });
  });

  test("a non-string content is rejected", () => {
    expect(parsePrompt({ messages: [{ role: "user", content: { text: "x" } }] })).toEqual({ ok: false, reason: "message 0 content must be a string" });
  });

  test("a missing role is rejected", () => {
    expect(parsePrompt({ messages: [{ content: "x" }] })).toEqual({ ok: false, reason: "message 0 role must be one of system, user, assistant" });
  });
});

describe("promptFromMessages framing", () => {
  test("a single user message becomes a role-labeled block", () => {
    const parsed = parsePrompt({ messages: [{ role: "user", content: "hello" }] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(promptFromMessages(parsed.messages)).toBe("<user>\nhello\n</user>");
    }
  });

  test("system, user and assistant roles are preserved in order", () => {
    const parsed = parsePrompt({
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "summarize" },
        { role: "assistant", content: "done" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(promptFromMessages(parsed.messages)).toBe(
        "<system>\nbe terse\n</system>\n\n<user>\nsummarize\n</user>\n\n<assistant>\ndone\n</assistant>",
      );
    }
  });

  test("content is placed verbatim between role tags including newlines", () => {
    const parsed = parsePrompt({ messages: [{ role: "user", content: "line one\nline two" }] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(promptFromMessages(parsed.messages)).toBe("<user>\nline one\nline two\n</user>");
    }
  });

  test("empty string content is allowed", () => {
    const parsed = parsePrompt({ messages: [{ role: "user", content: "" }] });
    expect(parsed.ok).toBe(true);
  });
});
