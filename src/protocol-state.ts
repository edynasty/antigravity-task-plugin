/**
 * Accumulating stream state for the agy NDJSON parser: text, diagnostics,
 * per-step usage, the terminal result and the final outcome. The parser in
 * protocol-parser.ts owns chunk/line mechanics and delegates every event to
 * this state object. All buffering honors the bounded parser options.
 */
import {
  MAX_DIAGNOSTIC_CONTEXT_CHARS,
  MAX_DIAGNOSTICS,
  MAX_OUTPUT_CHARS,
  MAX_PENDING_LINE_BYTES,
  isRecord,
  isUsage,
  parseResultPayload,
} from "./protocol-types.js";
import type {
  Diagnostic,
  Failure,
  ParserOutcome,
  ProtocolParserOptions,
  ResultPayload,
  Usage,
} from "./protocol-types.js";

export type Options = Required<Omit<ProtocolParserOptions, "onProgress">>;

export function normalizeOptions(options: ProtocolParserOptions): Options {
  const normalized: Options = {
    maxOutputChars: options.maxOutputChars ?? MAX_OUTPUT_CHARS,
    maxPendingLineBytes: options.maxPendingLineBytes ?? MAX_PENDING_LINE_BYTES,
    maxDiagnostics: options.maxDiagnostics ?? MAX_DIAGNOSTICS,
    maxDiagnosticContextChars: options.maxDiagnosticContextChars ?? MAX_DIAGNOSTIC_CONTEXT_CHARS,
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`protocol parser option "${name}" must be a positive integer, got ${value}`);
    }
  }
  return normalized;
}

export class ProtocolState {
  private readonly options: Options;
  private readonly textParts: string[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  private readonly stepUsage = new Map<number, Usage>();
  private failure: Failure | null = null;
  private terminalResult: ResultPayload | null = null;
  private conversationId: string | null = null;
  private textLength = 0;
  private textTruncated = false;
  private droppedDiagnostics = 0;

  constructor(options: Options) {
    this.options = options;
  }

  isFailed(): boolean {
    return this.failure !== null;
  }

  handleInit(event: Readonly<Record<string, unknown>>, lineNumber: number): void {
    const payload = event["init"];
    if (!isRecord(payload)) {
      this.addDiagnostic({ kind: "invalid-event-payload", lineNumber, event: "init" });
      return;
    }
    if (this.conversationId === null) {
      const topLevel = event["conversation_id"];
      if (typeof topLevel === "string") {
        this.conversationId = topLevel;
      } else {
        const embedded = payload["conversation_id"];
        if (typeof embedded === "string") {
          this.conversationId = embedded;
        }
      }
    }
  }

  handleStepUpdate(event: Readonly<Record<string, unknown>>, lineNumber: number): void {
    const payload = event["step_update"];
    if (!isRecord(payload)) {
      this.addDiagnostic({ kind: "invalid-event-payload", lineNumber, event: "step_update" });
      return;
    }
    const delta = payload["text_delta"];
    if (typeof delta === "string") {
      this.appendDelta(delta);
    }
    const stepIndex = payload["step_index"];
    const usage = payload["usage"];
    if (typeof stepIndex === "number" && isUsage(usage)) {
      // Per step_index the last usage-bearing event wins; each index is summed
      // exactly once at fallback time, so repeated ACTIVE/DONE events never
      // double-count a step.
      this.stepUsage.set(stepIndex, usage);
    }
  }

  handleResult(event: Readonly<Record<string, unknown>>): void {
    if (this.failure !== null) {
      return;
    }
    if (this.terminalResult !== null) {
      // Exactly one terminal result is allowed. Every second result event —
      // identical or conflicting — is rejected (documented safest contract).
      this.failure = { type: "duplicate-result", firstStatus: this.terminalResult.status };
      return;
    }
    const parsed = parseResultPayload(event["result"]);
    if (!parsed.ok) {
      this.failure = { type: "invalid-result", detail: parsed.reason };
      return;
    }
    this.terminalResult = parsed.value;
    if (this.conversationId === null) {
      this.conversationId = parsed.value.conversation_id;
    }
  }

  addDiagnostic(diagnostic: Diagnostic): void {
    if (this.diagnostics.length < this.options.maxDiagnostics) {
      this.diagnostics.push(diagnostic);
    } else {
      this.droppedDiagnostics += 1;
    }
  }

  buildOutcome(): ParserOutcome {
    const usage = this.computeUsage();
    const diagnostics = this.diagnostics;
    const droppedDiagnostics = this.droppedDiagnostics;
    if (this.failure !== null) {
      return {
        kind: "failure",
        reason: this.failure,
        status: this.terminalResult?.status ?? null,
        text: this.bestEffortText(),
        conversationId: this.conversationId ?? this.terminalResult?.conversation_id ?? null,
        usage,
        diagnostics,
        droppedDiagnostics,
      };
    }
    const result = this.terminalResult;
    if (result === null) {
      return {
        kind: "failure",
        reason: { type: "missing-result" },
        status: null,
        text: this.textParts.join(""),
        conversationId: this.conversationId,
        usage,
        diagnostics,
        droppedDiagnostics,
      };
    }
    if (result.status !== "SUCCESS") {
      return {
        kind: "failure",
        reason: { type: "status", status: result.status, error: result.error ?? null },
        status: result.status,
        text: this.bestEffortText(),
        conversationId: this.conversationId ?? result.conversation_id,
        usage,
        diagnostics,
        droppedDiagnostics,
      };
    }
    const text = result.response !== "" ? this.capResponse(result.response) : this.textParts.join("");
    if (text === "") {
      return {
        kind: "failure",
        reason: { type: "empty-output" },
        status: "SUCCESS",
        text: "",
        conversationId: this.conversationId ?? result.conversation_id,
        usage,
        diagnostics,
        droppedDiagnostics,
      };
    }
    return {
      kind: "success",
      status: "SUCCESS",
      text,
      conversationId: this.conversationId ?? result.conversation_id,
      usage,
      diagnostics,
      droppedDiagnostics,
    };
  }

  private appendDelta(delta: string): void {
    if (delta === "") {
      return;
    }
    const room = this.options.maxOutputChars - this.textLength;
    if (room <= 0) {
      return;
    }
    const part = delta.length > room ? delta.slice(0, room) : delta;
    this.textParts.push(part);
    this.textLength += part.length;
    if (part.length < delta.length && !this.textTruncated) {
      this.textTruncated = true;
      this.addDiagnostic({ kind: "output-truncated", limit: this.options.maxOutputChars });
    }
  }

  private capResponse(response: string): string {
    if (response.length <= this.options.maxOutputChars) {
      return response;
    }
    if (!this.textTruncated) {
      this.textTruncated = true;
      this.addDiagnostic({ kind: "output-truncated", limit: this.options.maxOutputChars });
    }
    return response.slice(0, this.options.maxOutputChars);
  }

  private sumStepUsage(): Usage {
    let input = 0;
    let output = 0;
    let thinking = 0;
    let cacheRead = 0;
    let total = 0;
    for (const usage of this.stepUsage.values()) {
      input += usage.input_tokens;
      output += usage.output_tokens;
      thinking += usage.thinking_tokens;
      cacheRead += usage.cache_read_tokens;
      total += usage.total_tokens;
    }
    return { input_tokens: input, output_tokens: output, thinking_tokens: thinking, cache_read_tokens: cacheRead, total_tokens: total };
  }

  private computeUsage(): Usage {
    const result = this.terminalResult;
    if (result !== null && result.usage !== undefined) {
      return result.usage;
    }
    return this.sumStepUsage();
  }

  private bestEffortText(): string {
    const result = this.terminalResult;
    if (result !== null && result.response !== "") {
      return this.capResponse(result.response);
    }
    return this.textParts.join("");
  }
}
