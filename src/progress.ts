/**
 * Bounded progress snapshot builders for the agy NDJSON protocol. These run
 * only after the parser's own line framing and JSON decode have completed, so
 * they read primitive fields exclusively and never parse free text. Only the
 * official init / step_update / result events are snapshotted.
 */
import { isRecord, isStatus, isUsage } from "./protocol-types.js";
import type { ProgressSnapshot } from "./protocol-types.js";

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function nullableSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function totalTokensOf(usage: unknown): number | null {
  return isUsage(usage) ? usage.total_tokens : null;
}

function conversationIdOf(event: Readonly<Record<string, unknown>>, payload: Readonly<Record<string, unknown>> | null): string | null {
  const topLevel = event["conversation_id"];
  if (typeof topLevel === "string") {
    return topLevel;
  }
  if (payload !== null) {
    const embedded = payload["conversation_id"];
    if (typeof embedded === "string") {
      return embedded;
    }
  }
  return null;
}

export function initProgress(event: Readonly<Record<string, unknown>>): ProgressSnapshot {
  const init = event["init"];
  return { event: "init", conversationId: conversationIdOf(event, isRecord(init) ? init : null) };
}

export function stepUpdateProgress(event: Readonly<Record<string, unknown>>): ProgressSnapshot {
  const payload = event["step_update"];
  if (!isRecord(payload)) {
    return {
      event: "step_update",
      conversationId: null,
      stepIndex: null,
      state: null,
      stepType: null,
      elapsedSeconds: null,
      totalTokens: null,
    };
  }
  return {
    event: "step_update",
    conversationId: conversationIdOf(event, payload),
    stepIndex: nullableInteger(payload["step_index"]),
    state: nullableString(payload["state"]),
    stepType: nullableString(payload["step_type"]),
    elapsedSeconds: nullableSeconds(payload["duration_seconds"]),
    totalTokens: totalTokensOf(payload["usage"]),
  };
}

export function resultProgress(event: Readonly<Record<string, unknown>>): ProgressSnapshot {
  const result = event["result"];
  if (!isRecord(result)) {
    return { event: "result", status: null, conversationId: null, totalTokens: null };
  }
  const status = result["status"];
  return {
    event: "result",
    status: isStatus(status) ? status : null,
    conversationId: nullableString(result["conversation_id"]),
    totalTokens: totalTokensOf(result["usage"]),
  };
}
