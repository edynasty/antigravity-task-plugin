import { describe, expect, test } from "bun:test";
import { NdjsonStreamParser } from "../src/protocol";
import type { InvalidResultReason, ParserOutcome, ProtocolParserOptions } from "../src/protocol";
import {
  CONVERSATION_ID,
  initEvent,
  line,
  resultEvent,
  stepEvent,
} from "./fixtures/protocol/streams";

function parse(text: string, options?: ProtocolParserOptions): ParserOutcome {
  const parser = new NdjsonStreamParser(options);
  parser.push(text);
  return parser.finish();
}

describe("missing result at end of stream", () => {
  test("empty output and init-only streams are missing-result failures", () => {
    for (const stream of ["", `${initEvent()}\n`]) {
      const outcome = parse(stream);
      expect(outcome.kind).toBe("failure");
      if (outcome.kind === "failure") {
        expect(outcome.reason.type).toBe("missing-result");
      }
    }
  });

  test("deltas without a result still fail, keeping best-effort text", () => {
    const stream = `${initEvent()}\n${stepEvent({ stepIndex: 0, state: "DONE", textDelta: "partial text." })}\n`;
    const outcome = parse(stream);
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.reason.type).toBe("missing-result");
      expect(outcome.text).toBe("partial text.");
    }
  });
});

describe("invalid known payload on the result event is fatal", () => {
  test("each violated authority field maps to a stable reason", () => {
    const cases: ReadonlyArray<{ readonly name: string; readonly stream: string; readonly reason: InvalidResultReason }> = [
      { name: "lowercase status", stream: resultEvent({ status: "success" }), reason: "status" },
      { name: "missing response", stream: line({ event: "result", result: { conversation_id: CONVERSATION_ID, status: "SUCCESS" } }), reason: "response" },
      { name: "garbage usage", stream: resultEvent({ status: "SUCCESS", response: "x", extra: { usage: { total_tokens: "many" } } }), reason: "usage" },
      { name: "missing conversation_id", stream: line({ event: "result", result: { status: "SUCCESS", response: "x" } }), reason: "conversation-id" },
      { name: "non-record payload", stream: line({ event: "result", result: 42 }), reason: "payload-not-record" },
      { name: "non-string error", stream: resultEvent({ status: "ERROR", extra: { error: 42 } }), reason: "error" },
    ];
    for (const entry of cases) {
      const outcome = parse(entry.stream);
      expect(outcome.kind).toBe("failure");
      if (outcome.kind === "failure") {
        expect(outcome.reason.type).toBe("invalid-result");
        if (outcome.reason.type === "invalid-result") {
          expect(outcome.reason.detail).toBe(entry.reason);
        }
      }
    }
  });
});

describe("unknown events and unknown fields are forward-compatible", () => {
  test("unknown event is a bounded diagnostic, never fatal", () => {
    const stream = [
      line({ event: "future_event", payload: { anything: true } }),
      resultEvent({ status: "SUCCESS", response: "ok." }),
    ].join("\n");
    const outcome = parse(stream);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.diagnostics.some((d) => d.kind === "unknown-event" && d.name === "future_event")).toBe(true);
    }
  });

  test("unknown fields inside known events are ignored", () => {
    const stream = [
      initEvent(),
      stepEvent({ stepIndex: 0, state: "DONE", textDelta: "ok.", extra: { brand_new_field: { nested: 1 } } }),
      resultEvent({ status: "SUCCESS", response: "ok.", extra: { another_new_field: "x" } }),
    ].join("\n");
    const outcome = parse(stream);
    expect(outcome.kind).toBe("success");
  });
});

describe("malformed lines are bounded diagnostics, not thrown errors", () => {
  test("a non-JSON line does not break a later successful result", () => {
    const stream = ["this is not json", resultEvent({ status: "SUCCESS", response: "ok." })].join("\n");
    const outcome = parse(stream);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.diagnostics.some((d) => d.kind === "malformed-line" && d.context === "this is not json")).toBe(true);
    }
  });

  test("JSON arrays, JSON strings and event-less objects are malformed-line diagnostics", () => {
    for (const bad of ["[1, 2, 3]", '"just a string"', '{"payload": {}}']) {
      const outcome = parse(`${bad}\n${resultEvent({ status: "SUCCESS", response: "ok." })}`);
      expect(outcome.kind).toBe("success");
      if (outcome.kind === "success") {
        expect(outcome.diagnostics.some((d) => d.kind === "malformed-line")).toBe(true);
      }
    }
  });

  test("blank lines are accepted silently", () => {
    const stream = `\n\n${initEvent()}\n\r\n${resultEvent({ status: "SUCCESS", response: "ok." })}\n\n`;
    const outcome = parse(stream);
    expect(outcome.kind).toBe("success");
  });
});

describe("line endings", () => {
  test("CRLF line endings parse identically to LF", () => {
    const crlf = `${initEvent()}\r\n${resultEvent({ status: "SUCCESS", response: "ok." })}\r\n`;
    const outcome = parse(crlf);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.text).toBe("ok.");
    }
  });

  test("a CR/LF pair split across chunks is one line ending", () => {
    const parser = new NdjsonStreamParser();
    parser.push(`${initEvent()}\r`);
    parser.push(`\n${resultEvent({ status: "SUCCESS", response: "ok." })}`);
    const outcome = parser.finish();
    expect(outcome.kind).toBe("success");
  });

  test("a valid final line without a trailing newline is parsed", () => {
    const stream = `${initEvent()}\n${resultEvent({ status: "SUCCESS", response: "no lf." })}`;
    expect(stream.endsWith("\n")).toBe(false);
    const outcome = parse(stream);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.text).toBe("no lf.");
    }
  });
});

describe("conversation id", () => {
  test("conversation_id comes from the init event and is surfaced on success", () => {
    const outcome = parse(`${initEvent()}\n${resultEvent({ status: "SUCCESS", response: "ok." })}\n`);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.conversationId).toBe(CONVERSATION_ID);
    }
  });
});
