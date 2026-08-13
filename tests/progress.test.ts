/**
 * Protocol progress observer seam (Todo 9). The parser exposes an optional
 * `onProgress` observer that emits typed, sanitized ProgressSnapshots for the
 * official init / step_update / result events only — reusing the parser's own
 * line framing, bounds and decode. Unknown and malformed lines must never
 * leak a snapshot; a throwing observer must never affect the parse outcome.
 */
import { describe, expect, test } from "bun:test";
import { NdjsonStreamParser } from "../src/protocol";
import type { ParserOutcome, ProgressSnapshot } from "../src/protocol";
import {
  CONVERSATION_ID,
  RESULT_USAGE,
  STEP_USAGE,
  initEvent,
  line,
  officialSuccessStream,
  resultEvent,
  stepEvent,
} from "./fixtures/protocol/streams";

interface Collected {
  readonly snapshots: readonly ProgressSnapshot[];
  readonly outcome: ParserOutcome;
}

function collect(stream: string, chunkSize = 0, maxPendingLineBytes?: number): Collected {
  const snapshots: ProgressSnapshot[] = [];
  const parser = new NdjsonStreamParser({
    onProgress: (snapshot) => {
      snapshots.push(snapshot);
    },
    ...(maxPendingLineBytes === undefined ? {} : { maxPendingLineBytes }),
  });
  if (chunkSize > 0) {
    for (let offset = 0; offset < stream.length; offset += chunkSize) {
      parser.push(stream.slice(offset, offset + chunkSize));
    }
  } else {
    parser.push(stream);
  }
  const outcome = parser.finish();
  return { snapshots, outcome };
}

describe("NdjsonStreamParser onProgress observer", () => {
  test("init event emits one init snapshot with the conversation id", () => {
    const { snapshots } = collect(`${initEvent()}\n`);
    expect(snapshots).toEqual([{ event: "init", conversationId: CONVERSATION_ID }]);
  });

  test("step_update emits a bounded primitive snapshot", () => {
    const { snapshots } = collect(`${stepEvent({ stepIndex: 3, state: "ACTIVE", stepType: "run_command", usage: STEP_USAGE })}\n`);
    expect(snapshots).toEqual([
      {
        event: "step_update",
        conversationId: CONVERSATION_ID,
        stepIndex: 3,
        state: "ACTIVE",
        stepType: "run_command",
        elapsedSeconds: null,
        totalTokens: STEP_USAGE.total_tokens,
      },
    ]);
  });

  test("step_update duration_seconds maps to elapsedSeconds", () => {
    const { snapshots } = collect(`${stepEvent({ stepIndex: 0, state: "DONE", stepType: "checkpoint", durationSeconds: 1.5 })}\n`);
    expect(snapshots[0]).toMatchObject({ event: "step_update", elapsedSeconds: 1.5, totalTokens: null });
  });

  test("step_update with only text_delta yields null metadata fields", () => {
    const { snapshots } = collect(`${line({ event: "step_update", step_update: { text_delta: "responding..." } })}\n`);
    expect(snapshots).toEqual([
      {
        event: "step_update",
        conversationId: null,
        stepIndex: null,
        state: null,
        stepType: null,
        elapsedSeconds: null,
        totalTokens: null,
      },
    ]);
  });

  test("result emits a terminal snapshot with status, conversation id and result usage", () => {
    const { snapshots } = collect(`${resultEvent({ status: "SUCCESS", response: "r", usage: RESULT_USAGE })}\n`);
    expect(snapshots).toEqual([
      { event: "result", status: "SUCCESS", conversationId: CONVERSATION_ID, totalTokens: RESULT_USAGE.total_tokens },
    ]);
  });

  test("snapshot order matches stream event order", () => {
    const { snapshots } = collect(officialSuccessStream());
    expect(snapshots.map((snapshot) => snapshot.event)).toEqual(["init", "step_update", "step_update", "step_update", "result"]);
  });

  test("unknown and malformed lines never leak a snapshot", () => {
    const stream = [line({ event: "bogus", payload: { secret: "x" } }), "this is not json", line({ tool: "no event field" })].join("\n") + "\n";
    const { snapshots } = collect(stream);
    expect(snapshots).toEqual([]);
  });

  test("snapshots are identical across arbitrary chunk boundaries", () => {
    const single = collect(officialSuccessStream());
    const tiny = collect(officialSuccessStream(), 1);
    expect(tiny.snapshots).toEqual(single.snapshots);
    expect(tiny.outcome).toEqual(single.outcome);
  });

  test("a throwing observer never alters the parse outcome", () => {
    const parser = new NdjsonStreamParser({
      onProgress: () => {
        throw new Error("observer exploded");
      },
    });
    parser.push(officialSuccessStream());
    const outcome = parser.finish();
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.text).toContain("Git rebase");
      expect(outcome.usage.total_tokens).toBe(11007);
    }
  });

  test("no snapshots are emitted after finish", () => {
    const snapshots: ProgressSnapshot[] = [];
    const parser = new NdjsonStreamParser({ onProgress: (snapshot) => snapshots.push(snapshot) });
    parser.push(`${initEvent()}\n`);
    parser.finish();
    parser.push(`${stepEvent({ stepIndex: 0, state: "DONE" })}\n`);
    expect(snapshots).toEqual([{ event: "init", conversationId: CONVERSATION_ID }]);
  });

  test("oversized lines are skipped and emit no snapshot", () => {
    const huge = `${line({ event: "init", conversation_id: "x".repeat(300) })}\n`;
    const { snapshots, outcome } = collect(`${initEvent()}\n${huge}${stepEvent({ stepIndex: 0, state: "DONE" })}\n`, 0, 240);
    expect(snapshots.map((snapshot) => snapshot.event)).toEqual(["init", "step_update"]);
    expect(outcome.diagnostics.some((diagnostic) => diagnostic.kind === "line-too-long")).toBe(true);
  });
});
