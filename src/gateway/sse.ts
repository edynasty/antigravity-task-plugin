/**
 * Server-Sent Events serialization for the OpenAI chat.completion.chunk wire
 * contract plus the bounded text cap applied to streamed deltas. Pure string
 * builders: JSON escaping is delegated to JSON.stringify; content never leaves
 * as raw free text.
 */

export function sseData(payload: Readonly<Record<string, unknown>>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function chatChunk(
  id: string,
  created: number,
  model: string,
  delta: Readonly<Record<string, unknown>>,
  finishReason: string | null,
): string {
  return sseData({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

export function chatDone(): string {
  return "data: [DONE]\n\n";
}

/**
 * Carries the agy conversation id as an SSE COMMENT line (`:` prefix), which
 * eventsource-parser implementations skip by default — strict OpenAI
 * chat.completion.chunk clients (e.g. the AI SDK) reject unknown `data:` JSON
 * shapes, so the id must never ride in a data line.
 */
export function conversationIdSse(conversationId: string): string {
  return `: conversation_id=${conversationId}\n\n`;
}

export interface DeltaCap {
  readonly accumulated: string;
  readonly emitted: string;
  readonly reached: boolean;
}

/**
 * Approximate response cap: max_tokens maps to `maxTokens * 4` UTF-16 code
 * units (1 token ~ 4 chars). Streaming deltas are truncated at the cap and
 * then suppressed; the accumulated text is the authority for the cap.
 */
export function boundedDelta(accumulated: string, delta: string, capChars: number | null): DeltaCap {
  if (capChars === null) {
    return { accumulated: `${accumulated}${delta}`, emitted: delta, reached: false };
  }
  const remaining = capChars - accumulated.length;
  if (remaining <= 0) {
    return { accumulated, emitted: "", reached: true };
  }
  if (delta.length <= remaining) {
    return { accumulated: `${accumulated}${delta}`, emitted: delta, reached: false };
  }
  const emitted = delta.slice(0, remaining);
  return { accumulated: `${accumulated}${emitted}`, emitted, reached: true };
}
