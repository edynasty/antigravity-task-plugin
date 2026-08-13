/**
 * Plugin live-progress wiring (Todo 9). The tool maps runner ProgressUpdates
 * to throttled `context.metadata({ title, metadata })` calls: first start and
 * terminal updates always delivered, intermediate updates coalesced, the
 * metadata UI callback isolated so it can never fail or abort the agy task,
 * and no timer or metadata call surviving execute's resolve.
 */
import { describe, expect, test } from "bun:test";
import { PROGRESS_MIN_INTERVAL_MS, createAntigravityTaskTool, createProgressDispatcher, progressToMetadata } from "../src/index";
import type { RunnerDeps } from "../src/runner-types";
import { ProcessError } from "../src/process-types";
import {
  initLine,
  makeFakeDeps,
  mockToolContext,
  processResult,
  resultLine,
  stepLine,
  successStream,
} from "./helpers/runner-harness";

const SECRET = "super-secret-progress-value";

type RecordedUpdate = { readonly title: string; readonly metadata: Record<string, unknown>; readonly at: number };

function metadataRecorder() {
  const context = mockToolContext();
  const updates: RecordedUpdate[] = [];
  context.metadata = (input: { title?: string; metadata?: Record<string, unknown> }) => {
    updates.push({ title: input.title ?? "", metadata: input.metadata ?? {}, at: Date.now() });
  };
  return { context, updates };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function lineChunks(lines: readonly string[]): string[] {
  return lines.map((ndjsonLine) => `${ndjsonLine}\n`);
}

function delayedDeps(chunks: readonly string[], delayMs: number, result = processResult({ chunks })): RunnerDeps {
  const base = makeFakeDeps();
  return {
    ...base.deps,
    runAgy: async (options) => {
      for (const chunk of chunks) {
        options.onStdoutChunk?.(chunk);
        await sleep(delayMs);
      }
      return result;
    },
  };
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

describe("antigravity-task tool live progress", () => {
  test("starting title first and terminal SUCCESS last, final payload unchanged", async () => {
    const { context, updates } = metadataRecorder();
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: successStream("final answer.") }));
    const result = await createAntigravityTaskTool(fake.deps).execute({ task: "do it" }, context);

    expect(result).toMatchObject({ title: "antigravity-task: SUCCESS" });
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0]?.title).toBe("antigravity-task: starting");
    expect(updates[updates.length - 1]?.title).toBe("antigravity-task: SUCCESS");
  });

  test("slow runs surface the step title with bounded metadata fields", async () => {
    const { context, updates } = metadataRecorder();
    const chunks = lineChunks([initLine(), stepLine(), resultLine("SUCCESS", "slow.")]);
    const deps = delayedDeps(chunks, PROGRESS_MIN_INTERVAL_MS + 20, processResult({ chunks }));
    await createAntigravityTaskTool(deps).execute({ task: "slow" }, context);

    const stepUpdate = updates.find((update) => update.title.startsWith("antigravity-task: step "));
    expect(stepUpdate?.title).toBe("antigravity-task: step 0 agent_response");
    expect(stepUpdate?.metadata["stepType"]).toBe("agent_response");
    expect(stepUpdate?.metadata["stepIndex"]).toBe(0);
    expect(updates[updates.length - 1]?.title).toBe("antigravity-task: SUCCESS");
  });

  test("many ACTIVE text_delta events coalesce; callback count bounded and terminal kept", async () => {
    const { context, updates } = metadataRecorder();
    const manySteps: string[] = lineChunks([initLine()]);
    for (let index = 0; index < 50; index += 1) {
      manySteps.push(`${stepLine()}\n`);
    }
    manySteps.push(`${resultLine("SUCCESS", "many.")}\n`);
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ chunks: manySteps }));
    await createAntigravityTaskTool(fake.deps).execute({ task: "many" }, context);

    expect(updates.length).toBeLessThan(manySteps.length);
    expect(updates[updates.length - 1]?.title).toBe("antigravity-task: SUCCESS");
    expect(updates[0]?.title).toBe("antigravity-task: starting");
  });

  test("a throwing context.metadata never fails or alters the final payload", async () => {
    const context = mockToolContext();
    context.metadata = () => {
      throw new Error("ui exploded");
    };
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: successStream("final answer.") }));
    const result = await createAntigravityTaskTool(fake.deps).execute({ task: "do it" }, context);
    expect(result).toMatchObject({ title: "antigravity-task: SUCCESS" });
  });

  test("no metadata updates occur after execute resolves", async () => {
    const { context, updates } = metadataRecorder();
    const chunks = lineChunks([initLine(), stepLine(), resultLine("SUCCESS", "tail.")]);
    const deps = delayedDeps(chunks, 10, processResult({ chunks }));
    await createAntigravityTaskTool(deps).execute({ task: "tail" }, context);
    const afterResolve = Date.now();
    await sleep(PROGRESS_MIN_INTERVAL_MS + 60);

    for (const update of updates) {
      expect(update.at).toBeLessThanOrEqual(afterResolve);
    }
    expect(updates[updates.length - 1]?.title).toBe("antigravity-task: SUCCESS");
  });

  test("no sensitive prompt/cwd/env/output text reaches titles or metadata", async () => {
    const secretStream = [
      JSON.stringify({ event: "init", conversation_id: "conv-safe", init: { cwd: `/secret/${SECRET}` } }),
      JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-safe", step_index: 0, state: "DONE", text_delta: `text-${SECRET}` } }),
      resultLine("SUCCESS", `response-${SECRET}`),
    ].join("\n");
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: secretStream }));
    const deps: RunnerDeps = { ...fake.deps, env: { PATH: "/usr/bin", AGY_PATH: `/secret/${SECRET}/agy` } };
    const context2 = mockToolContext("/secret/cwd");
    const updates2: RecordedUpdate[] = [];
    context2.metadata = (input: { title?: string; metadata?: Record<string, unknown> }) => {
      updates2.push({ title: input.title ?? "", metadata: input.metadata ?? {}, at: Date.now() });
    };
    await createAntigravityTaskTool(deps).execute({ task: `task-${SECRET}` }, context2);

    const serialized = JSON.stringify(updates2.map((update) => ({ title: update.title, metadata: update.metadata })));
    expect(serialized).not.toContain(SECRET);
  });

  test("failure paths emit a final bounded failure title before returning the payload", async () => {
    const { context, updates } = metadataRecorder();
    const result = await createAntigravityTaskTool(makeFakeDeps().deps).execute({ task: "   " }, context);
    expect(result).toMatchObject({ title: "antigravity-task: empty-task" });
    expect(updates[updates.length - 1]?.title).toBe("antigravity-task: empty-task");
  });

  test("timeout failure keeps the existing payload and emits a bounded failure title", async () => {
    const { context, updates } = metadataRecorder();
    const fake = makeFakeDeps();
    fake.failRun(new ProcessError("timeout", "agy run exceeded the host timeout", { pid: 9, exit: { exitCode: null, signal: "SIGTERM" } }));
    const result = await createAntigravityTaskTool(fake.deps).execute({ task: "t" }, context);
    expect(result).toMatchObject({ title: "antigravity-task: timeout" });
    expect(updates[updates.length - 1]?.title).toBe("antigravity-task: timeout");
  });
});
