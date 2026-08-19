/**
 * Gateway prompt building (Todo 13): OpenAI messages are validated at the HTTP
 * boundary and converted into a single role-labeled task prompt for the agy
 * CLI. The framing is the documented contract of the gateway.
 */
import { describe, expect, test } from "bun:test";
import { HOST_EXECUTION_DIRECTIVE, parsePrompt, promptFromMessages } from "../../src/gateway/prompt";

const DIRECTIVE = `${HOST_EXECUTION_DIRECTIVE}\n\n`;

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
    expect(parsePrompt({ messages: [{ role: "function", content: "x" }] })).toEqual({ ok: false, reason: "message 0 role must be one of system, user, assistant, tool" });
  });

  test("a non-string non-array content is rejected", () => {
    expect(parsePrompt({ messages: [{ role: "user", content: { text: "x" } }] })).toEqual({ ok: false, reason: "message 0 content must be a string or an array of parts" });
  });

  test("a missing role is rejected", () => {
    expect(parsePrompt({ messages: [{ content: "x" }] })).toEqual({ ok: false, reason: "message 0 role must be one of system, user, assistant, tool" });
  });
});

describe("parsePrompt tools injection", () => {
  test("a missing role is rejected", () => {
    expect(parsePrompt({ messages: [{ content: "x" }] })).toEqual({ ok: false, reason: "message 0 role must be one of system, user, assistant, tool" });
  });

  test("the tools array is injected as a <tools> block before the messages", () => {
    const parsed = parsePrompt({
      tools: [
        { type: "function", function: { name: "bash", description: "Run a shell command", parameters: {} } },
        { type: "function", function: { name: "edit", description: "Edit a file" } },
      ],
      messages: [{ role: "user", content: "hello" }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.prompt).toBe(`${DIRECTIVE}<tools>\n- bash: Run a shell command\n- edit: Edit a file\n</tools>\n\n<user>\nhello\n</user>`);
  });

  test("malformed tools entries are skipped and an empty tools array adds nothing", () => {
    const parsed = parsePrompt({
      tools: [
        { type: "function", function: { name: "" } },
        { type: "function", function: { description: "no name" } },
        "not-an-object",
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.prompt).toBe(`${DIRECTIVE}<user>\nhi\n</user>`);
  });
});

describe("parsePrompt array-of-parts content", () => {
  test("text parts are extracted and joined", () => {
    const parsed = parsePrompt({
      messages: [{ role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.prompt).toBe(`${DIRECTIVE}<user>\nfirst\nsecond\n</user>`);
    }
  });

  test("image and unknown parts are dropped, text survives", () => {
    const parsed = parsePrompt({
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "text", text: "explain this" },
            { type: "weird", value: 1 },
          ],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.prompt).toBe(`${DIRECTIVE}<user>\nexplain this\n</user>`);
    }
  });

  test("an image-only array yields empty content without failing", () => {
    const parsed = parsePrompt({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }],
    });
    expect(parsed.ok).toBe(true);
  });

  test("null and missing content become an empty string", () => {
    const withNull = parsePrompt({ messages: [{ role: "user", content: null }] });
    expect(withNull.ok).toBe(true);
    if (withNull.ok) {
      expect(withNull.prompt).toBe(`${DIRECTIVE}<user>\n\n</user>`);
    }
    const missing = parsePrompt({ messages: [{ role: "tool" }] });
    expect(missing.ok).toBe(true);
    if (missing.ok) {
      expect(missing.prompt).toBe(`${DIRECTIVE}<tool>\n\n</tool>`);
    }
  });

  test("tool role is accepted and framed with a tool tag", () => {
    const parsed = parsePrompt({
      messages: [
        { role: "user", content: "run the command" },
        { role: "tool", content: "exit code 0: ok" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.prompt).toBe(`${DIRECTIVE}<user>\nrun the command\n</user>\n\n<tool>\nexit code 0: ok\n</tool>`);
    }
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
