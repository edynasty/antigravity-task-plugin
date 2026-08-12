/**
 * Todo 5 runner: composes executable discovery (resolveAgy), deterministic
 * argv (buildArgv), subprocess lifecycle (runAgy) and the incremental protocol
 * parser (NdjsonStreamParser) into one bounded tool execution without
 * duplicating any of their responsibilities. Every failure class (validation,
 * discovery, process, protocol, post-exit) maps to a typed metadata variant;
 * stderr and diagnostic text are redacted and bounded; the returned ToolPayload
 * is exactly what the OpenCode tool returns.
 */
import { ArgsError, DEFAULT_MODE, DEFAULT_TIMEOUT_SECONDS, buildArgv } from "./args.js";
import { NdjsonStreamParser, ZERO_USAGE } from "./protocol.js";
import type { Diagnostic, ParserOutcome, Status, Usage } from "./protocol.js";
import { HOST_GRACE_MS, ProcessError, ResolveError } from "./process-types.js";
import type { ProcessExit, ResolveErrorKind } from "./process-types.js";
import { resolveAgy, runAgy } from "./process.js";
import type { DiscoveryOptions, ProcessResult } from "./process.js";
import { redactCredentials } from "./redaction.js";
import {
  boundDiagnosticText,
  riskNote,
  type AntigravityTaskArgs,
  type AntigravityTaskMetadata,
  type RunnerContext,
  type RunnerDeps,
  type RunnerFailureKind,
  type ToolPayload,
} from "./runner-types.js";

export const defaultDeps: RunnerDeps = {
  injected: undefined,
  env: process.env,
  platform: process.platform,
  resolveAgy,
  runAgy,
};

const EMPTY_DIAGNOSTICS: readonly Diagnostic[] = [];

function discoveryOptions(deps: RunnerDeps): DiscoveryOptions {
  return {
    env: deps.env,
    ...(deps.injected !== undefined ? { injected: deps.injected } : {}),
    ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
  };
}

function exitDetail(exit: ProcessExit): string {
  if (exit.signal !== null) {
    return `signal ${exit.signal}`;
  }
  if (exit.exitCode !== null) {
    return `exit code ${exit.exitCode}`;
  }
  return "unknown exit";
}

function assertNever(value: never): never {
  throw new Error(`unreachable runner path: ${String(value)}`);
}

function failureMetadata(
  kind: RunnerFailureKind,
  message: string,
  provenance: string,
  extra?: {
    readonly status?: Status | null;
    readonly conversationId?: string | null;
    readonly usage?: Usage;
    readonly exit?: ProcessExit | null;
    readonly diagnostics?: readonly Diagnostic[];
    readonly droppedDiagnostics?: number;
    readonly stderr?: string;
  },
): AntigravityTaskMetadata {
  return {
    ok: false,
    kind,
    message,
    status: extra?.status ?? null,
    conversationId: extra?.conversationId ?? null,
    usage: extra?.usage ?? ZERO_USAGE,
    exit: extra?.exit ?? null,
    provenance,
    diagnostics: extra?.diagnostics ?? EMPTY_DIAGNOSTICS,
    droppedDiagnostics: extra?.droppedDiagnostics ?? 0,
    stderr: extra?.stderr ?? "",
  };
}

function validationMetadata(error: ArgsError, provenance: string): AntigravityTaskMetadata {
  switch (error.kind) {
    case "empty-task":
      return failureMetadata("empty-task", "agy task must be a non-empty string", provenance);
    case "invalid-timeout":
      return failureMetadata("invalid-timeout", "agy timeoutSeconds must be a positive integer", provenance);
    case "conversation-conflict":
      return failureMetadata("conversation-conflict", "conversationId and continueConversation are mutually exclusive", provenance);
    default:
      return assertNever(error.kind);
  }
}

function resolveKind(kind: ResolveErrorKind): RunnerFailureKind {
  switch (kind) {
    case "empty-path":
      return "empty-path";
    case "not-found":
      return "resolve-not-found";
    case "not-executable":
      return "resolve-not-executable";
    default:
      return assertNever(kind);
  }
}

function resolveMessage(kind: ResolveErrorKind): string {
  switch (kind) {
    case "empty-path":
      return "agy executable path is empty";
    case "not-found":
      return "agy executable was not found (checked AGY_PATH and PATH)";
    case "not-executable":
      return "agy executable exists but is not executable";
    default:
      return assertNever(kind);
  }
}

function processFailure(error: ProcessError, provenance: string, cwd: string): AntigravityTaskMetadata {
  return failureMetadata(error.kind, boundDiagnosticText(error.message, cwd), provenance, { exit: error.exit });
}

function parserFailureMetadata(
  parsed: ParserOutcome & { readonly kind: "failure" },
  exit: ProcessExit,
  provenance: string,
  stderr: string,
): AntigravityTaskMetadata {
  const base = {
    status: parsed.status,
    conversationId: parsed.conversationId,
    usage: parsed.usage,
    exit,
    provenance,
    diagnostics: parsed.diagnostics,
    droppedDiagnostics: parsed.droppedDiagnostics,
    stderr,
  };
  switch (parsed.reason.type) {
    case "status": {
      const detail = parsed.reason.error === null ? "" : `: ${redactCredentials(parsed.reason.error)}`;
      return failureMetadata("status", `agy finished with status ${parsed.reason.status}${detail}`, provenance, base);
    }
    case "duplicate-result":
      return failureMetadata("duplicate-result", `agy emitted more than one terminal result (first status ${parsed.reason.firstStatus})`, provenance, base);
    case "missing-result":
      return failureMetadata("missing-result", "agy stream ended without a terminal result", provenance, base);
    case "invalid-result":
      return failureMetadata("invalid-result", `agy terminal result is invalid (${parsed.reason.detail})`, provenance, base);
    case "empty-output":
      return failureMetadata("empty-output", "agy returned an empty response", provenance, base);
    default:
      return assertNever(parsed.reason);
  }
}

function metadataFromParser(parsed: ParserOutcome, exit: ProcessExit, provenance: string, rawStderr: string, cwd: string): AntigravityTaskMetadata {
  const stderr = boundDiagnosticText(rawStderr, cwd);
  if (parsed.kind === "failure") {
    return parserFailureMetadata(parsed, exit, provenance, stderr);
  }
  if (exit.exitCode !== 0 || exit.signal !== null) {
    return failureMetadata("nonzero-exit", `agy exited with ${exitDetail(exit)} despite reporting SUCCESS`, provenance, {
      status: "SUCCESS",
      conversationId: parsed.conversationId,
      usage: parsed.usage,
      exit,
      diagnostics: parsed.diagnostics,
      droppedDiagnostics: parsed.droppedDiagnostics,
      stderr,
    });
  }
  return {
    ok: true,
    kind: "success",
    status: "SUCCESS",
    text: parsed.text,
    conversationId: parsed.conversationId,
    usage: parsed.usage,
    exit,
    provenance,
    diagnostics: parsed.diagnostics,
    droppedDiagnostics: parsed.droppedDiagnostics,
    stderr,
  };
}

function payloadFromMetadata(metadata: AntigravityTaskMetadata): ToolPayload {
  return metadata.ok
    ? { title: "antigravity-task: SUCCESS", output: metadata.text, metadata }
    : { title: `antigravity-task: ${metadata.kind}`, output: metadata.message, metadata };
}

export async function runAntigravityTask(
  args: AntigravityTaskArgs,
  context: RunnerContext,
  deps: RunnerDeps = defaultDeps,
): Promise<ToolPayload> {
  const provenance = riskNote(args.mode ?? DEFAULT_MODE, args.sandbox);
  const timeoutSeconds = args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  let argv: readonly string[];
  try {
    argv = buildArgv(args);
  } catch (error) {
    if (error instanceof ArgsError) {
      return payloadFromMetadata(validationMetadata(error, provenance));
    }
    throw error;
  }

  let executable: string;
  try {
    executable = deps.resolveAgy(discoveryOptions(deps));
  } catch (error) {
    if (error instanceof ResolveError) {
      return payloadFromMetadata(failureMetadata(resolveKind(error.kind), resolveMessage(error.kind), provenance));
    }
    throw error;
  }

  let proc: ProcessResult;
  try {
    proc = await deps.runAgy({
      argv: [executable, ...argv],
      cwd: context.cwd,
      env: deps.env,
      signal: context.signal,
      hostTimeoutMs: timeoutSeconds * 1000 + HOST_GRACE_MS,
    });
  } catch (error) {
    if (error instanceof ProcessError) {
      return payloadFromMetadata(processFailure(error, provenance, context.cwd));
    }
    throw error;
  }

  const parser = new NdjsonStreamParser();
  for (const chunk of proc.stdoutChunks) {
    parser.push(chunk);
  }
  const parsed = parser.finish();
  const exit: ProcessExit = { exitCode: proc.exitCode, signal: proc.signal };
  return payloadFromMetadata(metadataFromParser(parsed, exit, provenance, proc.stderr, context.cwd));
}
