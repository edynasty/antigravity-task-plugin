/**
 * Hands-on QA for the final tool title: drives the BUILT plugin (dist/index.js)
 * through the real antigravity-task tool with a delayed fake agy that reports
 * model=claude-sonnet-4-6 in init plus a multi-line task, and proves the FINAL
 * tool title contains the actual model and the first-line task excerpt.
 */
import { createAntigravityTaskTool } from "../dist/index.js";
import type { ProcessResult } from "../dist/process.js";
import type { RunnerDeps, ToolPayload } from "../dist/runner-types.js";
import { mockToolContext } from "./helpers/runner-harness.js";
import { line } from "./fixtures/protocol/streams.js";

const CONVERSATION_ID = "qa-final-title-conversation-00000000-0000-4000-8000-000000000000";

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function initLineWithModel(model: string): string {
  return line({
    event: "init",
    conversation_id: CONVERSATION_ID,
    init: { cwd: "/qa", tools: ["run_command"], permission_mode: "request-review", model, agent: "qa-agent" },
  });
}

function stepLine(): string {
  return line({
    event: "step_update",
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_index: 0,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: "qa delta. ",
    },
  });
}

function resultLine(status: string): string {
  return line({
    event: "result",
    result: {
      conversation_id: CONVERSATION_ID,
      status,
      response: status === "SUCCESS" ? "qa final answer." : "",
      ...(status === "ERROR" ? { error: "qa simulated failure" } : {}),
      duration_seconds: 0.3,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 0, total_tokens: 15 },
    },
  });
}

function delayedDeps(chunks: readonly string[], delayMs: number): RunnerDeps {
  return {
    injected: undefined,
    env: { PATH: "/usr/bin" },
    platform: "darwin",
    resolveAgy: () => "/fake/agy",
    runAgy: async (options: { onStdoutChunk?: (chunk: string) => void }): Promise<ProcessResult> => {
      for (const chunk of chunks) {
        options.onStdoutChunk?.(chunk);
        await sleep(delayMs);
      }
      return {
        pid: 1,
        stdoutChunks: chunks,
        stdoutBytes: chunks.join("").length,
        stderr: "",
        stderrBytes: 0,
        exitCode: 0,
        signal: null,
      };
    },
  };
}

async function main(): Promise<number> {
  const t0 = Date.now();
  const context = mockToolContext("/qa");
  const updates: Array<{ title: string; at: number }> = [];
  context.metadata = (input: { title?: string; metadata?: Record<string, unknown> }) => {
    updates.push({ title: input.title ?? "", at: Date.now() });
  };

  const task = "Implement the payment module\nAdd test coverage for the refund path";
  const chunks = [`${initLineWithModel("claude-sonnet-4-6")}\n`, `${stepLine()}\n`, `${resultLine("SUCCESS")}\n`];
  const result = (await createAntigravityTaskTool(delayedDeps(chunks, 150)).execute(
    { task, mode: "execute" },
    context,
  )) as ToolPayload;
  const t1 = Date.now();

  const finalTitle = result.title;
  const lines: string[] = [];
  lines.push(`started_at: ${new Date(t0).toISOString()}`);
  lines.push(`resolved_at: ${new Date(t1).toISOString()}`);
  lines.push(`elapsed_ms: ${t1 - t0}`);
  lines.push(`final_title: ${finalTitle}`);
  lines.push(`has_model_in_final_title: ${finalTitle.includes("(claude-sonnet-4-6)")}`);
  lines.push(`has_first_line_excerpt: ${finalTitle.includes("Implement the payment module")}`);
  lines.push(`no_second_line_in_title: ${!finalTitle.includes("refund path")}`);
  lines.push(`title_bounded: ${finalTitle.length <= 140}`);
  for (const update of updates) {
    lines.push(`  [t+${update.at - t0}ms] ${update.title}`);
  }
  console.log(lines.join("\n"));

  const ok =
    finalTitle.includes("antigravity-task: SUCCESS (claude-sonnet-4-6) — Implement the payment module") &&
    !finalTitle.includes("refund path");
  console.log(`\nQA_VERDICT: ${ok ? "PASS" : "FAIL"}`);
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("qa harness crashed:", error);
    process.exit(2);
  });
