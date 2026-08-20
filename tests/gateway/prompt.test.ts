/**
 * Gateway prompt building (Todo 13): OpenAI messages are validated at the HTTP
 * boundary and converted into a single role-labeled task prompt for the agy
 * CLI. The framing is the documented contract of the gateway.
 */
import { describe, expect, test } from "bun:test";
import { HOST_EXECUTION_DIRECTIVE, parsePrompt, parseToolClis, promptFromMessages, remapHostPathToContainer } from "../../src/gateway/prompt";

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
    expect(parsed.prompt).toBe(
      `${DIRECTIVE}<tools>\n- bash: Run a shell command\n- edit: Edit a file\n</tools>\n\n` +
        `<host-tools>\nThe host environment exposes tools you cannot invoke directly.\n` +
        `Reach a CLI equivalent via run_command when one exists:\n- bash\n- edit\n` +
        `Otherwise describe the operation in your reply; the host performs it and returns the result as a <tool> block.\n` +
        `Never invent tool invocations the host does not expose.\n</host-tools>\n\n<user>\nhello\n</user>`,
    );
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

  test("openviking-context blocks are stripped from framed user content", () => {
    const parsed = parsePrompt({
      messages: [
        {
          role: "user",
          content: "<openviking-context>\nRelevant memory.\n</openviking-context>\n实际请求内容",
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(promptFromMessages(parsed.messages)).toBe("<user>\n\n实际请求内容\n</user>");
    }
  });

  test("openviking-context blocks are stripped from every role", () => {
    const parsed = parsePrompt({
      messages: [
        { role: "assistant", content: "<openviking-context>mem</openviking-context>ok" },
        { role: "tool", content: "<openviking-context>mem</openviking-context>out" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(promptFromMessages(parsed.messages)).toBe(
        "<assistant>\nok\n</assistant>\n\n<tool>\nout\n</tool>",
      );
    }
  });
});

describe("host-tools directive", () => {
  test("is empty when the request has no tools", () => {
    const parsed = parsePrompt({ messages: [{ role: "user", content: "hi" }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.prompt).toBe(`${DIRECTIVE}<user>\nhi\n</user>`);
    expect(parsed.prompt).not.toContain("<host-tools>");
  });

  test("lists host tools with CLI equivalents from the builtin mapping", () => {
    const parsed = parsePrompt(
      {
        tools: [{ type: "function", function: { name: "github::create_issue", description: "Create an issue" } }],
        messages: [{ role: "user", content: "hi" }],
      },
      parseToolClis(undefined),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.prompt).toContain("- github::create_issue -> CLI: gh");
    expect(parsed.prompt).toContain("cannot invoke directly");
    expect(parsed.prompt).toContain("returns the result as a <tool> block");
  });

  test("env mapping overrides and extends the builtin defaults", () => {
    const clis = parseToolClis("github::*=ghp,context7::*=npx context7");
    const parsed = parsePrompt(
      {
        tools: [
          { type: "function", function: { name: "github::create_issue" } },
          { type: "function", function: { name: "context7::query-docs" } },
        ],
        messages: [{ role: "user", content: "hi" }],
      },
      clis,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.prompt).toContain("- github::create_issue -> CLI: ghp");
    expect(parsed.prompt).toContain("- context7::query-docs -> CLI: npx context7");
  });

  test("malformed env entries are skipped", () => {
    const clis = parseToolClis("no-equals,=novalue,key=,valid=cli");
    expect(clis["valid"]).toBe("cli");
    expect(clis["no-equals"]).toBeUndefined();
    expect(clis[""]).toBeUndefined();
    expect(clis["key"]).toBeUndefined();
    expect(clis["github::*"]).toBe("gh");
  });

  test("tools without a CLI match are listed without one", () => {
    const parsed = parsePrompt({
      tools: [{ type: "function", function: { name: "custom-tool" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.prompt).toContain("- custom-tool\n");
    expect(parsed.prompt).not.toContain("-> CLI:");
  });
});

describe("remapHostPathToContainer", () => {
  const mounts = [
    { hostPath: "/Users/a/p1", containerPath: "/workspace/p1" },
    { hostPath: "/Users/a/p2", containerPath: "/workspace/p2" },
  ] as const;

  test("no mounts leaves text untouched", () => {
    expect(remapHostPathToContainer("work on /Users/a/p1/src", [])).toBe("work on /Users/a/p1/src");
  });

  test("host path is rewritten to its container path", () => {
    expect(remapHostPathToContainer("work on /Users/a/p1/src/index.ts", mounts)).toBe(
      "work on /workspace/p1/src/index.ts",
    );
  });

  test("each mount rewrites independently", () => {
    expect(remapHostPathToContainer("check /Users/a/p1 and /Users/a/p2", mounts)).toBe(
      "check /workspace/p1 and /workspace/p2",
    );
  });

  test("path-like prefixes are not rewritten", () => {
    expect(remapHostPathToContainer("open /Users/a/p1x", mounts)).toBe("open /Users/a/p1x");
  });

  test("exact host path maps to exact container path", () => {
    expect(remapHostPathToContainer("cwd=/Users/a/p2", mounts)).toBe("cwd=/workspace/p2");
  });
});
