/**
 * Protocol fixture builders (Todo 3). Deterministic NDJSON event lines and
 * canonical streams matching the official agy stream-json contract:
 * init -> step_update* -> exactly one result. Statuses are the uppercase
 * literal set; step usage (total 7) deliberately differs from result usage
 * (total 15) so authority tests can prove result usage wins and steps are
 * never double-counted.
 */
export const CONVERSATION_ID = "fixture-conversation-00000000-0000-4000-8000-000000000000";

export const STEP_USAGE = {
  input_tokens: 5,
  output_tokens: 2,
  thinking_tokens: 1,
  cache_read_tokens: 0,
  total_tokens: 7,
} as const;

export const RESULT_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  thinking_tokens: 2,
  cache_read_tokens: 0,
  total_tokens: 15,
} as const;

export const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  cache_read_tokens: 0,
  total_tokens: 0,
} as const;

export type FixtureUsage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly thinking_tokens: number;
  readonly cache_read_tokens: number;
  readonly total_tokens: number;
};

export function line(value: unknown): string {
  return JSON.stringify(value);
}

export function initEvent(conversationId = CONVERSATION_ID): string {
  return line({
    event: "init",
    conversation_id: conversationId,
    init: { cwd: "/tmp/work", tools: ["run_command", "write_to_file"], permission_mode: "request-review" },
  });
}

export type StepEventInput = {
  readonly conversationId?: string;
  readonly stepIndex: number;
  readonly state: "ACTIVE" | "DONE";
  readonly stepType?: string;
  readonly textDelta?: string;
  readonly durationSeconds?: number;
  readonly usage?: FixtureUsage;
  readonly extra?: Readonly<Record<string, unknown>>;
};

export function stepEvent(input: StepEventInput): string {
  const payload: Record<string, unknown> = {
    conversation_id: input.conversationId ?? CONVERSATION_ID,
    step_index: input.stepIndex,
    state: input.state,
    step_type: input.stepType ?? "agent_response",
    ...(input.textDelta === undefined ? {} : { text_delta: input.textDelta }),
    ...(input.durationSeconds === undefined ? {} : { duration_seconds: input.durationSeconds }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.extra ?? {}),
  };
  return line({ event: "step_update", step_update: payload });
}

export type ResultEventInput = {
  readonly conversationId?: string;
  readonly status: string;
  readonly response?: string;
  readonly error?: string;
  readonly usage?: FixtureUsage;
  readonly extra?: Readonly<Record<string, unknown>>;
};

export function resultEvent(input: ResultEventInput): string {
  const payload: Record<string, unknown> = {
    conversation_id: input.conversationId ?? CONVERSATION_ID,
    status: input.status,
    response: input.response ?? "",
    duration_seconds: 0.02,
    num_turns: 1,
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.extra ?? {}),
  };
  return line({ event: "result", result: payload });
}

/** Official-docs example stream: init, two DONE steps, SUCCESS result. */
export function officialSuccessStream(): string {
  return [
    initEvent(),
    stepEvent({ stepIndex: 0, state: "DONE", stepType: "user_input" }),
    stepEvent({
      stepIndex: 3,
      state: "DONE",
      stepType: "agent_response",
      textDelta: "Git rebase destructively rewrites a branch's commit history.\n",
      usage: { input_tokens: 10302, output_tokens: 582, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 10884 },
    }),
    stepEvent({
      stepIndex: 4,
      state: "DONE",
      stepType: "checkpoint",
      durationSeconds: 0,
      usage: { input_tokens: 116, output_tokens: 7, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 123 },
    }),
    resultEvent({
      status: "SUCCESS",
      response: "Git rebase destructively rewrites a branch's commit history.\n",
      usage: { input_tokens: 10418, output_tokens: 589, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 11007 },
    }),
  ].join("\n");
}
