/**
 * Deterministic argv construction for the official agy headless CLI.
 *
 * Argument order is fixed: `-p`, task, `--output-format stream-json`,
 * `--print-timeout <n>s`, `--mode accept-edits|plan`, then optional
 * `--model`, exactly one conversation flag (`--conversation <id>` or
 * `--continue`), and `--sandbox`. Every value is a separate argv element;
 * no shell string is ever built, so metacharacters in user input cannot
 * interpolate or split.
 *
 * `timeoutSeconds` is an integer contract; the builder renders it as the Go
 * duration `${n}s` that `--print-timeout` requires. Ranges beyond "positive
 * integer" belong to the tool schema (Todo 5), not this layer.
 */

export type Mode = "execute" | "plan";

export const DEFAULT_MODE: Mode = "execute";
export const DEFAULT_TIMEOUT_SECONDS = 300;

export interface ArgvOptions {
  readonly task: string;
  readonly mode?: Mode;
  readonly timeoutSeconds?: number;
  readonly model?: string;
  readonly conversationId?: string;
  readonly continueConversation?: boolean;
  readonly sandbox?: boolean;
}

export type ArgsErrorKind = "empty-task" | "invalid-timeout" | "conversation-conflict";

export class ArgsError extends Error {
  readonly kind: ArgsErrorKind;
  constructor(kind: ArgsErrorKind, message: string) {
    super(message);
    this.name = "ArgsError";
    this.kind = kind;
  }
}

function modeFlag(mode: Mode): "accept-edits" | "plan" {
  switch (mode) {
    case "execute":
      return "accept-edits";
    case "plan":
      return "plan";
  }
}

export function buildArgv(options: ArgvOptions): readonly string[] {
  if (options.task.trim() === "") {
    throw new ArgsError("empty-task", "agy task must be a non-empty string");
  }
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
    throw new ArgsError("invalid-timeout", `agy timeoutSeconds must be a positive integer, got ${String(timeoutSeconds)}`);
  }
  if (options.conversationId !== undefined && options.continueConversation === true) {
    throw new ArgsError("conversation-conflict", "conversationId and continueConversation are mutually exclusive");
  }
  const mode = options.mode ?? DEFAULT_MODE;
  const argv: string[] = [
    "-p",
    options.task,
    "--output-format",
    "stream-json",
    "--print-timeout",
    `${timeoutSeconds}s`,
    "--mode",
    modeFlag(mode),
  ];
  if (options.model !== undefined) {
    argv.push("--model", options.model);
  }
  if (options.conversationId !== undefined) {
    argv.push("--conversation", options.conversationId);
  } else if (options.continueConversation === true) {
    argv.push("--continue");
  }
  if (options.sandbox === true) {
    argv.push("--sandbox");
  }
  return argv;
}
