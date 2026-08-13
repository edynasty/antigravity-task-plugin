/**
 * Runner progress lifecycle (Todo 9). runAntigravityTask emits typed progress
 * through the optional RunnerContext.onProgress: a start update before spawn,
 * parser snapshots while the child runs, and exactly one terminal update last.
 * A throwing progress consumer must never alter the authoritative payload, and
 * progress must never expose prompt/cwd/env/executable/output text.
 */
import { describe, expect, test } from "bun:test";
import { runAntigravityTask } from "../src/runner";
import { ProcessError } from "../src/process-types";
import type { ProgressUpdate, RunnerContext, RunnerDeps } from "../src/runner-types";
import {
  CONVERSATION_ID,
  RESULT_USAGE,
  initLine,
  makeFakeDeps,
  processResult,
  progressContext,
  resultLine,
  stepLine,
  successStream,
} from "./helpers/runner-harness";

const SECRET = "s3cr3t-progress-value";

function orderedDeps(order: string[]): { readonly deps: RunnerDeps; readonly fake: ReturnType<typeof makeFakeDeps> } {
  const fake = makeFakeDeps();
  const deps: RunnerDeps = {
    ...fake.deps,
    runAgy: async (options) => {
      order.push("runAgy-called");
      return fake.deps.runAgy(options);
    },
  };
  return { deps, fake };
}

describe("runAntigravityTask progress lifecycle", () => {
  test("start precedes spawn; parser snapshots precede terminal; terminal is last on success", async () => {
    const order: string[] = [];
    const { deps, fake } = orderedDeps(order);
    fake.setRunResult(processResult({ stdout: successStream("done.") }));
    const updates: ProgressUpdate[] = [];
    const ctx: RunnerContext = {
      cwd: "/work",
      signal: new AbortController().signal,
      onProgress: (update) => {
        order.push(`progress:${update.event}`);
        updates.push(update);
      },
    };

    const payload = await runAntigravityTask({ task: "t" }, ctx, deps);

    expect(payload.metadata.ok).toBe(true);
    expect(order[0]).toBe("progress:start");
    expect(order.indexOf("progress:start")).toBeLessThan(order.indexOf("runAgy-called"));
    const events = updates.map((update) => update.event);
    expect(events[events.length - 1]).toBe("terminal");
    expect(updates[updates.length - 1]).toEqual({
      event: "terminal",
      kind: "success",
      conversationId: CONVERSATION_ID,
      totalTokens: RESULT_USAGE.total_tokens,
    });
  });

  test("validation failure emits start then a single terminal failure update", async () => {
    const { ctx, updates } = progressContext();
    const fake = makeFakeDeps();
    const payload = await runAntigravityTask({ task: "   " }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    expect(updates.map((update) => update.event)).toEqual(["start", "terminal"]);
    expect(updates[1]).toMatchObject({ event: "terminal", kind: "empty-task" });
  });

  test("process failure maps to a terminal failure update with bounded kind", async () => {
    const fake = makeFakeDeps();
    fake.failRun(new ProcessError("timeout", "agy run exceeded the host timeout", { pid: 7, exit: { exitCode: null, signal: "SIGTERM" } }));
    const { ctx, updates } = progressContext();
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    if (!payload.metadata.ok) {
      expect(payload.metadata.kind).toBe("timeout");
    }
    expect(updates[updates.length - 1]).toMatchObject({ event: "terminal", kind: "timeout" });
  });

  test("protocol failure (duplicate result) ends with a terminal failure update", async () => {
    const fake = makeFakeDeps();
    const duplicate = [initLine(), resultLine("SUCCESS", "first"), resultLine("SUCCESS", "second")].join("\n");
    fake.setRunResult(processResult({ stdout: duplicate }));
    const { ctx, updates } = progressContext();
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    if (!payload.metadata.ok) {
      expect(payload.metadata.kind).toBe("duplicate-result");
    }
    expect(updates[updates.length - 1]).toMatchObject({ event: "terminal", kind: "duplicate-result" });
  });

  test("a throwing progress consumer never changes the final payload", async () => {
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: successStream("final answer.") }));
    const control = await runAntigravityTask({ task: "do it" }, { cwd: "/work", signal: new AbortController().signal }, fake.deps);

    fake.setRunResult(processResult({ stdout: successStream("final answer.") }));
    const throwing = await runAntigravityTask(
      { task: "do it" },
      {
        cwd: "/work",
        signal: new AbortController().signal,
        onProgress: () => {
          throw new Error("boom");
        },
      },
      fake.deps,
    );
    expect(throwing).toEqual(control);
  });

  test("no sensitive values from prompt/cwd/env/output ever reach progress", async () => {
    const secretCwd = `/private/secret/${SECRET}`;
    const secretTask = `task-with-${SECRET}`;
    const secretEnv = { PATH: "/usr/bin", AGY_PATH: `/secret/${SECRET}/agy` };
    const secretStream = [initLine(), stepLine(), resultLine("SUCCESS", `response-contains-${SECRET}`)].join("\n");
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: secretStream, stderr: `stderr-${SECRET}` }));
    const { ctx, updates } = progressContext(secretCwd);
    const deps: RunnerDeps = { ...fake.deps, env: secretEnv };

    await runAntigravityTask({ task: secretTask }, ctx, deps);

    const serialized = JSON.stringify(updates);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(secretCwd);
    expect(serialized).not.toContain(secretTask);
  });

  test("baseline: without onProgress the payload stays byte/shape compatible", async () => {
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: successStream("baseline answer.") }));
    const without = await runAntigravityTask({ task: "t" }, { cwd: "/work", signal: new AbortController().signal }, fake.deps);

    fake.setRunResult(processResult({ stdout: successStream("baseline answer.") }));
    const { ctx } = progressContext();
    const withProgress = await runAntigravityTask({ task: "t" }, ctx, fake.deps);
    expect(withProgress).toEqual(without);
  });
});
