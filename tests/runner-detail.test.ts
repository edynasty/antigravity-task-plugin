/**
 * Final execution-detail block (information transparency). The tool `output`
 * gains a bounded, sanitized detail block assembled from the final
 * authoritative metadata (never progress snapshots): task (single-line,
 * 200-cap), mode, model actually used (or unknown/default), agent,
 * permission_mode, status, conversationId, durationSeconds, totalTokens, exit
 * and bounded stderr. Every free-text value is redacted before bounding; raw
 * prompt bodies beyond the task cap, NDJSON, tool parameters/output, cwd, env
 * and credentials never appear. Failure paths still emit a bounded detail
 * block plus one terminal progress update.
 */
import { describe, expect, test } from "bun:test";
import { MAX_DIAGNOSTIC_CHARS } from "../src/runner-types";
import { ProcessError } from "../src/process-types";
import type { RunnerFailureKind } from "../src/runner-types";
import { runAntigravityTask } from "../src/runner";
import {
  CONVERSATION_ID,
  initLine,
  makeFakeDeps,
  processResult,
  progressContext,
  resultLine,
  stepLine,
  successStream,
} from "./helpers/runner-harness";

const DETAIL_HEADER = "antigravity-task execution details";

function initLineWith(extra: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    event: "init",
    conversation_id: CONVERSATION_ID,
    init: { cwd: "/work", tools: ["run_command", "write_to_file"], permission_mode: "request-review", ...extra },
  });
}

describe("final output execution-detail block", () => {
  test("success output carries the full detail block from authoritative metadata", async () => {
    const fake = makeFakeDeps();
    const stream = [
      initLineWith({ model: "claude-sonnet-4-6", agent: "antigravity-agent" }),
      stepLine(),
      resultLine("SUCCESS", "done."),
    ].join("\n");
    fake.setRunResult(processResult({ stdout: stream }));
    const { ctx } = progressContext();
    const payload = await runAntigravityTask({ task: "refactor the payment module", mode: "execute" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(true);
    expect(payload.output).toContain("done.");
    expect(payload.output).toContain(DETAIL_HEADER);
    expect(payload.output).toContain("task: refactor the payment module");
    expect(payload.output).toContain("mode: execute");
    expect(payload.output).toContain("model: claude-sonnet-4-6");
    expect(payload.output).toContain("agent: antigravity-agent");
    expect(payload.output).toContain("permissionMode: request-review");
    expect(payload.output).toContain("status: SUCCESS");
    expect(payload.output).toContain(`conversationId: ${CONVERSATION_ID}`);
    expect(payload.output).toContain("durationSeconds: unknown");
    expect(payload.output).toContain("totalTokens: 15");
    expect(payload.output).toContain("exit: exit code 0");
  });

  test("plan mode and a missing model/agent report unknown/default without crashing", async () => {
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: successStream("ok.") }));
    const { ctx } = progressContext();
    const payload = await runAntigravityTask({ task: "t", mode: "plan" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(true);
    expect(payload.output).toContain(DETAIL_HEADER);
    expect(payload.output).toContain("mode: plan");
    expect(payload.output).toContain("model: unknown/default");
    expect(payload.output).toContain("agent: unknown");
  });

  test("credential-shaped model in init is redacted before it reaches output or metadata", async () => {
    const secretModel = "sk-ant-1234567890abcdef1234567890abcdef";
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: `${initLineWith({ model: secretModel })}\n${resultLine("SUCCESS", "ok.")}\n` }));
    const { ctx } = progressContext();
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.output).toContain("model: [REDACTED]");
    expect(payload.output).not.toContain(secretModel);
    if (payload.metadata.ok) {
      expect(payload.metadata.model).toBe("[REDACTED]");
    }
  });

  test("a long prompt task is collapsed to a single line and bounded to 200 chars in the detail", async () => {
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: successStream("ok.") }));
    const { ctx } = progressContext();
    const longTask = `line one ${"x".repeat(500)}\nline two`;
    const payload = await runAntigravityTask({ task: longTask }, ctx, fake.deps);

    const taskLine = payload.output.split("\n").find((line) => line.startsWith("task: "));
    expect(taskLine, "a task field must be present").toBeDefined();
    expect(taskLine?.length).toBeLessThanOrEqual(200 + "task: ".length);
    expect(payload.output).not.toContain("line two");
  });

  test("detail section never leaks cwd, env, NDJSON, tool parameters or the full prompt body", async () => {
    const secret = "s3cr3t-detail-value";
    const secretCwd = `/private/secret/${secret}`;
    const secretEnv = { PATH: "/usr/bin", AGY_PATH: `/secret/${secret}/agy` };
    const fake = makeFakeDeps();
    const stream = [
      JSON.stringify({
        event: "init",
        conversation_id: "conv-detail",
        init: { cwd: secretCwd, tools: ["run_command"], permission_mode: "request-review" },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-detail",
          step_index: 0,
          state: "DONE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { name: "run_command", parameters: { command: `echo ${secret}` }, output: secret },
        },
      }),
      resultLine("SUCCESS", `ok-${secret}`),
    ].join("\n");
    fake.setRunResult(processResult({ stdout: stream }));
    const deps = { ...fake.deps, env: secretEnv };
    const { ctx, updates } = progressContext(secretCwd);
    const payload = await runAntigravityTask({ task: `prompt-with-${"x".repeat(500)}` }, ctx, deps);

    expect(payload.output).toContain(DETAIL_HEADER);
    const detailSection = payload.output.slice(payload.output.indexOf(DETAIL_HEADER));
    expect(detailSection).not.toContain(secret);
    expect(detailSection).not.toContain(secretCwd);
    expect(detailSection).not.toContain("tool_info");
    expect(detailSection).not.toContain("step_update");
    expect(detailSection).not.toContain('"parameters"');
    expect(detailSection).not.toContain("run_command");
    const taskLine = detailSection.split("\n").find((line) => line.startsWith("task: "));
    expect(taskLine, "a bounded task excerpt must be present").toBeDefined();
    expect(taskLine?.length).toBeLessThanOrEqual(200 + "task: ".length);

    const serialized = JSON.stringify(updates);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(secretCwd);
  });

  test("failure paths still emit a bounded detail block and a terminal progress update", async () => {
    const cases: readonly {
      readonly name: string;
      readonly kind: RunnerFailureKind;
      readonly stdout: string;
      readonly exitCode?: number;
      readonly runError?: ProcessError;
    }[] = [
      {
        name: "status",
        kind: "status",
        stdout: `${initLine()}\n${resultLine("ERROR", "", { error: "boom" })}\n`,
        exitCode: 1,
      },
      { name: "empty-output", kind: "empty-output", stdout: `${initLine()}\n${resultLine("SUCCESS", "")}\n` },
      {
        name: "invalid",
        kind: "invalid-result",
        stdout: `${initLine()}\n${JSON.stringify({ event: "result", result: { conversation_id: CONVERSATION_ID, status: "SUCCESS" } })}\n`,
      },
      {
        name: "duplicate",
        kind: "duplicate-result",
        stdout: `${initLine()}\n${resultLine("SUCCESS", "one")}\n${resultLine("SUCCESS", "two")}\n`,
      },
      {
        name: "timeout",
        kind: "timeout",
        stdout: "",
        runError: new ProcessError("timeout", "agy run (pid 9) exceeded the host timeout", {
          pid: 9,
          exit: { exitCode: null, signal: "SIGKILL" },
        }),
      },
      {
        name: "aborted",
        kind: "aborted",
        stdout: "",
        runError: new ProcessError("aborted", "agy run was aborted", {
          pid: 10,
          exit: { exitCode: null, signal: "SIGTERM" },
        }),
      },
    ];
    for (const entry of cases) {
      const fake = makeFakeDeps();
      if (entry.runError !== undefined) {
        fake.failRun(entry.runError);
      } else {
        fake.setRunResult(
          processResult({ stdout: entry.stdout, ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }) }),
        );
      }
      const { ctx, updates } = progressContext();
      const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

      expect(payload.metadata.ok, entry.name).toBe(false);
      if (!payload.metadata.ok) {
        expect(payload.metadata.kind, entry.name).toBe(entry.kind);
      }
      expect(payload.output, entry.name).toContain(DETAIL_HEADER);
      expect(payload.output, entry.name).toContain("status: ");
      expect(payload.output, entry.name).toContain("totalTokens: ");
      expect(payload.output, entry.name).toContain("exit: ");
      expect(updates[updates.length - 1]?.event, entry.name).toBe("terminal");
      expect(updates[updates.length - 1], entry.name).toMatchObject({ event: "terminal", kind: entry.kind });
    }
  });

  test("success emits exactly one terminal SUCCESS update and the output carries the detail block", async () => {
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: successStream("final answer.") }));
    const { ctx, updates } = progressContext();
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    const terminals = updates.filter((update) => update.event === "terminal");
    expect(terminals.length).toBe(1);
    expect(terminals[0]).toMatchObject({ event: "terminal", kind: "success" });
    expect(payload.output).toContain(DETAIL_HEADER);
    expect(payload.output).toContain("final answer.");
  });

  test("bounded stderr appears in the detail and is redacted before truncation", async () => {
    const secret = "sk-1234567890abcdefghijklmn";
    const fake = makeFakeDeps();
    fake.setRunResult(
      processResult({
        stdout: `${initLine()}\n${resultLine("SUCCESS", "ok")}\n`,
        stderr: `${secret} ${"z".repeat(MAX_DIAGNOSTIC_CHARS * 2)}`,
      }),
    );
    const { ctx } = progressContext();
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.output).toContain("stderr: ");
    expect(payload.output).not.toContain(secret);
    expect(payload.output).toContain("[REDACTED]");
    const detailSection = payload.output.slice(payload.output.indexOf(DETAIL_HEADER));
    const stderrLine = detailSection.split("\n").find((line) => line.startsWith("stderr: "));
    expect(stderrLine?.length).toBeLessThanOrEqual(200 + "stderr: ".length);
  });
});
