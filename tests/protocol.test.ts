import { describe, expect, test } from "bun:test";
import { NdjsonStreamParser } from "../src/protocol";
import type { ParserOutcome, ProtocolParserOptions } from "../src/protocol";
import {
  RESULT_USAGE,
  STEP_USAGE,
  ZERO_USAGE,
  initEvent,
  resultEvent,
  stepEvent,
} from "./fixtures/protocol/streams";

function parse(text: string, options?: ProtocolParserOptions): ParserOutcome {
  const parser = new NdjsonStreamParser(options);
  parser.push(text);
  return parser.finish();
}

function feed(parser: NdjsonStreamParser, text: string, maxChunk: number): void {
  let offset = 0;
  while (offset < text.length) {
    const size = Math.min(maxChunk, text.length - offset);
    parser.push(text.slice(offset, offset + size));
    offset += size;
  }
}

const NON_SUCCESS_STATUSES = ["ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING"] as const;

describe("status authority: only SUCCESS is success", () => {
  test("SUCCESS with non-empty response is the sole success outcome", () => {
    const outcome = parse(`${initEvent()}\n${resultEvent({ status: "SUCCESS", response: "done." })}\n`);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.status).toBe("SUCCESS");
      expect(outcome.text).toBe("done.");
    }
  });

  test("all six non-SUCCESS statuses are typed status failures", () => {
    for (const status of NON_SUCCESS_STATUSES) {
      const outcome = parse(resultEvent({ status, response: "partial." }));
      expect(outcome.kind).toBe("failure");
      if (outcome.kind === "failure") {
        expect(outcome.reason.type).toBe("status");
        if (outcome.reason.type === "status") {
          expect(outcome.reason.status).toBe(status);
        }
      }
    }
  });

  test("ERROR failure surfaces the official error field", () => {
    const outcome = parse(resultEvent({ status: "ERROR", error: "authentication required" }));
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure" && outcome.reason.type === "status") {
      expect(outcome.reason.error).toBe("authentication required");
    }
  });
});

describe("final text: response wins, deltas fall back", () => {
  test("non-empty result.response is authoritative over deltas", () => {
    const stream = [
      initEvent(),
      stepEvent({ stepIndex: 0, state: "DONE", textDelta: "streamed delta. " }),
      resultEvent({ status: "SUCCESS", response: "authoritative response." }),
    ].join("\n");
    const outcome = parse(stream);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.text).toBe("authoritative response.");
    }
  });

  test("empty result.response falls back to concatenated text_delta in order", () => {
    const stream = [
      initEvent(),
      stepEvent({ stepIndex: 0, state: "ACTIVE", textDelta: "first. " }),
      stepEvent({ stepIndex: 0, state: "DONE", textDelta: "second. " }),
      resultEvent({ status: "SUCCESS", response: "" }),
    ].join("\n");
    const outcome = parse(stream);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.text).toBe("first. second. ");
    }
  });

  test("SUCCESS with empty response and no deltas is an empty-output failure", () => {
    const outcome = parse(resultEvent({ status: "SUCCESS", response: "" }));
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.reason.type).toBe("empty-output");
      expect(outcome.status).toBe("SUCCESS");
    }
  });
});

describe("usage: result is authoritative, steps fall back, no double count", () => {
  test("result usage (15) wins over summed step usage (7)", () => {
    const stream = [
      initEvent(),
      stepEvent({ stepIndex: 0, state: "DONE", usage: STEP_USAGE }),
      resultEvent({ status: "SUCCESS", response: "ok.", usage: RESULT_USAGE }),
    ].join("\n");
    const outcome = parse(stream);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.usage).toEqual(RESULT_USAGE);
      expect(outcome.usage.total_tokens).toBe(15);
    }
  });

  test("present result usage wins even when it is all zeros", () => {
    const stream = [
      initEvent(),
      stepEvent({ stepIndex: 0, state: "DONE", usage: STEP_USAGE }),
      resultEvent({ status: "SUCCESS", response: "ok.", usage: ZERO_USAGE }),
    ].join("\n");
    const outcome = parse(stream);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.usage.total_tokens).toBe(0);
    }
  });

  test("missing result usage falls back to summed per-step usage", () => {
    const stream = [
      initEvent(),
      stepEvent({ stepIndex: 0, state: "DONE", usage: STEP_USAGE }),
      resultEvent({ status: "SUCCESS", response: "ok." }),
    ].join("\n");
    const outcome = parse(stream);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.usage).toEqual(STEP_USAGE);
      expect(outcome.usage.total_tokens).toBe(7);
    }
  });

  test("repeated same-index step usage is counted exactly once (last wins)", () => {
    const stream = [
      initEvent(),
      stepEvent({ stepIndex: 0, state: "ACTIVE", textDelta: "a", usage: { ...STEP_USAGE, total_tokens: 3 } }),
      stepEvent({ stepIndex: 0, state: "ACTIVE", textDelta: "b", usage: { ...STEP_USAGE, total_tokens: 4 } }),
      stepEvent({ stepIndex: 0, state: "DONE", usage: STEP_USAGE }),
      stepEvent({ stepIndex: 1, state: "DONE", usage: { ...STEP_USAGE, total_tokens: 8 } }),
      resultEvent({ status: "SUCCESS", response: "ok." }),
    ].join("\n");
    const outcome = parse(stream);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.usage.total_tokens).toBe(15);
    }
  });
});

describe("duplicate result: every second result is rejected", () => {
  test("conflicting duplicate results are a typed failure", () => {
    const stream = [
      resultEvent({ status: "SUCCESS", response: "first." }),
      resultEvent({ status: "SUCCESS", response: "second." }),
    ].join("\n");
    const outcome = parse(stream);
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.reason.type).toBe("duplicate-result");
      if (outcome.reason.type === "duplicate-result") {
        expect(outcome.reason.firstStatus).toBe("SUCCESS");
      }
    }
  });

  test("identical duplicate results are also rejected (documented safest contract)", () => {
    const stream = [
      resultEvent({ status: "SUCCESS", response: "same." }),
      resultEvent({ status: "SUCCESS", response: "same." }),
    ].join("\n");
    const outcome = parse(stream);
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.reason.type).toBe("duplicate-result");
    }
  });
});

describe("arbitrary chunk boundaries preserve the outcome", () => {
  test("chunked input produces the same outcome as all-at-once", () => {
    const stream = [
      initEvent(),
      stepEvent({ stepIndex: 0, state: "DONE", textDelta: "delta. ", usage: STEP_USAGE }),
      resultEvent({ status: "SUCCESS", response: "response.", usage: RESULT_USAGE }),
    ].join("\n");
    const reference = parse(stream);
    const parser = new NdjsonStreamParser();
    feed(parser, stream, 3);
    expect(parser.finish()).toEqual(reference);
  });
});

describe("onToolInfo: tool steps surface bounded arguments to the gateway bridge", () => {
  const toolStepLine = (extra: Readonly<Record<string, unknown>>): string =>
    `${JSON.stringify({
      event: "step_update",
      conversation_id: "conv-tool",
      step_update: {
        conversation_id: "conv-tool",
        step_index: 3,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        ...extra,
      },
    })}\n`;

  test("tool step with tool_info emits name and parameters as bounded JSON", () => {
    const infos: Array<{ toolName: string; inputJson: string }> = [];
    const parser = new NdjsonStreamParser({
      onToolInfo: (info) => {
        infos.push(info);
      },
    });
    parser.push(toolStepLine({ tool_info: { name: "run_command", parameters: { CommandLine: "ls -la /tmp" } } }));
    parser.finish();
    expect(infos).toEqual([{ toolName: "run_command", inputJson: '{"CommandLine":"ls -la /tmp"}' }]);
  });

  test("tool step without tool_info emits empty-object arguments", () => {
    const infos: Array<{ toolName: string; inputJson: string }> = [];
    const parser = new NdjsonStreamParser({
      onToolInfo: (info) => {
        infos.push(info);
      },
    });
    parser.push(toolStepLine({}));
    parser.finish();
    expect(infos).toEqual([{ toolName: "run_command", inputJson: "{}" }]);
  });

  test("tool_info parameters beyond the bound are truncated with an ellipsis", () => {
    const infos: Array<{ toolName: string; inputJson: string }> = [];
    const parser = new NdjsonStreamParser({
      onToolInfo: (info) => {
        infos.push(info);
      },
    });
    parser.push(toolStepLine({ tool_info: { name: "run_command", parameters: { blob: "x".repeat(10_000) } } }));
    parser.finish();
    expect(infos).toHaveLength(1);
    expect(infos[0]?.inputJson.endsWith("\u2026")).toBe(true);
    expect(infos[0]?.inputJson.length).toBeLessThanOrEqual(4_096);
  });

  test("non-tool step_type never emits tool info even when tool_name is present", () => {
    const infos: Array<{ toolName: string; inputJson: string }> = [];
    const parser = new NdjsonStreamParser({
      onToolInfo: (info) => {
        infos.push(info);
      },
    });
    parser.push(
      `${JSON.stringify({
        event: "step_update",
        conversation_id: "conv-tool",
        step_update: {
          conversation_id: "conv-tool",
          step_index: 3,
          state: "DONE",
          step_type: "thinking",
          tool_name: "run_command",
        },
      })}\n`,
    );
    parser.finish();
    expect(infos).toEqual([]);
  });

  test("progress snapshots never carry tool arguments (parameters stay out of the plugin stream)", () => {
    const snapshots: Array<{ event: string; toolInputJson?: unknown }> = [];
    const infos: Array<{ toolName: string; inputJson: string }> = [];
    const parser = new NdjsonStreamParser({
      onProgress: (snapshot) => {
        snapshots.push(snapshot as { event: string; toolInputJson?: unknown });
      },
      onToolInfo: (info) => {
        infos.push(info);
      },
    });
    parser.push(toolStepLine({ tool_info: { name: "run_command", parameters: { secret: "s3cr3t" } } }));
    parser.finish();
    expect(infos).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(snapshots[0] ?? {}, "toolInputJson")).toBe(false);
    expect(JSON.stringify(snapshots)).not.toContain("s3cr3t");
  });
});
