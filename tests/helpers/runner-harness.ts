/**
 * Shared deterministic fakes for Todo 5 runner/plugin tests.
 *
 * Pure in-memory harness: the fake RunnerDeps never spawns a process, never
 * touches the network, and never reads credentials. `processResult` builds
 * Todo-4-shaped ProcessResult values and the NDJSON builders emit official
 * stream-json lines whose result usage (15 total) intentionally differs from
 * the step usage (7 total) so tests can prove result usage is authoritative.
 */
import { ProcessError, ResolveError } from "../../src/process-types";
import type { ProcessResult, SpawnOptions } from "../../src/process";
import type { RunnerContext, RunnerDeps, ToolPayload } from "../../src/runner-types";
import type { ToolContext } from "@opencode-ai/plugin";

export const CONVERSATION_ID = "conv-runner-00000000-0000-4000-8000-000000000000";
export const RESULT_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  thinking_tokens: 2,
  cache_read_tokens: 0,
  total_tokens: 15,
} as const;
export const STEP_USAGE = {
  input_tokens: 5,
  output_tokens: 2,
  thinking_tokens: 1,
  cache_read_tokens: 0,
  total_tokens: 7,
} as const;

export function initLine(): string {
  return JSON.stringify({
    event: "init",
    conversation_id: CONVERSATION_ID,
    init: { cwd: "/w", tools: [], permission_mode: "request-review" },
  });
}

export function stepLine(): string {
  return JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_index: 0,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "delta text. ",
      usage: STEP_USAGE,
    },
  });
}

export function resultLine(status: string, response: string, extra?: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    event: "result",
    result: {
      conversation_id: CONVERSATION_ID,
      status,
      response,
      usage: RESULT_USAGE,
      ...extra,
    },
  });
}

export function successStream(text: string): string {
  return [initLine(), stepLine(), resultLine("SUCCESS", text)].join("\n") + "\n";
}

export interface ProcOverrides {
  readonly stdout?: string;
  readonly chunks?: readonly string[];
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals | null;
}

export function processResult(overrides: ProcOverrides = {}): ProcessResult {
  const chunks = overrides.chunks ?? [overrides.stdout ?? successStream("default success response.")];
  const stdout = chunks.join("");
  const stderr = overrides.stderr ?? "";
  const signal = overrides.signal ?? null;
  // Node's child_process contract: a non-null signal implies exitCode null.
  const exitCode = signal !== null ? null : (overrides.exitCode ?? 0);
  return {
    pid: 4242,
    stdoutChunks: chunks,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderr,
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
    exitCode,
    signal,
  };
}

export interface FakeRunnerDeps {
  readonly deps: RunnerDeps;
  readonly runCalls: readonly SpawnOptions[];
  readonly resolveCalls: number;
  setRunResult(result: ProcessResult): void;
  failRun(error: ProcessError): void;
  failResolve(error: ResolveError): void;
}

export function makeFakeDeps(): FakeRunnerDeps {
  const runCalls: SpawnOptions[] = [];
  let resolveCalls = 0;
  let resolveOutcome: string | ResolveError = "/fake/agy";
  let runOutcome: ProcessResult | ProcessError = processResult();
  const deps: RunnerDeps = {
    injected: undefined,
    env: { PATH: "/usr/bin", AGY_PATH: "/fake" },
    platform: "darwin",
    resolveAgy: () => {
      resolveCalls += 1;
      if (resolveOutcome instanceof ResolveError) {
        throw resolveOutcome;
      }
      return resolveOutcome;
    },
    runAgy: async (options) => {
      runCalls.push(options);
      if (runOutcome instanceof ProcessError) {
        throw runOutcome;
      }
      if (options.signal.aborted) {
        throw new ProcessError("aborted", "agy run was aborted before spawn");
      }
      return runOutcome;
    },
  };
  return {
    deps,
    get runCalls() {
      return runCalls;
    },
    get resolveCalls() {
      return resolveCalls;
    },
    setRunResult(result) {
      runOutcome = result;
    },
    failRun(error) {
      runOutcome = error;
    },
    failResolve(error) {
      resolveOutcome = error;
    },
  };
}

export function runContext(cwd = "/work"): { readonly ctx: RunnerContext; readonly signal: AbortSignal } {
  const controller = new AbortController();
  return { ctx: { cwd, signal: controller.signal }, signal: controller.signal };
}

export function mockToolContext(directory = "/work", abort = new AbortController().signal): ToolContext {
  return {
    sessionID: "runner-test-session",
    messageID: "runner-test-message",
    agent: "runner-test-agent",
    directory,
    worktree: directory,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

/** Runtime narrow from the framework's `ToolResult` union to our typed payload. */
export function isToolPayload(value: unknown): value is ToolPayload {
  return typeof value === "object" && value !== null && "title" in value && "output" in value && "metadata" in value;
}
