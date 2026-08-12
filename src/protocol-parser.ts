/**
 * Incremental NDJSON parser for the official `agy` stream-json contract.
 *
 * Accepts arbitrary string/Uint8Array chunks (including UTF-8 code points
 * split across byte chunks), CRLF or LF line endings, blank lines, an
 * unterminated final line, unknown events/fields, and non-JSON stdout lines.
 * Completion is defined as exactly one terminal `result` event; only SUCCESS
 * is success. result.response wins over concatenated text_delta; result.usage
 * wins over summed per-step usage (each step_index counted once, last usage
 * wins). All output and diagnostic buffering is bounded by named constants.
 */
import { ByteAccumulator } from "./byte-accumulator.js";
import { ProtocolState, normalizeOptions } from "./protocol-state.js";
import { isRecord } from "./protocol-types.js";
import type { ParserOutcome, ProtocolParserOptions } from "./protocol-types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class NdjsonStreamParser {
  private readonly state: ProtocolState;
  private readonly maxPendingLineBytes: number;
  private readonly maxDiagnosticContextChars: number;
  private readonly pending = new ByteAccumulator();
  private lineNumber = 0;
  private skippingLine = false;
  private skippedBytes = 0;
  private ended = false;

  constructor(options: ProtocolParserOptions = {}) {
    const normalized = normalizeOptions(options);
    this.state = new ProtocolState(normalized);
    this.maxPendingLineBytes = normalized.maxPendingLineBytes;
    this.maxDiagnosticContextChars = normalized.maxDiagnosticContextChars;
  }

  /** Feed the next chunk of stream output. Idempotently ignored after finish(). */
  push(chunk: string | Uint8Array): void {
    if (this.ended) {
      return;
    }
    this.pending.append(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
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
      this.processLine(line);
    }
  }

  /** End of stream: flushes the unterminated tail line and returns the terminal outcome. */
  finish(): ParserOutcome {
    if (this.ended) {
      return this.buildOutcome();
    }
    this.ended = true;
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
        break;
      case "step_update":
        this.state.handleStepUpdate(parsed, this.lineNumber);
        break;
      case "result":
        this.state.handleResult(parsed);
        break;
      default:
        // Unknown event types are forward-compatible: recorded, never fatal.
        this.state.addDiagnostic({ kind: "unknown-event", lineNumber: this.lineNumber, name: eventName });
        break;
    }
  }

  private snippet(line: string): string {
    return line.trim().slice(0, this.maxDiagnosticContextChars);
  }
}
