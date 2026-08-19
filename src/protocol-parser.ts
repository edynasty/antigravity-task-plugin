/**
 * Incremental NDJSON parser for the official `agy` stream-json contract.
 *
 * Accepts arbitrary string/Uint8Array chunks (including UTF-8 code points
 * split across byte chunks and surrogate pairs split across string chunks),
 * CRLF or LF line endings, blank lines, an unterminated final line, unknown
 * events/fields, and non-JSON stdout lines. Completion is defined as exactly
 * one terminal `result` event; only SUCCESS is success. result.response wins
 * over concatenated text_delta; result.usage wins over summed per-step usage
 * (each step_index counted once, last usage wins). Output, diagnostics and
 * pending-line buffering are bounded by named constants, and diagnostic
 * context is redacted for credential-like values before it is stored.
 */
import { ByteAccumulator } from "./byte-accumulator.js";
import { ProtocolState, normalizeOptions } from "./protocol-state.js";
import { initProgress, nullableString, stepUpdateProgress } from "./progress.js";
import { isRecord } from "./protocol-types.js";
import type { ParserOutcome, ProgressSnapshot, ProtocolParserOptions, ToolStepInfo } from "./protocol-types.js";
import { redactCredentials } from "./redaction.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Tool step arguments bounded to a JSON string; "{}" when the step carries no parameters. */
const MAX_TOOL_INPUT_CHARS = 4_096;

function toolInputJsonOf(payload: Readonly<Record<string, unknown>>): string | null {
  const info = payload["tool_info"];
  if (!isRecord(info)) {
    return null;
  }
  const parameters = info["parameters"];
  let json: string;
  try {
    json = JSON.stringify(parameters === undefined ? {} : parameters);
  } catch {
    return null;
  }
  if (json === undefined) {
    return null;
  }
  return json.length <= MAX_TOOL_INPUT_CHARS ? json : `${json.slice(0, MAX_TOOL_INPUT_CHARS - 1)}\u2026`;
}

function isHighSurrogate(unit: string): boolean {
  const value = unit.charCodeAt(0);
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(unit: string): boolean {
  const value = unit.charCodeAt(0);
  return value >= 0xdc00 && value <= 0xdfff;
}

export class NdjsonStreamParser {
  private readonly state: ProtocolState;
  private readonly maxPendingLineBytes: number;
  private readonly maxDiagnosticContextChars: number;
  private readonly onProgress: ((snapshot: ProgressSnapshot) => void) | undefined;
  private readonly onToolInfo: ((info: ToolStepInfo) => void) | undefined;
  private readonly pending = new ByteAccumulator();
  private pendingHighSurrogate: string | null = null;
  private lineNumber = 0;
  private skippingLine = false;
  private skippedBytes = 0;
  private ended = false;

  constructor(options: ProtocolParserOptions = {}) {
    const normalized = normalizeOptions(options);
    this.state = new ProtocolState(normalized);
    this.maxPendingLineBytes = normalized.maxPendingLineBytes;
    this.maxDiagnosticContextChars = normalized.maxDiagnosticContextChars;
    this.onProgress = options.onProgress;
    this.onToolInfo = options.onToolInfo;
  }

  /** Feed the next chunk of stream output. Idempotently ignored after finish(). */
  push(chunk: string | Uint8Array): void {
    if (this.ended) {
      return;
    }
    if (typeof chunk === "string") {
      this.appendStringChunk(chunk);
    } else {
      this.flushStringSeam();
      this.pending.append(chunk);
    }
    this.processPending();
  }

  /** End of stream: flushes the unterminated tail line and returns the terminal outcome. */
  finish(): ParserOutcome {
    if (this.ended) {
      return this.buildOutcome();
    }
    this.ended = true;
    this.flushStringSeam();
    if (this.skippingLine) {
      this.skippedBytes += this.pending.size;
      this.state.addDiagnostic({ kind: "line-too-long", lineNumber: ++this.lineNumber, bytes: this.skippedBytes });
      this.skippingLine = false;
    } else if (this.pending.size > 0) {
      const tail = this.pending.takeAll();
      if (tail.length > 0) {
        this.processLine(tail);
      }
    }
    return this.buildOutcome();
  }

  /**
   * Encode a string chunk through a one-code-unit seam: a high surrogate at
   * the end of one chunk combines with a low surrogate at the start of the
   * next instead of being independently encoded into replacement characters.
   */
  private appendStringChunk(chunk: string): void {
    if (chunk === "") {
      return;
    }
    let text = chunk;
    if (this.pendingHighSurrogate !== null) {
      const first = text[0];
      if (first !== undefined && isLowSurrogate(first)) {
        this.pending.append(encoder.encode(this.pendingHighSurrogate + first));
        this.pendingHighSurrogate = null;
        text = text.slice(1);
      } else {
        this.flushStringSeam();
      }
    }
    const last = text[text.length - 1];
    if (last !== undefined && isHighSurrogate(last)) {
      this.pendingHighSurrogate = last;
      text = text.slice(0, -1);
    }
    if (text.length > 0) {
      this.pending.append(encoder.encode(text));
    }
  }

  /** Encode a lone pending high surrogate (no low half follows) and clear it. */
  private flushStringSeam(): void {
    if (this.pendingHighSurrogate !== null) {
      this.pending.append(encoder.encode(this.pendingHighSurrogate));
      this.pendingHighSurrogate = null;
    }
  }

  private processPending(): void {
    while (this.pending.size > 0) {
      if (this.skippingLine) {
        const newline = this.pending.indexOf(0x0a);
        if (newline === -1) {
          this.skippedBytes += this.pending.size;
          this.pending.reset();
          break;
        }
        this.skippedBytes += newline;
        this.state.addDiagnostic({ kind: "line-too-long", lineNumber: ++this.lineNumber, bytes: this.skippedBytes });
        this.skippingLine = false;
        this.skippedBytes = 0;
        this.pending.consumeThrough(newline);
        continue;
      }
      const line = this.pending.takeLine();
      if (line === null) {
        if (this.pending.size > this.maxPendingLineBytes) {
          this.skippingLine = true;
          this.skippedBytes = this.pending.size;
          this.pending.reset();
        }
        break;
      }
      if (line.length > this.maxPendingLineBytes) {
        // A complete line that still exceeds the cap is skipped, never parsed.
        this.state.addDiagnostic({ kind: "line-too-long", lineNumber: ++this.lineNumber, bytes: line.length });
        continue;
      }
      this.processLine(line);
    }
  }

  private buildOutcome(): ParserOutcome {
    return this.state.buildOutcome();
  }

  private processLine(lineBytes: Uint8Array): void {
    this.lineNumber += 1;
    if (this.state.isFailed()) {
      return;
    }
    const line = decoder.decode(lineBytes);
    if (line.trim() === "") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.state.addDiagnostic({
        kind: "malformed-line",
        lineNumber: this.lineNumber,
        context: this.snippet(line),
      });
      return;
    }
    if (!isRecord(parsed)) {
      this.state.addDiagnostic({
        kind: "malformed-line",
        lineNumber: this.lineNumber,
        context: this.snippet(line),
      });
      return;
    }
    const eventName = parsed["event"];
    if (typeof eventName !== "string") {
      this.state.addDiagnostic({
        kind: "malformed-line",
        lineNumber: this.lineNumber,
        context: this.snippet(line),
      });
      return;
    }
    switch (eventName) {
      case "init":
        this.state.handleInit(parsed, this.lineNumber);
        this.observe(initProgress(parsed));
        break;
      case "step_update":
        this.state.handleStepUpdate(parsed, this.lineNumber);
        this.observe(stepUpdateProgress(parsed));
        this.observeToolStep(parsed);
        break;
      case "result":
        // Result authority is deferred: no snapshot is observed here, so a
        // malformed or duplicate result can never transiently claim a status
        // before the parser's terminal outcome is known. The runner emits the
        // authoritative terminal update after finish().
        this.state.handleResult(parsed);
        break;
      default:
        // Unknown event types are forward-compatible: recorded, never fatal.
        this.state.addDiagnostic({ kind: "unknown-event", lineNumber: this.lineNumber, name: eventName });
        break;
    }
  }

  private observe(snapshot: ProgressSnapshot): void {
    if (this.onProgress !== undefined) {
      try {
        this.onProgress(snapshot);
      } catch {
        // Progress observers are best-effort: a throwing observer never
        // alters parsing or the terminal outcome.
      }
    }
  }

  private observeToolStep(payload: Readonly<Record<string, unknown>>): void {
    if (this.onToolInfo === undefined) {
      return;
    }
    const step = payload["step_update"];
    if (!isRecord(step)) {
      return;
    }
    if (nullableString(step["step_type"]) !== "tool") {
      return;
    }
    const toolName = nullableString(step["tool_name"]);
    if (toolName === null) {
      return;
    }
    const inputJson = toolInputJsonOf(step) ?? "{}";
    try {
      this.onToolInfo({ toolName, inputJson });
    } catch {
      // Tool observers are best-effort: a throwing observer never alters
      // parsing or the terminal outcome.
    }
  }

  /** Bounded, credential-redacted context snippet for a malformed line. */
  private snippet(line: string): string {
    return redactCredentials(line.trim()).slice(0, this.maxDiagnosticContextChars);
  }
}
