/**
 * POST /v1/chat/completions handler (gateway Todo 13): validates the OpenAI
 * request at the HTTP boundary, converts messages to a role-labeled task
 * prompt, runs agy through the global serial queue, and emits either an SSE
 * stream (stream=true, default) or a full chat.completion object. The ONLY
 * execution path is the agy CLI subprocess via deps.runAgy; the gateway never
 * contacts any remote API. All free text in error paths is redacted before it
 * leaves the boundary.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ArgsError, buildArgv } from "../args.js";
import { NdjsonStreamParser } from "../protocol.js";
import { HOST_GRACE_MS, ResolveError } from "../process-types.js";
import type { ProcessResult } from "../process.js";
import { boundDiagnosticText } from "../runner-types.js";
import { mapRunError, outcomeFailureError, sseErrorData } from "./chat-errors.js";
import { parseChatRequest } from "./chat-request.js";
import type { GatewayDeps } from "./deps.js";
import { GatewayHttpError } from "./errors.js";
import { readRequestBody, sendJson, sendJsonError } from "./http-util.js";
import type { SerialQueue } from "./queue.js";
import { boundedDelta, chatChunk, chatDone, conversationIdSse } from "./sse.js";

const ID_PREFIX = "chatcmpl-";

export type { ChatRequest, ChatRequestParse } from "./chat-request.js";

export interface RequestMeta {
  status: number;
  model: string | null;
}

export interface ChatContext {
  readonly deps: GatewayDeps;
  readonly queue: SerialQueue;
  readonly defaultTimeoutSeconds: number;
  readonly log: (line: string) => void;
  readonly meta: RequestMeta;
}

function invalidRequest(message: string): GatewayHttpError {
  return new GatewayHttpError(400, "invalid_request", "invalid_request_error", message);
}

export async function handleChat(req: IncomingMessage, res: ServerResponse, ctx: ChatContext): Promise<void> {
  res.on("error", () => undefined);
  req.on("error", () => undefined);

  let bodyText: string;
  try {
    bodyText = await readRequestBody(req);
  } catch (error) {
    if (error instanceof GatewayHttpError) {
      ctx.meta.status = error.status;
      sendJsonError(res, error);
      return;
    }
    throw error;
  }

  const parsed = parseChatRequest(bodyText);
  if (!parsed.ok) {
    ctx.meta.status = parsed.error.status;
    sendJsonError(res, parsed.error);
    return;
  }
  const chat = parsed.value;
  ctx.meta.model = chat.model;

  const headerConversation = req.headers["x-agy-conversation"];
  const conversationId =
    chat.conversationId ?? (typeof headerConversation === "string" && headerConversation !== "" ? headerConversation : null);

  const timeoutSeconds = chat.timeoutSeconds ?? ctx.defaultTimeoutSeconds;

  let argv: readonly string[];
  try {
    argv = buildArgv({
      task: chat.prompt,
      mode: chat.mode,
      timeoutSeconds,
      model: chat.model,
      ...(conversationId === null ? {} : { conversationId }),
    });
  } catch (error) {
    if (error instanceof ArgsError) {
      const httpError = invalidRequest(error.message);
      ctx.meta.status = httpError.status;
      sendJsonError(res, httpError);
      return;
    }
    throw error;
  }

  let executable: string;
  try {
    executable = ctx.deps.resolveAgy({ env: ctx.deps.env, ...(ctx.deps.platform !== undefined ? { platform: ctx.deps.platform } : {}) });
  } catch (error) {
    if (error instanceof ResolveError) {
      const httpError = new GatewayHttpError(500, "upstream_error", "server_error", boundDiagnosticText(error.message, ctx.deps.cwd));
      ctx.meta.status = httpError.status;
      sendJsonError(res, httpError);
      return;
    }
    throw error;
  }

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  const id = `${ID_PREFIX}${randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  const model = chat.model;
  const capChars = chat.maxTokens === null ? null : chat.maxTokens * 4;
  const streamingStarted = { value: false };
  let accumulated = "";

  try {
    await ctx.queue.push({
      signal: controller.signal,
      run: async (signal) => {
        if (chat.stream) {
          streamingStarted.value = true;
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.flushHeaders();
        }
        const parser = new NdjsonStreamParser({
          onProgress: (snapshot) => {
            if (snapshot.event !== "step_update" || snapshot.textDelta === null || signal.aborted) {
              return;
            }
            const capped = boundedDelta(accumulated, snapshot.textDelta, capChars);
            accumulated = capped.accumulated;
            if (chat.stream && capped.emitted !== "") {
              res.write(chatChunk(id, created, model, { content: capped.emitted }, null));
            }
          },
        });
        let proc: ProcessResult;
        try {
          proc = await ctx.deps.runAgy({
            argv: [executable, ...argv],
            cwd: ctx.deps.cwd,
            env: ctx.deps.env,
            signal,
            hostTimeoutMs: timeoutSeconds * 1000 + HOST_GRACE_MS,
            onStdoutChunk: (chunk) => parser.push(chunk),
          });
        } catch (error) {
          throw error;
        }
        const outcome = parser.finish();
        if (outcome.kind === "failure") {
          throw outcomeFailureError(outcome, ctx.deps.cwd);
        }
        if (proc.exitCode !== 0 || proc.signal !== null) {
          throw new GatewayHttpError(
            500,
            "upstream_error",
            "server_error",
            `agy exited with code ${String(proc.exitCode)} despite reporting SUCCESS`,
          );
        }
        ctx.meta.status = 200;
        const finalText = capChars === null ? outcome.text : outcome.text.slice(0, capChars);
        if (chat.stream) {
          res.write(chatChunk(id, created, model, {}, "stop"));
          if (outcome.conversationId !== null) {
            res.write(conversationIdSse(outcome.conversationId));
          }
          res.write(chatDone());
          res.end();
          return;
        }
        sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: finalText }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: outcome.usage.input_tokens,
            completion_tokens: outcome.usage.output_tokens,
            total_tokens: outcome.usage.total_tokens,
          },
          ...(outcome.conversationId === null ? {} : { conversation_id: outcome.conversationId }),
        });
      },
    });
  } catch (error) {
    const httpError = mapRunError(error, ctx.deps.cwd);
    if (httpError === null) {
      return;
    }
    ctx.meta.status = httpError.status;
    if (streamingStarted.value) {
      if (!res.writableEnded) {
        res.write(sseErrorData(httpError));
        res.write(chatDone());
        res.end();
      }
      return;
    }
    sendJsonError(res, httpError);
  }
}
