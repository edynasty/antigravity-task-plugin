/**
 * OpenAI chat request parsing (gateway boundary): the raw JSON body is
 * validated exactly once — model, messages, stream, max_tokens, timeoutSeconds,
 * mode, conversationId — and unknown fields are ignored (forward-compatible).
 * `temperature` is deliberately ignored (documented); `max_tokens` maps to a
 * hard response cap of ~4 UTF-16 code units per token applied by the handler.
 */
import type { Mode } from "../args.js";
import { GatewayHttpError } from "./errors.js";
import { parsePrompt, type OpenAIMessage } from "./prompt.js";

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly OpenAIMessage[];
  readonly prompt: string;
  readonly stream: boolean;
  readonly maxTokens: number | null;
  readonly timeoutSeconds: number | null;
  readonly mode: Mode;
  readonly conversationId: string | null;
}

export type ChatRequestParse =
  | { readonly ok: true; readonly value: ChatRequest }
  | { readonly ok: false; readonly error: GatewayHttpError };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string): GatewayHttpError {
  return new GatewayHttpError(400, "invalid_request", "invalid_request_error", message);
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function parseChatRequest(bodyText: string): ChatRequestParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: invalidRequest("request body must be valid JSON") };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: invalidRequest("request body must be a JSON object") };
  }
  const model = parsed["model"];
  if (typeof model !== "string" || model.trim() === "") {
    return { ok: false, error: invalidRequest("model must be a non-empty string") };
  }
  const promptParse = parsePrompt(parsed);
  if (!promptParse.ok) {
    return { ok: false, error: invalidRequest(promptParse.reason) };
  }
  const stream = parsed["stream"];
  if (stream !== undefined && typeof stream !== "boolean") {
    return { ok: false, error: invalidRequest("stream must be a boolean") };
  }
  const maxTokens = parsed["max_tokens"];
  if (maxTokens !== undefined && !positiveInteger(maxTokens)) {
    return { ok: false, error: invalidRequest("max_tokens must be a positive integer") };
  }
  const timeoutSeconds = parsed["timeoutSeconds"];
  if (timeoutSeconds !== undefined && !positiveInteger(timeoutSeconds)) {
    return { ok: false, error: invalidRequest("timeoutSeconds must be a positive integer") };
  }
  const modeValue = parsed["mode"];
  if (modeValue !== undefined && modeValue !== "execute" && modeValue !== "plan") {
    return { ok: false, error: invalidRequest('mode must be "execute" or "plan"') };
  }
  const conversationId = parsed["conversationId"];
  if (conversationId !== undefined && (typeof conversationId !== "string" || conversationId === "")) {
    return { ok: false, error: invalidRequest("conversationId must be a non-empty string") };
  }
  return {
    ok: true,
    value: {
      model,
      messages: promptParse.messages,
      prompt: promptParse.prompt,
      stream: stream === undefined ? true : stream,
      maxTokens: maxTokens === undefined ? null : (maxTokens as number),
      timeoutSeconds: timeoutSeconds === undefined ? null : (timeoutSeconds as number),
      mode: modeValue === undefined ? "execute" : modeValue,
      conversationId: conversationId === undefined ? null : (conversationId as string),
    },
  };
}
