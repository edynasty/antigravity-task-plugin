import { describe, expect, test } from "bun:test";
import { HOST_GRACE_MS } from "../src/process-types";
import { runAntigravityTask } from "../src/runner";
import { makeFakeDeps, runContext } from "./helpers/runner-harness";

describe("runAntigravityTask argv, environment and pre-spawn validation", () => {
  test("default args produce execute-mode argv with 300s timeout", async () => {
    const fake = makeFakeDeps();
    const { ctx } = runContext();
    await runAntigravityTask({ task: "deploy the app" }, ctx, fake.deps);

    expect(fake.runCalls.length).toBe(1);
    expect(fake.runCalls[0]?.argv).toEqual([
      "/fake/agy",
      "-p",
      "deploy the app",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "300s",
      "--mode",
      "accept-edits",
    ]);
  });

  test("plan args append model, conversation id, explicit timeout and sandbox", async () => {
    const fake = makeFakeDeps();
    const { ctx } = runContext();
    await runAntigravityTask(
      { task: "plan the refactor", mode: "plan", timeoutSeconds: 60, model: "gemini-2.5-flash", conversationId: "conv-9", sandbox: true },
      ctx,
      fake.deps,
    );

    expect(fake.runCalls[0]?.argv).toEqual([
      "/fake/agy",
      "-p",
      "plan the refactor",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "60s",
      "--mode",
      "plan",
      "--model",
      "gemini-2.5-flash",
      "--conversation",
      "conv-9",
      "--sandbox",
    ]);
  });

  test("continueConversation maps to the --continue flag", async () => {
    const fake = makeFakeDeps();
    const { ctx } = runContext();
    await runAntigravityTask({ task: "t", continueConversation: true }, ctx, fake.deps);

    expect(fake.runCalls[0]?.argv).toEqual([
      "/fake/agy",
      "-p",
      "t",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "300s",
      "--mode",
      "accept-edits",
      "--continue",
    ]);
  });

  test("passes cwd, the caller abort signal and the inherited env to the subprocess", async () => {
    const fake = makeFakeDeps();
    const { ctx, signal } = runContext("/project/alpha");
    await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(fake.runCalls[0]?.cwd).toBe("/project/alpha");
    expect(fake.runCalls[0]?.signal).toBe(signal);
    expect(fake.runCalls[0]?.env).toBe(fake.deps.env);
  });

  test("host timeout derives from timeoutSeconds plus the documented grace", async () => {
    const fake = makeFakeDeps();
    const { ctx } = runContext();
    await runAntigravityTask({ task: "t", timeoutSeconds: 120 }, ctx, fake.deps);

    expect(fake.runCalls[0]?.hostTimeoutMs).toBe(120_000 + HOST_GRACE_MS);
  });

  test("conversation conflict fails before executable discovery or spawn", async () => {
    const fake = makeFakeDeps();
    const { ctx } = runContext();
    const payload = await runAntigravityTask({ task: "t", conversationId: "c", continueConversation: true }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    if (!payload.metadata.ok) {
      expect(payload.metadata.kind).toBe("conversation-conflict");
      expect(payload.metadata.message).toMatch(/mutually exclusive/);
    }
    expect(fake.resolveCalls).toBe(0);
    expect(fake.runCalls.length).toBe(0);
  });

  test("blank task fails before executable discovery or spawn", async () => {
    const fake = makeFakeDeps();
    const { ctx } = runContext();
    const payload = await runAntigravityTask({ task: "   " }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    if (!payload.metadata.ok) {
      expect(payload.metadata.kind).toBe("empty-task");
    }
    expect(fake.resolveCalls).toBe(0);
    expect(fake.runCalls.length).toBe(0);
  });

  test("non-integer timeout fails before executable discovery or spawn", async () => {
    const fake = makeFakeDeps();
    const { ctx } = runContext();
    const payload = await runAntigravityTask({ task: "t", timeoutSeconds: 2.5 }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    if (!payload.metadata.ok) {
      expect(payload.metadata.kind).toBe("invalid-timeout");
    }
    expect(fake.resolveCalls).toBe(0);
    expect(fake.runCalls.length).toBe(0);
  });
});
