/**
 * Progress metadata mapper + throttle dispatcher (Todo 10 fix). The mapper is
 * the final UI sanitization boundary: every string entering title or metadata
 * is redacted first, then bounded, so credential-shaped stepType/state/
 * conversationId values can never cross unredacted and no field can exceed
 * MAX_PROGRESS_FIELD_CHARS. Official constants are preserved.
 */
import { describe, expect, test } from "bun:test";
import { createProgressDispatcher, progressToMetadata } from "../src/index";

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

describe("progressToMetadata mapper", () => {
  test("maps start to the starting title", () => {
    expect(progressToMetadata({ event: "start" })).toEqual({
      title: "antigravity-task: starting",
      metadata: { phase: "starting" },
    });
  });

  test("maps step_update with step type to a step title with bounded fields", () => {
    const mapped = progressToMetadata({
      event: "step_update",
      conversationId: "conv-1",
      stepIndex: 3,
      state: "ACTIVE",
      stepType: "run_command",
      elapsedSeconds: 1.5,
      totalTokens: 7,
    });
    expect(mapped.title).toBe("antigravity-task: step 3 run_command");
    expect(mapped.metadata).toEqual({
      phase: "step 3 run_command",
      conversationId: "conv-1",
      stepIndex: 3,
      state: "ACTIVE",
      stepType: "run_command",
      elapsedSeconds: 1.5,
      totalTokens: 7,
    });
  });

  test("maps bare step_update to the responding title", () => {
    const mapped = progressToMetadata({
      event: "step_update",
      conversationId: null,
      stepIndex: null,
      state: null,
      stepType: null,
      elapsedSeconds: null,
      totalTokens: null,
    });
    expect(mapped.title).toBe("antigravity-task: responding");
    expect(mapped.metadata).toEqual({ phase: "responding" });
  });

  test("maps terminal success and failure kinds to bounded titles", () => {
    expect(progressToMetadata({ event: "terminal", kind: "success", conversationId: null, totalTokens: 15 }).title).toBe("antigravity-task: SUCCESS");
    expect(progressToMetadata({ event: "terminal", kind: "timeout", conversationId: null, totalTokens: 0 }).title).toBe("antigravity-task: timeout");
  });

  test("credential-shaped stepType and state are redacted before bounding", () => {
    const mapped = progressToMetadata({
      event: "step_update",
      conversationId: null,
      stepIndex: 0,
      state: "api_key=AKIAIOSFODNN7EXAMPLE",
      stepType: "sk-ant-1234567890abcdef1234567890abcdef",
      elapsedSeconds: null,
      totalTokens: null,
    });
    expect(mapped.title).toBe("antigravity-task: step 0 [REDACTED]");
    expect(mapped.metadata["stepType"]).toBe("[REDACTED]");
    expect(mapped.metadata["state"]).toBe("[REDACTED]");
    expect(mapped.title).not.toContain("sk-ant-1234567890abcdef1234567890abcdef");
    expect(mapped.title).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("conversationId is bounded to 200 chars in init, step_update and terminal metadata", () => {
    const huge = "x".repeat(60_000);
    const init = progressToMetadata({ event: "init", conversationId: huge });
    expect(String(init.metadata["conversationId"])).toHaveLength(200);

    const step = progressToMetadata({
      event: "step_update",
      conversationId: huge,
      stepIndex: 0,
      state: null,
      stepType: null,
      elapsedSeconds: null,
      totalTokens: null,
    });
    expect(String(step.metadata["conversationId"])).toHaveLength(200);

    const terminal = progressToMetadata({ event: "terminal", kind: "success", conversationId: huge, totalTokens: 1 });
    expect(String(terminal.metadata["conversationId"])).toHaveLength(200);
  });

  test("credential-shaped conversationId is redacted before bound", () => {
    const mapped = progressToMetadata({ event: "init", conversationId: "sk-ant-1234567890abcdef1234567890abcdef" });
    expect(mapped.metadata["conversationId"]).toBe("[REDACTED]");
  });

  test("safe official status and kind constants are preserved unredacted", () => {
    const mapped = progressToMetadata({
      event: "step_update",
      conversationId: "conv-ok",
      stepIndex: 1,
      state: "ACTIVE",
      stepType: "run_command",
      elapsedSeconds: 0.5,
      totalTokens: 7,
    });
    expect(mapped.title).toBe("antigravity-task: step 1 run_command");
    expect(mapped.metadata["state"]).toBe("ACTIVE");
    expect(progressToMetadata({ event: "terminal", kind: "success", conversationId: null, totalTokens: 5 }).metadata["phase"]).toBe("SUCCESS");
  });

  test("caps unbounded string fields before they reach metadata", () => {
    const mapped = progressToMetadata({
      event: "step_update",
      conversationId: null,
      stepIndex: 1,
      state: "x".repeat(500),
      stepType: "y".repeat(500),
      elapsedSeconds: null,
      totalTokens: null,
    });
    expect(mapped.metadata["state"]).toHaveLength(200);
    expect(mapped.metadata["stepType"]).toHaveLength(200);
    expect(String(mapped.metadata["state"])).not.toContain("y".repeat(500));
  });
});

describe("createProgressDispatcher throttling", () => {
  test("first update immediate; trailing pending flushed; no orphan timer", async () => {
    const calls: Array<{ title: string; metadata: Record<string, unknown>; at: number }> = [];
    const dispatcher = createProgressDispatcher((input) => {
      calls.push({ title: input.title ?? "", metadata: input.metadata ?? {}, at: Date.now() });
    }, 20);

    dispatcher.dispatch({ event: "start" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.title).toBe("antigravity-task: starting");

    for (let index = 0; index < 20; index += 1) {
      dispatcher.dispatch({ event: "step_update", conversationId: null, stepIndex: index, state: "ACTIVE", stepType: null, elapsedSeconds: null, totalTokens: null });
    }
    expect(calls.length).toBe(1);

    dispatcher.flush();
    expect(calls.length).toBe(2);
    expect(calls[1]?.title).toBe("antigravity-task: responding");

    await sleep(80);
    expect(calls.length).toBe(2);
  });
});
