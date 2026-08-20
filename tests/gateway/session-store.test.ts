/**
 * SessionStore unit tests (gateway incremental conversation reuse).
 */
import { describe, expect, test } from "bun:test";
import { SessionStore, prefixHashes, stableMessageText } from "../../src/gateway/session-store";
import type { OpenAIMessage } from "../../src/gateway/prompt";

const user = (content: string): OpenAIMessage => ({ role: "user", content });
const assistant = (content: string): OpenAIMessage => ({ role: "assistant", content });
const tool = (content: string): OpenAIMessage => ({ role: "tool", content });

describe("prefixHashes", () => {
  test("empty sequence hashes to a single zero prefix", () => {
    expect(prefixHashes([])).toEqual([0n]);
  });

  test("openviking-context blocks are stripped from user messages", () => {
    const withMemoryA = "<openviking-context>\nsome memory A\n</openviking-context>\nreal question?";
    const withMemoryB = "<openviking-context>\ndifferent memory B\n</openviking-context>\nreal question?";
    expect(stableMessageText("user", withMemoryA)).toBe("\nreal question?");
    expect(stableMessageText("user", withMemoryA)).toBe(stableMessageText("user", withMemoryB));
    expect(prefixHashes([user(withMemoryA)])[1]).toBe(prefixHashes([user(withMemoryB)])[1]);
  });

  test("assistant and tool messages hash verbatim", () => {
    const withContext = "<openviking-context>mem</openviking-context>tool out";
    expect(stableMessageText("tool", withContext)).toBe(withContext);
    expect(stableMessageText("assistant", withContext)).toBe(withContext);
  });
});

describe("SessionStore", () => {
  test("lookup misses on an empty store", () => {
    const store = new SessionStore(4);
    expect(store.lookup([user("hi")])).toBeNull();
  });

  test("record then lookup finds the exact sequence", () => {
    const store = new SessionStore(4);
    const sequence = [user("hi"), assistant("hello")];
    store.record(sequence, "conv-1");
    expect(store.size).toBe(1);
    expect(store.lookup(sequence)).toEqual({ conversationId: "conv-1", seenCount: 2 });
  });

  test("lookup resumes a superset (same session, one more turn)", () => {
    const store = new SessionStore(4);
    store.record([user("q1"), assistant("a1")], "conv-1");
    const next = [user("q1"), assistant("a1"), user("q2")];
    expect(store.lookup(next)).toEqual({ conversationId: "conv-1", seenCount: 2 });
  });

  test("lookup prefers the longest matching prefix", () => {
    const store = new SessionStore(4);
    store.record([user("q1")], "conv-short");
    store.record([user("q1"), assistant("a1")], "conv-long");
    expect(store.lookup([user("q1"), assistant("a1"), user("q2")])).toEqual({
      conversationId: "conv-long",
      seenCount: 2,
    });
  });

  test("lookup misses when the prefix diverges", () => {
    const store = new SessionStore(4);
    store.record([user("q1"), assistant("a1")], "conv-1");
    expect(store.lookup([user("q1"), assistant("different"), user("q2")])).toBeNull();
  });

  test("system messages are excluded from the fingerprint", () => {
    const store = new SessionStore(4);
    store.record([user("q1")], "conv-1");
    const withSystem = [
      { role: "system", content: "regenerated every request" },
      user("q1"),
    ] as readonly OpenAIMessage[];
    expect(store.lookup(withSystem)).toEqual({ conversationId: "conv-1", seenCount: 1 });
  });

  test("user message with changing injected context still matches", () => {
    const store = new SessionStore(4);
    store.record([user("<openviking-context>A</openviking-context>read the readme")], "conv-1");
    const next = [
      user("<openviking-context>totally different memory B</openviking-context>read the readme"),
      assistant("25380 chars"),
      user("how long is the readme?"),
    ];
    expect(store.lookup(next)).toEqual({ conversationId: "conv-1", seenCount: 1 });
  });

  test("evicts the oldest entry past capacity", () => {
    const store = new SessionStore(2);
    store.record([user("a")], "conv-a");
    store.record([user("b")], "conv-b");
    store.record([user("c")], "conv-c");
    expect(store.size).toBe(2);
    expect(store.lookup([user("a")])).toBeNull();
    expect(store.lookup([user("c")])).toEqual({ conversationId: "conv-c", seenCount: 1 });
  });

  test("recording the same sequence refreshes the conversation id", () => {
    const store = new SessionStore(4);
    store.record([user("q")], "conv-old");
    store.record([user("q")], "conv-new");
    expect(store.lookup([user("q")])).toEqual({ conversationId: "conv-new", seenCount: 1 });
  });

  test("lookup touches LRU order", () => {
    const store = new SessionStore(2);
    store.record([user("a")], "conv-a");
    store.record([user("b")], "conv-b");
    expect(store.lookup([user("a")])).not.toBeNull();
    store.record([user("c")], "conv-c");
    expect(store.lookup([user("b")])).toBeNull();
    expect(store.lookup([user("a")])).not.toBeNull();
  });

  test("tool messages participate in the fingerprint", () => {
    const store = new SessionStore(4);
    store.record([user("run it"), tool("cmd output")], "conv-1");
    expect(store.lookup([user("run it"), tool("cmd output"), user("and now?")])).toEqual({
      conversationId: "conv-1",
      seenCount: 2,
    });
  });
});
describe("SessionStore capacity 0 (incremental disabled)", () => {
  test("lookup always misses even after recording", () => {
    const store = new SessionStore(0);
    const sequence = [user("hi"), assistant("hello")];
    store.record(sequence, "conv-1");
    expect(store.size).toBe(0);
    expect(store.lookup(sequence)).toBeNull();
    expect(store.lookup([user("hi"), assistant("hello"), user("more")])).toBeNull();
  });
});
