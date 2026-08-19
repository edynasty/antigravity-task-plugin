/**
 * Error mapping for the chat handler: typed failures from the queue, the
 * process adapter, the parser and the HTTP boundary are all reduced to one
 * OpenAI-shaped GatewayHttpError, with free text redacted before it leaves.
 */
import type { ParserOutcome } from "../protocol.js";
import { ProcessError } from "../process-types.js";
import { boundDiagnosticText } from "../runner-types.js";
import { GatewayHttpError } from "./errors.js";
import { QueueAbortError, QueueFullError } from "./queue.js";
import { sseData } from "./sse.js";

function assertNever(value: never): never {
  throw new Error(`unreachable gateway path: ${String(value)}`);
}

function failureMessage(outcome: ParserOutcome & { readonly kind: "failure" }, cwd: string): string {
  switch (outcome.reason.type) {
    case "status": {
      const detail = outcome.reason.error === null ? "" : `: ${boundDiagnosticText(outcome.reason.error, cwd)}`;
      return `agy finished with status ${outcome.reason.status}${detail}`;
    }
    case "duplicate-result":
      return "agy emitted more than one terminal result";
    case "missing-result":
      return "agy stream ended without a terminal result";
    case "invalid-result":
      return `agy terminal result is invalid (${outcome.reason.detail})`;
    case "empty-output":
      return "agy returned an empty response (the model produced no text; try a shorter conversation or retry)";
    default:
      return assertNever(outcome.reason);
  }
}

export function outcomeFailureError(outcome: ParserOutcome & { readonly kind: "failure" }, cwd: string): GatewayHttpError {
  return new GatewayHttpError(500, "upstream_error", "server_error", failureMessage(outcome, cwd));
}

export function mapRunError(error: unknown, cwd: string): GatewayHttpError | null {
  if (error instanceof QueueAbortError || (error instanceof ProcessError && error.kind === "aborted")) {
    return null;
  }
  if (error instanceof QueueFullError) {
    return new GatewayHttpError(429, 429, "queue_full", "queue full");
  }
  if (error instanceof ProcessError) {
    if (error.kind === "timeout") {
      return new GatewayHttpError(504, "gateway_timeout", "server_error", boundDiagnosticText(error.message, cwd));
    }
    return new GatewayHttpError(500, "upstream_error", "server_error", boundDiagnosticText(error.message, cwd));
  }
  if (error instanceof GatewayHttpError) {
    return error;
  }
  return new GatewayHttpError(500, "upstream_error", "server_error", "unexpected gateway failure");
}

export function sseErrorData(error: GatewayHttpError): string {
  return sseData({ error: { message: error.message, type: error.type, code: error.code } });
}
