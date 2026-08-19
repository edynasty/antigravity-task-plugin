/**
 * Protocol type surface for the official Antigravity `agy` stream-json
 * contract (antigravity.google/docs/cli/headless): NDJSON lines of
 * init -> step_update* -> exactly one result. Statuses are the uppercase
 * literal set; only SUCCESS is a successful run.
 *
 * This module is pure types + type guards + bounded constants. No parser
 * logic lives here; the incremental parser is in protocol-parser.ts.
 */

export const STATUS_VALUES = [
  "SUCCESS",
  "ERROR",
  "CANCELED",
  "INTERRUPTED",
  "INVALID",
  "WAITING",
  "RUNNING",
] as const;

export type Status = (typeof STATUS_VALUES)[number];

const STATUS_SET: ReadonlySet<string> = new Set<string>(STATUS_VALUES);

/** Per-step / per-result token accounting with official field names. */
export type Usage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly thinking_tokens: number;
  readonly cache_read_tokens: number;
  readonly total_tokens: number;
};

/** Documented empty usage when no usage is observable at all. */
export const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  cache_read_tokens: 0,
  total_tokens: 0,
};

/** init event payload (informational; only conversation_id/model/agent/permission_mode are consumed). */
export type InitPayload = {
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly permission_mode: string;
  readonly model?: string;
  readonly agent?: string;
};

/** step_update payload; only text_delta / step_index / usage / tool_name are consumed. */
export type StepUpdatePayload = {
  readonly conversation_id?: string;
  readonly step_index?: number;
  readonly state?: string;
  readonly step_type?: string;
  readonly text_delta?: string;
  readonly tool_name?: string;
  readonly usage?: Usage;
};

/**
 * Terminal result envelope. status / response / conversation_id / usage are
 * the authority fields; every other field is informational and optional.
 */
export type ResultPayload = {
  readonly conversation_id: string;
  readonly status: Status;
  readonly response: string;
  readonly error?: string;
  readonly duration_seconds?: number;
  readonly num_turns?: number;
  readonly usage?: Usage;
};

/** Bounded non-fatal record of an anomalous stream line. */
export type Diagnostic =
  | { readonly kind: "malformed-line"; readonly lineNumber: number; readonly context: string }
  | { readonly kind: "unknown-event"; readonly lineNumber: number; readonly name: string }
  | { readonly kind: "invalid-event-payload"; readonly lineNumber: number; readonly event: "init" | "step_update" }
  | { readonly kind: "line-too-long"; readonly lineNumber: number; readonly bytes: number }
  | { readonly kind: "output-truncated"; readonly limit: number };

/** Fatal terminal failure of the whole stream. */
export type Failure =
  | { readonly type: "status"; readonly status: Exclude<Status, "SUCCESS">; readonly error: string | null }
  | { readonly type: "duplicate-result"; readonly firstStatus: Status }
  | { readonly type: "missing-result" }
  | { readonly type: "invalid-result"; readonly detail: InvalidResultReason }
  | { readonly type: "empty-output" };

/** Stable machine code naming the first violated authority field of a result envelope. */
export type InvalidResultReason =
  | "payload-not-record"
  | "status"
  | "response"
  | "conversation-id"
  | "error"
  | "usage";

/** Exactly one terminal parser outcome: success xor failure. */
export type ParserOutcome =  | {
      readonly kind: "success";
      readonly status: "SUCCESS";
      readonly text: string;
      readonly conversationId: string;
      readonly usage: Usage;
      readonly diagnostics: readonly Diagnostic[];
      readonly droppedDiagnostics: number;
      readonly model: string | null;
      readonly agent: string | null;
      readonly permissionMode: string | null;
      readonly durationSeconds: number | null;
    }
  | {
      readonly kind: "failure";
      readonly reason: Failure;
      readonly status: Status | null;
      readonly text: string;
      readonly conversationId: string | null;
      readonly usage: Usage;
      readonly diagnostics: readonly Diagnostic[];
      readonly droppedDiagnostics: number;
      readonly model: string | null;
      readonly agent: string | null;
      readonly permissionMode: string | null;
      readonly durationSeconds: number | null;
    };

/** Parsed result envelope: ok carries the typed value, else a stable reason. */
export type ResultParse =
  | { readonly ok: true; readonly value: ResultPayload }
  | { readonly ok: false; readonly reason: InvalidResultReason };

/**
 * Tool step detail for the gateway SSE bridge only (never part of the plugin
 * progress stream, which must not leak tool parameters). `inputJson` is the
 * bounded JSON of step_update.tool_info.parameters; "{}" when absent.
 */
export interface ToolStepInfo {
  readonly toolName: string;
  readonly inputJson: string;
}

/** Tunable bounded buffers; each defaults to a named MAX_* constant. */
export type ProtocolParserOptions = {
  readonly maxOutputChars?: number;
  readonly maxPendingLineBytes?: number;
  readonly maxDiagnostics?: number;
  readonly maxDiagnosticContextChars?: number;
  readonly onProgress?: (snapshot: ProgressSnapshot) => void;
  readonly onToolInfo?: (info: ToolStepInfo) => void;
};

/**
 * Bounded, sanitized progress snapshot for the official protocol events only.
 * Only primitive fields cross the boundary; raw lines, free text and payload
 * bodies never leak. Absent values are null (never omitted, never invented).
 * Result events are intentionally NOT snapshotted: terminal outcome authority
 * is deferred to the runner's terminal update.
 */
export type ProgressSnapshot =
  | {
      readonly event: "init";
      readonly conversationId: string | null;
      readonly model: string | null;
      readonly agent: string | null;
      readonly permissionMode: string | null;
    }
  | {
      readonly event: "step_update";
      readonly conversationId: string | null;
      readonly stepIndex: number | null;
      readonly state: string | null;
      readonly stepType: string | null;
      readonly toolName: string | null;
      readonly elapsedSeconds: number | null;
      readonly totalTokens: number | null;
      /** Streaming text fragment (step_update.text_delta); consumed by the gateway SSE bridge. */
      readonly textDelta: string | null;
    };

/** Final text accumulation cap (chars). */
export const MAX_OUTPUT_CHARS = 1_000_000;
/** Unterminated pending line cap (bytes); overflow is skipped until newline. */
export const MAX_PENDING_LINE_BYTES = 65_536;
/** Diagnostic record cap; overflow is counted, not stored. */
export const MAX_DIAGNOSTICS = 100;
/** Per-diagnostic context snippet cap (chars). */
export const MAX_DIAGNOSTIC_CONTEXT_CHARS = 200;

/** Boundary predicate: a plain object (never an array, never null). */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Boundary guard: a usage object with all five official numeric fields. */
export function isUsage(value: unknown): value is Usage {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value["input_tokens"]) &&
    isFiniteNumber(value["output_tokens"]) &&
    isFiniteNumber(value["thinking_tokens"]) &&
    isFiniteNumber(value["cache_read_tokens"]) &&
    isFiniteNumber(value["total_tokens"])
  );
}

/** Boundary guard: one of the seven official statuses. */
export function isStatus(value: unknown): value is Status {
  return typeof value === "string" && STATUS_SET.has(value);
}

/**
 * Boundary parser for a raw result envelope value. Every authority field is
 * validated exactly once; informational fields (duration_seconds/num_turns)
 * are kept only when numeric; unknown fields are ignored (forward-compatible).
 */
export function parseResultPayload(value: unknown): ResultParse {
  if (!isRecord(value)) {
    return { ok: false, reason: "payload-not-record" };
  }
  const status = value["status"];
  if (!isStatus(status)) {
    return { ok: false, reason: "status" };
  }
  const response = value["response"];
  if (typeof response !== "string") {
    return { ok: false, reason: "response" };
  }
  const conversationId = value["conversation_id"];
  if (typeof conversationId !== "string") {
    return { ok: false, reason: "conversation-id" };
  }
  const error = value["error"];
  if (error !== undefined && typeof error !== "string") {
    return { ok: false, reason: "error" };
  }
  const usage = value["usage"];
  if (usage !== undefined && !isUsage(usage)) {
    return { ok: false, reason: "usage" };
  }
  const durationSeconds = value["duration_seconds"];
  const numTurns = value["num_turns"];
  return {
    ok: true,
    value: {
      conversation_id: conversationId,
      status,
      response,
      ...(error === undefined ? {} : { error }),
      ...(typeof durationSeconds === "number" ? { duration_seconds: durationSeconds } : {}),
      ...(typeof numTurns === "number" ? { num_turns: numTurns } : {}),
      ...(usage === undefined ? {} : { usage }),
    },
  };
}
