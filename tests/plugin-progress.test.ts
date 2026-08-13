/**
 * Plugin live-progress wiring (Todo 9/10). The tool maps runner ProgressUpdates
 * to throttled `context.metadata({ title, metadata })` calls: first start and
 * terminal updates always delivered, intermediate updates coalesced, the
 * metadata UI callback isolated so it can never fail or abort the agy task,
 * and no timer or metadata call surviving execute's resolve. Result authority
 * is deferred: invalid/duplicate results never claim SUCCESS mid-run, and a
 * valid run emits exactly one terminal SUCCESS last.
 */
import { describe, expect, test } from "bun:test";
import { PROGRESS_MIN_INTERVAL_MS, createAntigravityTaskTool } from "../src/index";
import type { RunnerDeps } from "../src/runner-types";
import { ProcessError } from "../src/process-types";
import { line } from "./fixtures/protocol/streams";
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

describe("antigravity-task tool live progress", () => {
  test("starting title first and exactly one terminal SUCCESS last, final payload unchanged", async () => {
    const { context, updates } = metadataRecorder();
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: successStream("final answer.") }));
    const result = await createAntigravityTaskTool(fake.deps).execute({ task: "do it" }, context);

    expect(result).toMatchObject({ title: "antigravity-task: SUCCESS" });
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0]?.title).toBe("antigravity-task: starting");
    expect(updates.filter((update) => update.title === "antigravity-task: SUCCESS").length).toBe(1);
    expect(updates[updates.length - 1]?.title).toBe("antigravity-task: SUCCESS");
  });

  test("slow runs surface the step title with bounded metadata fields and one SUCCESS", async () => {
    const { context, updates } = metadataRecorder();
    const chunks = lineChunks([initLine(), stepLine(), resultLine("SUCCESS", "slow.")]);
    const deps = delayedDeps(chunks, PROGRESS_MIN_INTERVAL_MS + 20, processResult({ chunks }));
    await createAntigravityTaskTool(deps).execute({ task: "slow" }, context);

    const stepUpdate = updates.find((update) => update.title.startsWith("antigravity-task: step "));
    expect(stepUpdate?.title).toBe("antigravity-task: step 0 agent_response");
    expect(stepUpdate?.metadata["stepType"]).toBe("agent_response");
    expect(stepUpdate?.metadata["stepIndex"]).toBe(0);
    expect(updates.filter((update) => update.title === "antigravity-task: SUCCESS").length).toBe(1);
    expect(updates[updates.length - 1]?.title).toBe("antigravity-task: SUCCESS");
  });

  test("structurally invalid result never claims SUCCESS; terminal invalid-result is last", async () => {
    const { context, updates } = metadataRecorder();
    const invalidResult = line({ event: "result", result: { conversation_id: "conv-x", status: "SUCCESS" } });
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ chunks: lineChunks([initLine(), invalidResult]) }));
    const result = await createAntigravityTaskTool(fake.deps).execute({ task: "invalid" }, context);

    expect(result).toMatchObject({ title: "antigravity-task: invalid-result" });
    const titles = updates.map((update) => update.title);
    expect(titles.filter((title) => title === "antigravity-task: SUCCESS")).toEqual([]);
    expect(titles[titles.length - 1]).toBe("antigravity-task: invalid-result");
  });

  test("duplicate result never claims SUCCESS; terminal duplicate-result is last", async () => {
    const { context, updates } = metadataRecorder();
    const fake = makeFakeDeps();
    fake.setRunResult(
      processResult({ chunks: lineChunks([initLine(), resultLine("SUCCESS", "first"), resultLine("SUCCESS", "second")]) }),
    );
    const result = await createAntigravityTaskTool(fake.deps).execute({ task: "dup" }, context);

    expect(result).toMatchObject({ title: "antigravity-task: duplicate-result" });
    const titles = updates.map((update) => update.title);
    expect(titles.filter((title) => title === "antigravity-task: SUCCESS")).toEqual([]);
    expect(titles[titles.length - 1]).toBe("antigravity-task: duplicate-result");
  });

  test("credential-shaped delayed stream never leaks secrets into titles or metadata", async () => {
    const { context, updates } = metadataRecorder();
    const chunks = lineChunks([
      initLine(),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-safe",
          step_index: 0,
          state: "api_key=AKIAIOSFODNN7EXAMPLE",
          step_type: "sk-ant-1234567890abcdef1234567890abcdef",
        },
      }),
      resultLine("SUCCESS", "ok."),
    ]);
    const deps = delayedDeps(chunks, PROGRESS_MIN_INTERVAL_MS + 20, processResult({ chunks }));
    await createAntigravityTaskTool(deps).execute({ task: "secret" }, context);

    const serialized = JSON.stringify(updates.map((update) => ({ title: update.title, metadata: update.metadata })));
    expect(serialized).not.toContain("sk-ant-1234567890abcdef1234567890abcdef");
    expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(serialized).toContain("[REDACTED]");
  });

  test("60000-char conversationId is bounded at the tool boundary", async () => {
    const { context, updates } = metadataRecorder();
    const huge = "x".repeat(60_000);
    const chunks = lineChunks([
      JSON.stringify({ event: "init", conversation_id: huge, init: { cwd: "/w", tools: [] } }),
      stepLine(),
      resultLine("SUCCESS", "ok."),
    ]);
    const deps = delayedDeps(chunks, 10, processResult({ chunks }));
    await createAntigravityTaskTool(deps).execute({ task: "huge" }, context);

    for (const update of updates) {
      if (typeof update.metadata["conversationId"] === "string") {
        expect(update.metadata["conversationId"]).toHaveLength(200);
      }
    }
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
