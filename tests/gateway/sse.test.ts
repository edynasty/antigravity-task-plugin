/**
 * Gateway SSE serialization (Todo 13): exact OpenAI chat.completion.chunk wire
 * format plus the bounded text cap applied to streamed deltas.
 */
import { describe, expect, test } from "bun:test";
import { boundedDelta, chatChunk, chatDone, conversationIdSse, sseData } from "../../src/gateway/sse";

describe("sseData framing", () => {
  test("payload is JSON on one data line with a double blank line terminator", () => {
    expect(sseData({ a: 1 })).toBe('data: {"a":1}\n\n');
  });

  test("content with quotes and newlines is JSON-escaped", () => {
    expect(sseData({ content: 'say "hi"\nnext line' })).toBe('data: {"content":"say \\"hi\\"\\nnext line"}\n\n');
  });
});

describe("chatChunk", () => {
  test("streaming delta chunk carries the OpenAI chunk shape", () => {
    const line = chatChunk("chatcmpl-abc", 1700000000, "m1", { content: "hi" }, null);
    expect(JSON.parse(line.slice(6))).toEqual({
      id: "chatcmpl-abc",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "m1",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
    });
  });

  test("terminal chunk carries finish_reason stop with an empty delta", () => {
    const line = chatChunk("chatcmpl-abc", 1700000000, "m1", {}, "stop");
    expect(JSON.parse(line.slice(6))).toEqual({
      id: "chatcmpl-abc",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "m1",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
  });
});

describe("terminal SSE lines", () => {
  test("done line is exactly data: [DONE]", () => {
    expect(chatDone()).toBe("data: [DONE]\n\n");
  });

  test("conversation id is an SSE comment line, never a data line", () => {
    expect(conversationIdSse("conv-1")).toBe(": conversation_id=conv-1\n\n");
  });
});

describe("boundedDelta response cap", () => {
  test("without a cap every delta is emitted unchanged", () => {
    const result = boundedDelta("acc", "delta", null);
    expect(result).toEqual({ accumulated: "accdelta", emitted: "delta", reached: false });
  });

  test("a delta crossing the cap is truncated and marked reached", () => {
    const result = boundedDelta("01234567", "89xy", 10);
    expect(result).toEqual({ accumulated: "0123456789", emitted: "89", reached: true });
  });

  test("an already-reached cap emits nothing", () => {
    const result = boundedDelta("0123456789", "xy", 10);
    expect(result).toEqual({ accumulated: "0123456789", emitted: "", reached: true });
  });
});
