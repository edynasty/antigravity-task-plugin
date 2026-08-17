/**
 * Hands-on QA for information transparency: drives the built plugin tool with
 * a delayed fake agy stream (200ms per chunk) and proves the model and tool
 * name appear in progress metadata BEFORE resolve, and the bounded execution
 * detail block appears in the final output. Captures wall-clock timestamps.
 */
import { createAntigravityTaskTool } from "../src/index";
import type { ProcessResult } from "../src/process";
import type { RunnerDeps, ToolPayload } from "../src/runner-types";
import { mockToolContext } from "./helpers/runner-harness";
import { line } from "./fixtures/protocol/streams";

const CONVERSATION_ID = "qa-conversation-00000000-0000-4000-8000-000000000000";

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const initLineWithModel = (model: string): string =>
  line({
    event: "init",
    conversation_id: CONVERSATION_ID,
    init: { cwd: "/qa", tools: ["run_command", "write_to_file"], permission_mode: "request-review", model, agent: "qa-agent" },
  });

const toolStepLine = (): string =>
  line({
    event: "step_update",
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_index: 0,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
    },
  });

const resultLine = (): string =>
  line({
    event: "result",
    result: {
      conversation_id: CONVERSATION_ID,
      status: "SUCCESS",
      response: "qa final answer.",
      duration_seconds: 0.6,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 0, total_tokens: 15 },
    },
  });

type Recorded = { readonly title: string; readonly metadata: Record<string, unknown>; readonly at: number };

function delayedDeps(chunks: readonly string[], delayMs: number): RunnerDeps {
  const fake = {
    injected: undefined,
    env: { PATH: "/usr/bin" },
    platform: "darwin" as const,
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
  return fake;
}

async function main(): Promise<number> {
  const t0 = Date.now();
  const updates: Recorded[] = [];
  const context = mockToolContext("/qa");
  context.metadata = (input: { title?: string; metadata?: Record<string, unknown> }) => {
    updates.push({ title: input.title ?? "", metadata: input.metadata ?? {}, at: Date.now() });
  };
  const chunks = [`${initLineWithModel("claude-sonnet-4-6")}\n`, `${toolStepLine()}\n`, `${resultLine()}\n`];
  const result = await createAntigravityTaskTool(delayedDeps(chunks, 200)).execute(
    { task: "qa transparency probe", mode: "execute" },
    context,
  );
  const typed = result as ToolPayload;

  const initUpdate = updates.find((update) => update.metadata["model"] === "claude-sonnet-4-6");
  const toolUpdate = updates.find((update) => update.title.includes("running tool run_command"));
  const successAt = updates.find((update) => update.title === "antigravity-task: SUCCESS")?.at;

  const output = typeof typed.output === "string" ? typed.output : JSON.stringify(typed.output);
  const t1 = Date.now();

  const lines: string[] = [];
  lines.push(`started_at: ${new Date(t0).toISOString()}`);
  lines.push(`resolved_at: ${new Date(t1).toISOString()}`);
  lines.push(`elapsed_ms: ${t1 - t0}`);
  lines.push(`progress_updates: ${updates.length}`);
  for (const update of updates) {
    lines.push(`  [t+${update.at - t0}ms] ${update.title}`);
  }
  lines.push(`model_seen_in_progress_before_resolve: ${initUpdate !== undefined && (initUpdate?.at ?? 0) < t1}`);
  lines.push(`tool_name_seen_in_progress_before_resolve: ${toolUpdate !== undefined && (toolUpdate?.at ?? 0) < t1}`);
  lines.push(`success_terminal_at: ${successAt === undefined ? "n/a" : `${successAt - t0}ms`}`);
  lines.push(`has_detail_header: ${output.includes("antigravity-task execution details")}`);
  lines.push(`has_model_in_detail: ${output.includes("model: claude-sonnet-4-6")}`);
  lines.push(`has_tool_name_in_metadata: ${toolUpdate?.metadata["toolName"] === "run_command"}`);
  lines.push(`has_permission_mode_in_detail: ${output.includes("permissionMode: request-review")}`);
  lines.push(`has_status_success: ${output.includes("status: SUCCESS")}`);
  lines.push(`has_conversation_id: ${output.includes(CONVERSATION_ID)}`);
  lines.push(`has_duration: ${output.includes("durationSeconds: 0.6")}`);
  lines.push(`has_tokens: ${output.includes("totalTokens: 15")}`);
  lines.push(`has_exit: ${output.includes("exit: exit code 0")}`);
  lines.push(`no_cwd_leak: ${!output.includes("/qa\n") && !output.includes('"cwd"')}`);
  lines.push(`---final_output---`);
  lines.push(output);

  const evidence = lines.join("\n");
  console.log(evidence);

  const ok =
    initUpdate !== undefined &&
    (initUpdate.at ?? 0) < t1 &&
    toolUpdate !== undefined &&
    (toolUpdate?.at ?? 0) < t1 &&
    output.includes("antigravity-task execution details") &&
    output.includes("model: claude-sonnet-4-6") &&
    output.includes("status: SUCCESS");
  console.log(`\nQA_VERDICT: ${ok ? "PASS" : "FAIL"}`);
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("qa harness crashed:", error);
    process.exit(2);
  });
