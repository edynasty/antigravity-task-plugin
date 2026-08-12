import { describe, expect, test } from "bun:test";
import { ProcessError, ResolveError } from "../src/process-types";
import type { ProcessExit } from "../src/process-types";
import { runAntigravityTask } from "../src/runner";
import {
  CONVERSATION_ID,
  initLine,
  makeFakeDeps,
  processResult,
  RESULT_USAGE,
  resultLine,
  runContext,
  successStream,
  type ProcOverrides,
} from "./helpers/runner-harness";

const NON_SUCCESS_STATUSES = ["ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING"] as const;

describe("runAntigravityTask composition", () => {
  test("success: authoritative response text, conversation id and result usage", async () => {
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: successStream("final answer.") }));
    const { ctx } = runContext();
    const payload = await runAntigravityTask({ task: "do it" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(true);
    if (payload.metadata.ok) {
      expect(payload.output).toBe("final answer.");
      expect(payload.title).toBe("antigravity-task: SUCCESS");
      expect(payload.metadata.kind).toBe("success");
      expect(payload.metadata.status).toBe("SUCCESS");
      expect(payload.metadata.conversationId).toBe(CONVERSATION_ID);
      expect(payload.metadata.usage).toEqual(RESULT_USAGE);
      expect(payload.metadata.exit).toEqual({ exitCode: 0, signal: null });
      expect(payload.metadata.diagnostics).toEqual([]);
      expect(payload.metadata.droppedDiagnostics).toBe(0);
    }
  });

  test("every captured stdout chunk feeds one fresh parser instance", async () => {
    const fake = makeFakeDeps();
    const stream = successStream("chunked answer.");
    const split = Math.floor(stream.length / 2);
    fake.setRunResult(processResult({ chunks: [stream.slice(0, split), stream.slice(split)] }));
    const { ctx } = runContext();
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(true);
    if (payload.metadata.ok) {
      expect(payload.output).toBe("chunked answer.");
    }
  });

  test("resolve failure is bounded and never embeds a machine path", async () => {
    const fake = makeFakeDeps();
    fake.failResolve(new ResolveError("not-found", "agy command agy was not found on PATH (checked AGY_PATH and PATH)", "/tmp/private/agy"));
    const { ctx } = runContext();
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    if (!payload.metadata.ok) {
      expect(payload.metadata.kind).toBe("resolve-not-found");
      expect(payload.output).not.toContain("/tmp/private/agy");
      expect(payload.metadata.message).not.toContain("/tmp/private/agy");
      expect(payload.metadata.status).toBeNull();
      expect(payload.metadata.exit).toBeNull();
    }
  });

  test("spawn-failed maps to a typed failure with exit surfaced", async () => {
    const fake = makeFakeDeps();
    fake.failRun(new ProcessError("spawn-failed", "failed to spawn agy: EACCES", { pid: 7 }));
    const { ctx } = runContext();
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    if (!payload.metadata.ok) {
      expect(payload.metadata.kind).toBe("spawn-failed");
      expect(payload.metadata.status).toBeNull();
      expect(payload.metadata.conversationId).toBeNull();
      expect(payload.metadata.exit).toBeNull();
    }
  });

  test("timeout and abort map to distinguishable typed failures", async () => {
    const cases = [
      { error: new ProcessError("timeout", "agy run (pid 9) exceeded the host timeout", { pid: 9, exit: { exitCode: null, signal: "SIGKILL" } }), kind: "timeout" as const },
      { error: new ProcessError("aborted", "agy run (pid 10) was aborted", { pid: 10, exit: { exitCode: null, signal: "SIGTERM" } }), kind: "aborted" as const },
    ];
    for (const entry of cases) {
      const fake = makeFakeDeps();
      fake.failRun(entry.error);
      const { ctx } = runContext();
      const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

      expect(payload.metadata.ok).toBe(false);
      if (!payload.metadata.ok) {
        expect(payload.metadata.kind).toBe(entry.kind);
        expect(payload.metadata.exit).toEqual({ exitCode: null, signal: entry.error.kind === "timeout" ? "SIGKILL" : "SIGTERM" });
      }
    }
  });

  test("a pre-aborted signal propagates as an aborted failure", async () => {
    const fake = makeFakeDeps();
    const controller = new AbortController();
    controller.abort();
    const payload = await runAntigravityTask({ task: "t" }, { cwd: "/work", signal: controller.signal }, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    if (!payload.metadata.ok) {
      expect(payload.metadata.kind).toBe("aborted");
    }
  });

  test("each non-SUCCESS status is a distinguishable status failure", async () => {
    for (const status of NON_SUCCESS_STATUSES) {
      const fake = makeFakeDeps();
      fake.setRunResult(processResult({ stdout: `${initLine()}\n${resultLine(status, "")}\n` }));
      const { ctx } = runContext();
      const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

      expect(payload.metadata.ok).toBe(false);
      if (!payload.metadata.ok) {
        expect(payload.metadata.kind).toBe("status");
        expect(payload.metadata.status).toBe(status);
        expect(payload.title).toBe("antigravity-task: status");
      }
    }
  });

  test("empty output is a distinguishable failure", async () => {
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: `${initLine()}\n${resultLine("SUCCESS", "")}\n` }));
    const { ctx } = runContext();
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    if (!payload.metadata.ok) {
      expect(payload.metadata.kind).toBe("empty-output");
    }
  });

  test("a stream without a terminal result is a distinguishable failure", async () => {
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: "not json\nmore noise\n" }));
    const { ctx } = runContext();
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    if (!payload.metadata.ok) {
      expect(payload.metadata.kind).toBe("missing-result");
      expect(payload.metadata.status).toBeNull();
      expect(payload.metadata.diagnostics.length).toBeGreaterThan(0);
    }
  });

  test("a duplicate terminal result is a distinguishable failure", async () => {
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: `${initLine()}\n${resultLine("SUCCESS", "one")}\n${resultLine("SUCCESS", "two")}\n` }));
    const { ctx } = runContext();
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    if (!payload.metadata.ok) {
      expect(payload.metadata.kind).toBe("duplicate-result");
    }
  });

  test("an invalid result envelope is a distinguishable failure", async () => {
    const bad = JSON.stringify({ event: "result", result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", usage: RESULT_USAGE } });
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: `${initLine()}\n${bad}\n` }));
    const { ctx } = runContext();
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    if (!payload.metadata.ok) {
      expect(payload.metadata.kind).toBe("invalid-result");
    }
  });

  test("nonzero exit and signal death despite a SUCCESS stream are failures with exit surfaced", async () => {
    const cases: readonly { readonly overrides: ProcOverrides; readonly exit: ProcessExit }[] = [
      { overrides: { exitCode: 1, signal: null }, exit: { exitCode: 1, signal: null } },
      { overrides: { signal: "SIGTERM" }, exit: { exitCode: null, signal: "SIGTERM" } },
    ];
    for (const entry of cases) {
      const fake = makeFakeDeps();
      fake.setRunResult(processResult({ stdout: successStream("done."), ...entry.overrides }));
      const { ctx } = runContext();
      const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

      expect(payload.metadata.ok).toBe(false);
      if (!payload.metadata.ok) {
        expect(payload.metadata.kind).toBe("nonzero-exit");
        expect(payload.metadata.status).toBe("SUCCESS");
        expect(payload.metadata.exit).toEqual(entry.exit);
      }
    }
  });
});
