import { describe, expect, test } from "bun:test";
import { MAX_DIAGNOSTIC_CONTEXT_CHARS, NdjsonStreamParser } from "../src/protocol";
import type { ParserOutcome } from "../src/protocol";
import { initEvent, resultEvent, stepEvent } from "./fixtures/protocol/streams";

function parse(text: string): ParserOutcome {
  const parser = new NdjsonStreamParser();
  parser.push(text);
  return parser.finish();
}

describe("string chunk surrogate seam", () => {
  test("a surrogate pair split across two string chunks is preserved exactly", () => {
    const stream = `${initEvent()}\n${stepEvent({ stepIndex: 0, state: "DONE", textDelta: "a\u{1F600}b" })}\n${resultEvent({ status: "SUCCESS", response: "" })}\n`;
    const split = stream.indexOf("\u{1F600}");
    const parser = new NdjsonStreamParser();
    parser.push(stream.slice(0, split + 1)); // ends on the high surrogate half
    parser.push(stream.slice(split + 1)); // begins on the low surrogate half
    const outcome = parser.finish();
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.text).toBe("a\u{1F600}b");
    }
  });

  test("a high surrogate left at finish() is flushed as a replacement, not dropped", () => {
    const parser = new NdjsonStreamParser();
    parser.push("not json\uD83D"); // trailing lone high surrogate, no newline
    const outcome = parser.finish();
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.reason.type).toBe("missing-result");
      const malformed = outcome.diagnostics.find((d) => d.kind === "malformed-line");
      if (malformed?.kind === "malformed-line") {
        expect(malformed.context).toBe("not json\uFFFD");
      }
    }
  });

  test("a 2-chunk surrogate split yields exact text AND zero diagnostics", () => {
    const stream = `${initEvent()}\n${stepEvent({ stepIndex: 0, state: "DONE", textDelta: "a\u{1F600}b" })}\n${resultEvent({ status: "SUCCESS", response: "" })}\n`;
    const split = stream.indexOf("\u{1F600}");
    const parser = new NdjsonStreamParser();
    parser.push(stream.slice(0, split + 1)); // ends on the high surrogate half
    parser.push(stream.slice(split + 1)); // begins on the low surrogate half
    const outcome = parser.finish();
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.text).toBe("a\u{1F600}b");
      expect(outcome.diagnostics.length).toBe(0);
    }
  });

  test("a 3-chunk split across and after a surrogate pair equals the all-at-once outcome", () => {
    const stream = `${initEvent()}\n${stepEvent({ stepIndex: 0, state: "DONE", textDelta: "a\u{1F600}b" })}\n${resultEvent({ status: "SUCCESS", response: "" })}\n`;
    const split = stream.indexOf("\u{1F600}");
    const parser = new NdjsonStreamParser();
    parser.push(stream.slice(0, split + 1)); // high surrogate half
    parser.push(stream.slice(split + 1, split + 2)); // low surrogate half alone
    parser.push(stream.slice(split + 2)); // rest of the stream
    const outcome = parser.finish();
    expect(outcome).toEqual(parse(stream));
    if (outcome.kind === "success") {
      expect(outcome.text).not.toContain("\uFFFD");
    }
  });

  test("surrogate handling does not consume a 1-diagnostic budget before a real malformed line", () => {
    const stream = `${initEvent()}\n${stepEvent({ stepIndex: 0, state: "DONE", textDelta: "a\u{1F600}b" })}\n`;
    const split = stream.indexOf("\u{1F600}");
    const parser = new NdjsonStreamParser({ maxDiagnostics: 1 });
    parser.push(stream.slice(0, split + 1));
    parser.push(stream.slice(split + 1));
    parser.push("bad line\n");
    parser.push(resultEvent({ status: "SUCCESS", response: "" }));
    const outcome = parser.finish();
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.diagnostics.length).toBe(1);
      expect(outcome.droppedDiagnostics).toBe(0);
      const only = outcome.diagnostics[0];
      if (only?.kind === "malformed-line") {
        expect(only.context).toBe("bad line");
      }
      expect(outcome.text).toBe("a\u{1F600}b");
    }
  });
});

describe("pending-line bound applies to complete lines too", () => {
  test("an oversized complete line in one all-at-once string chunk is skipped, not parsed", () => {
    const oversized = "y".repeat(70_000); // > default 64 KiB cap
    const stream = `${oversized}\n${resultEvent({ status: "SUCCESS", response: "ok." })}\n`;
    const outcome = parse(stream);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.text).toBe("ok.");
      expect(outcome.diagnostics.filter((d) => d.kind === "line-too-long").length).toBe(1);
      expect(outcome.diagnostics.filter((d) => d.kind === "malformed-line").length).toBe(0);
    }
  });

  test("an oversized line and a valid result in one Uint8Array chunk resume cleanly", () => {
    const oversized = "z".repeat(70_000);
    const stream = `${oversized}\n${resultEvent({ status: "SUCCESS", response: "ok." })}\n`;
    const parser = new NdjsonStreamParser();
    parser.push(new TextEncoder().encode(stream));
    const outcome = parser.finish();
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.text).toBe("ok.");
      expect(outcome.diagnostics.filter((d) => d.kind === "line-too-long").length).toBe(1);
      expect(outcome.diagnostics.filter((d) => d.kind === "malformed-line").length).toBe(0);
    }
  });
});

describe("diagnostic credential redaction", () => {
  test("serialized diagnostics exclude the fake secret, bearer tokens and cwd", () => {
    const secretToken = "sk-test-1234567890abcdef";
    const malformed = `config token=${secretToken} Bearer abc123XYZ leaked ${secretToken}`;
    const stream = [malformed, resultEvent({ status: "SUCCESS", response: "ok." })].join("\n");
    const outcome = parse(stream);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      const serialized = JSON.stringify(outcome.diagnostics);
      expect(serialized).not.toContain(secretToken);
      expect(serialized).not.toContain("abc123XYZ");
      expect(serialized).not.toContain(process.cwd());
      const malformedDiag = outcome.diagnostics.find((d) => d.kind === "malformed-line");
      if (malformedDiag?.kind === "malformed-line") {
        expect(malformedDiag.context).toContain("config");
        expect(malformedDiag.context.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CONTEXT_CHARS);
      }
    }
  });

  test("safe bounded context is preserved when no credential is present", () => {
    const outcome = parse(`unrelated malformed line\n${resultEvent({ status: "SUCCESS", response: "ok." })}`);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      const malformedDiag = outcome.diagnostics.find((d) => d.kind === "malformed-line");
      if (malformedDiag?.kind === "malformed-line") {
        expect(malformedDiag.context).toBe("unrelated malformed line");
      }
    }
  });
});
