/**
 * Deterministic fake `agy` CLI used by contract fixtures (Todo 2).
 *
 * Emits official-shaped `--output-format stream-json` NDJSON events
 * (init -> step_update* -> result) without any network or credential access.
 * Select a scenario with the AGY_FAKE_SCENARIO environment variable; unknown
 * scenarios fail loudly on stderr with exit code 2. Run via `bun <this file>`
 * so no executable bit is required.
 *
 * Scenario contract (asserted by tests/scaffold.test.ts):
 *   success  -> [init, step_update, result(SUCCESS, usage)]             exit 0
 *   error    -> [init, result(ERROR, error)]                            exit 1
 *   empty    -> [init, result(SUCCESS, response "")]                    exit 0
 *   tail     -> [init, step_update, result(SUCCESS)] final line, no LF  exit 0
 *   hang     -> [init] then waits; SIGTERM -> 143, SIGINT -> 130
 *
 * The step usage sum (7 total) intentionally differs from the result usage
 * (15 total) so Todo 3 can prove result usage is authoritative and never
 * double-counted.
 */
import { writeSync } from "node:fs";
import process from "node:process";

export const SCENARIO_ENV = "AGY_FAKE_SCENARIO";
export const SCENARIO_VALUES = ["success", "error", "empty", "tail", "hang"] as const;
export type Scenario = (typeof SCENARIO_VALUES)[number];

const SCENARIO_SET: ReadonlySet<string> = new Set<string>(SCENARIO_VALUES);

const CONVERSATION_ID = "fake-agy-conversation-00000000-0000-4000-8000-000000000000";

type Usage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly thinking_tokens: number;
  readonly cache_read_tokens: number;
  readonly total_tokens: number;
};

const STEP_USAGE: Usage = { input_tokens: 5, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 7 };
const RESULT_USAGE: Usage = { input_tokens: 10, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 0, total_tokens: 15 };
const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };

function writeLine(payload: object): void {
  writeSync(1, `${JSON.stringify(payload)}\n`);
}

function emitInit(): void {
  writeLine({
    event: "init",
    conversation_id: CONVERSATION_ID,
    init: {
      cwd: process.cwd(),
      tools: ["run_command", "write_to_file"],
      permission_mode: "request-review",
      model: "claude-sonnet-4-6",
      agent: "fake-agy-agent",
    },
  });
}

function emitStepUpdate(): void {
  writeLine({
    event: "step_update",
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_index: 0,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "fake-agy step delta. ",
      duration_seconds: 0.01,
      usage: STEP_USAGE,
    },
  });
}

type ResultOptions = {
  readonly status: "SUCCESS" | "ERROR";
  readonly response: string;
  readonly error?: string;
  readonly usage: Usage;
};

function emitResult(options: ResultOptions): void {
  writeLine({
    event: "result",
    result: {
      conversation_id: CONVERSATION_ID,
      status: options.status,
      response: options.response,
      duration_seconds: 0.02,
      num_turns: 1,
      usage: options.usage,
      ...(options.error === undefined ? {} : { error: options.error }),
    },
  });
}

function runSuccess(): void {
  emitInit();
  emitStepUpdate();
  emitResult({
    status: "SUCCESS",
    response: "fake-agy success response: deterministic scaffold fixture.",
    usage: RESULT_USAGE,
  });
  process.exit(0);
}

function runError(): void {
  emitInit();
  emitResult({
    status: "ERROR",
    response: "",
    error: "fake-agy simulated failure: deterministic scaffold fixture",
    usage: ZERO_USAGE,
  });
  process.exit(1);
}

function runEmpty(): void {
  emitInit();
  emitResult({ status: "SUCCESS", response: "", usage: ZERO_USAGE });
  process.exit(0);
}

function runTail(): void {
  emitInit();
  emitStepUpdate();
  // Official contract ends with a result event; here it deliberately has no
  // trailing newline so the parser must accept a final line without one.
  writeSync(
    1,
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: CONVERSATION_ID,
        status: "SUCCESS",
        response: "fake-agy tail fixture response.",
        duration_seconds: 0.02,
        num_turns: 1,
        usage: RESULT_USAGE,
      },
    }),
  );
  process.exit(0);
}

function runHang(): void {
  // Register signal handlers BEFORE emitting init so a parent that reacts to
  // the init line can never SIGTERM a child whose handler is not yet wired.
  const keepAlive = setInterval(() => undefined, 60_000);
  process.on("SIGTERM", () => {
    clearInterval(keepAlive);
    process.exit(143);
  });
  process.on("SIGINT", () => {
    clearInterval(keepAlive);
    process.exit(130);
  });
  emitInit();
}

function isScenario(value: string): value is Scenario {
  return SCENARIO_SET.has(value);
}

function resolveScenario(): Scenario {
  const raw = process.env[SCENARIO_ENV];
  if (raw === undefined) {
    return "success";
  }
  if (isScenario(raw)) {
    return raw;
  }
  writeSync(
    2,
    `fake-agy: unknown scenario ${JSON.stringify(raw)}; expected one of ${SCENARIO_VALUES.join(", ")}\n`,
  );
  process.exit(2);
}

function main(): void {
  switch (resolveScenario()) {
    case "success":
      runSuccess();
      break;
    case "error":
      runError();
      break;
    case "empty":
      runEmpty();
      break;
    case "tail":
      runTail();
      break;
    case "hang":
      runHang();
      break;
  }
}

main();
