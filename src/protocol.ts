/**
 * Public protocol facade (Todo 3). Exports the incremental NDJSON stream
 * parser with authoritative result semantics plus the full type surface.
 * Todo 5 imports `NdjsonStreamParser` and the outcome types from here.
 */
export { NdjsonStreamParser } from "./protocol-parser.js";
export {
  MAX_DIAGNOSTIC_CONTEXT_CHARS,
  MAX_DIAGNOSTICS,
  MAX_OUTPUT_CHARS,
  MAX_PENDING_LINE_BYTES,
  STATUS_VALUES,
  ZERO_USAGE,
  isRecord,
  isStatus,
  isUsage,
  parseResultPayload,
} from "./protocol-types.js";
export type {
  Diagnostic,
  Failure,
  InitPayload,
  InvalidResultReason,
  ParserOutcome,
  ProtocolParserOptions,
  ResultParse,
  ResultPayload,
  Status,
  StepUpdatePayload,
  Usage,
} from "./protocol-types.js";
