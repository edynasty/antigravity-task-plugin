/**
 * Bounded metadata assembly for the Todo 5 runner: every failure class
 * (validation, discovery, process, protocol, post-exit) maps to a typed
 * metadata variant, and the final `output` gains a bounded, sanitized
 * execution-detail block. All free-text values are redacted before bounding;
 * prompt bodies, raw NDJSON, tool parameters/output, cwd, env and credentials
 * never cross.
 */
import { ArgsError } from "./args.js";
import { ZERO_USAGE } from "./protocol.js";
import type { Diagnostic, ParserOutcome, Status, Usage } from "./protocol.js";
import type { ProcessExit, ResolveErrorKind } from "./process-types.js";
import { redactCredentials } from "./redaction.js";
import {
  boundDiagnosticText,
  sanitizeDiagnostics,
  type AntigravityTaskArgs,
  type AntigravityTaskMetadata,
  type RunnerFailureKind,
  type ToolPayload,
} from "./runner-types.js";

const EMPTY_DIAGNOSTICS: readonly Diagnostic[] = [];

function exitDetail(exit: ProcessExit): string {
  if (exit.signal !== null) {
    return `signal ${exit.signal}`;
  }
  if (exit.exitCode !== null) {
    return `exit code ${exit.exitCode}`;
  }
  return "unknown exit";
}

function sanitizedInfo(value: string | null): string | null {
  return value === null ? null : redactCredentials(value);
}

function assertNever(value: never): never {
  throw new Error(`unreachable runner path: ${String(value)}`);
}

export function failureMetadata(
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
    readonly model?: string | null;
    readonly agent?: string | null;
    readonly permissionMode?: string | null;
    readonly durationSeconds?: number | null;
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
    model: extra?.model ?? null,
    agent: extra?.agent ?? null,
    permissionMode: extra?.permissionMode ?? null,
    durationSeconds: extra?.durationSeconds ?? null,
  };
}

export function validationMetadata(error: ArgsError, provenance: string): AntigravityTaskMetadata {
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

export function resolveFailure(kind: ResolveErrorKind, provenance: string): AntigravityTaskMetadata {
  switch (kind) {
    case "empty-path":
      return failureMetadata("empty-path", "agy executable path is empty", provenance);
    case "not-found":
      return failureMetadata("resolve-not-found", "agy executable was not found (checked AGY_PATH and PATH)", provenance);
    case "not-executable":
      return failureMetadata("resolve-not-executable", "agy executable exists but is not executable", provenance);
    default:
      return assertNever(kind);
  }
}

export function processFailure(error: { readonly kind: RunnerFailureKind; readonly message: string; readonly exit: ProcessExit | null }, provenance: string, cwd: string): AntigravityTaskMetadata {
  return failureMetadata(error.kind, boundDiagnosticText(error.message, cwd), provenance, { exit: error.exit });
}

function parserFailureMetadata(
  parsed: ParserOutcome & { readonly kind: "failure" },
  exit: ProcessExit,
  provenance: string,
  stderr: string,
  cwd: string,
  diagnostics: readonly Diagnostic[],
): AntigravityTaskMetadata {
  const base = {
    status: parsed.status,
    conversationId: parsed.conversationId,
    usage: parsed.usage,
    exit,
    provenance,
    diagnostics,
    droppedDiagnostics: parsed.droppedDiagnostics,
    stderr,
    model: sanitizedInfo(parsed.model),
    agent: sanitizedInfo(parsed.agent),
    permissionMode: sanitizedInfo(parsed.permissionMode),
    durationSeconds: parsed.durationSeconds,
  };
  switch (parsed.reason.type) {
    case "status": {
      const detail = parsed.reason.error === null ? "" : `: ${boundDiagnosticText(parsed.reason.error, cwd)}`;
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

export function metadataFromParser(parsed: ParserOutcome, exit: ProcessExit, provenance: string, rawStderr: string, cwd: string): AntigravityTaskMetadata {
  const stderr = boundDiagnosticText(rawStderr, cwd);
  const diagnostics = sanitizeDiagnostics(parsed.diagnostics, cwd);
  if (parsed.kind === "failure") {
    return parserFailureMetadata(parsed, exit, provenance, stderr, cwd, diagnostics);
  }
  if (exit.exitCode !== 0 || exit.signal !== null) {
    return failureMetadata("nonzero-exit", `agy exited with ${exitDetail(exit)} despite reporting SUCCESS`, provenance, {
      status: "SUCCESS",
      conversationId: parsed.conversationId,
      usage: parsed.usage,
      exit,
      diagnostics,
      droppedDiagnostics: parsed.droppedDiagnostics,
      stderr,
      model: sanitizedInfo(parsed.model),
      agent: sanitizedInfo(parsed.agent),
      permissionMode: sanitizedInfo(parsed.permissionMode),
      durationSeconds: parsed.durationSeconds,
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
    diagnostics,
    droppedDiagnostics: parsed.droppedDiagnostics,
    stderr,
    model: sanitizedInfo(parsed.model),
    agent: sanitizedInfo(parsed.agent),
    permissionMode: sanitizedInfo(parsed.permissionMode),
    durationSeconds: parsed.durationSeconds,
  };
}

export function payloadFromMetadata(
  args: Pick<AntigravityTaskArgs, "task" | "mode">,
  metadata: AntigravityTaskMetadata,
): ToolPayload {
  const body = metadata.ok ? metadata.text : metadata.message;
  const detail = executionDetail(args, metadata);
  return metadata.ok
    ? { title: "antigravity-task: SUCCESS", output: `${body}\n\n${detail}`, metadata }
    : { title: `antigravity-task: ${metadata.kind}`, output: `${body}\n\n${detail}`, metadata };
}

export const MAX_DETAIL_FIELD_CHARS = 200;
export const DETAIL_HEADER = "antigravity-task execution details";

function detailString(value: string | null, fallback: string): string {
  if (value === null || value === "") {
    return fallback;
  }
  const redacted = redactCredentials(value);
  return redacted.length > MAX_DETAIL_FIELD_CHARS ? redacted.slice(0, MAX_DETAIL_FIELD_CHARS) : redacted;
}

function detailExit(exit: ProcessExit | null): string {
  if (exit === null) {
    return "unknown";
  }
  if (exit.signal !== null) {
    return `signal ${exit.signal}`;
  }
  if (exit.exitCode !== null) {
    return `exit code ${exit.exitCode}`;
  }
  return "unknown exit";
}

function detailStderr(stderr: string): string {
  const redacted = redactCredentials(stderr);
  const singleLine = redacted.replace(/\s+/g, " ").trim();
  return singleLine.length > MAX_DETAIL_FIELD_CHARS ? singleLine.slice(0, MAX_DETAIL_FIELD_CHARS) : singleLine;
}

function detailModel(model: string | null): string {
  return detailString(model, "unknown/default");
}

function detailNumber(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

export function excerptTask(task: string): string {
  const collapsed = task.replace(/\s+/g, " ").trim();
  const redacted = redactCredentials(collapsed);
  return redacted.length > MAX_DETAIL_FIELD_CHARS ? redacted.slice(0, MAX_DETAIL_FIELD_CHARS) : redacted;
}

export function executionDetail(
  args: Pick<AntigravityTaskArgs, "task" | "mode">,
  metadata: AntigravityTaskMetadata,
): string {
  const lines = [
    DETAIL_HEADER,
    `task: ${excerptTask(args.task)}`,
    `mode: ${args.mode ?? "execute"}`,
    `model: ${detailModel(metadata.model)}`,
    `agent: ${detailString(metadata.agent, "unknown")}`,
    `permissionMode: ${detailString(metadata.permissionMode, "unknown")}`,
    `status: ${metadata.status ?? "unknown"}`,
    `conversationId: ${detailString(metadata.conversationId, "unknown")}`,
    `durationSeconds: ${detailNumber(metadata.durationSeconds)}`,
    `totalTokens: ${metadata.usage.total_tokens}`,
    `exit: ${detailExit(metadata.exit)}`,
  ];
  if (metadata.stderr !== "") {
    lines.push(`stderr: ${detailStderr(metadata.stderr)}`);
  }
  return lines.join("\n");
}
