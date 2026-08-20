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
import { truncateUtf16 } from "../utf16.js";
import { HOST_EXECUTION_DIRECTIVE, HOST_MODE_DIRECTIVE, hostToolsDirective, promptFromMessages, remapHostPathToContainer, stripHostContext } from "./prompt.js";
import { parseWorkspaceMounts } from "./workspace.js";
import type { SerialQueue } from "./queue.js";
import { SessionStore } from "./session-store.js";
import { boundedDelta, chatChunk, chatDone, conversationIdSse } from "./sse.js";
import { translateToolCall } from "./tool-bridge.js";

const ID_PREFIX = "chatcmpl-";

/** Total agy spawn attempts per chat request for transient startup failures
 * (eligibility-check network EOF on the proxy tunnel, and authentication
 * timeouts that succeed on retry — token refresh races). */
const MAX_ELIGIBILITY_RETRIES = 3;
/** Extra attempts for a completely empty agy response (no text at all). */
const MAX_EMPTY_OUTPUT_RETRIES = 1;

export type { ChatRequest, ChatRequestParse } from "./chat-request.js";

export interface RequestMeta {
  status: number;
  model: string | null;
  errorMessage: string | null;
  promptBytes: number | null;
}

export interface ChatContext {
  readonly deps: GatewayDeps;
  readonly queue: SerialQueue;
  readonly sessions: SessionStore;
  readonly toolClis: Readonly<Record<string, string>>;
  readonly defaultTimeoutSeconds: number;
  readonly maxBodyBytes: number;
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
    bodyText = await readRequestBody(req, ctx.maxBodyBytes);
  } catch (error) {
    if (error instanceof GatewayHttpError) {
      ctx.meta.status = error.status;
      ctx.meta.errorMessage = error.message;
      sendJsonError(res, error);
      return;
    }
    throw error;
  }

  const parsed = parseChatRequest(bodyText, ctx.toolClis);
  if (!parsed.ok) {
    ctx.meta.status = parsed.error.status;
    ctx.meta.errorMessage = parsed.error.message;
    sendJsonError(res, parsed.error);
    return;
  }
  const chat = parsed.value;
  ctx.meta.model = chat.model;

  const headerConversation = req.headers["x-agy-conversation"];
  const clientConversationId =
    chat.conversationId ?? (typeof headerConversation === "string" && headerConversation !== "" ? headerConversation : null);

  // Incremental conversation reuse: the fingerprint covers the non-system
  // message sequence (system is regenerated every request; injected context
  // blocks are stripped before hashing). A prefix hit means this request is a
  // continuation of a known agy conversation — resume it and send only the
  // messages added since the last turn instead of the whole history.
  const storeHit = clientConversationId === null ? ctx.sessions.lookup(chat.messages) : null;
  const conversationId = clientConversationId ?? (storeHit === null ? null : storeHit.conversationId);
  const nonSystemCount = chat.messages.filter((message) => message.role !== "system").length;
  const tail = chat.messages
    .slice(-3)
    .map((m) => {
      const text = typeof m.content === "string" ? m.content : String(m.content ?? "");
      return `${m.role}[${stripHostContext(text).slice(0, 160)}]`;
    })
    .join(" | ");
  if (storeHit === null) {
    ctx.log(
      clientConversationId === null
        ? `session reuse: miss (full prompt, ${nonSystemCount} messages; tail: ${tail})`
        : `session reuse: skipped (explicit conversationId; tail: ${tail})`,
    );
  } else {
    ctx.log(
      `session reuse: hit conversation=${storeHit.conversationId} seen=${storeHit.seenCount} of ${nonSystemCount} messages; sending ${Math.max(0, nonSystemCount - storeHit.seenCount)} new (tail: ${tail})`,
    );
  }

  let prompt = chat.prompt;
  if (storeHit !== null) {
    const nonSystemIndexes: number[] = [];
    chat.messages.forEach((message, index) => {
      if (message.role !== "system") {
        nonSystemIndexes.push(index);
      }
    });
    const startIndex = nonSystemIndexes[storeHit.seenCount];
    if (startIndex !== undefined) {
      const hostTools = hostToolsDirective(chat.tools, ctx.toolClis);
      prompt =
        `${HOST_EXECUTION_DIRECTIVE}\n\n` +
        `${hostTools === "" ? "" : `${hostTools}\n\n`}` +
        promptFromMessages(chat.messages.slice(startIndex));
    }
  }
  const workspaceMounts = parseWorkspaceMounts(ctx.deps.env);
  if (workspaceMounts.length === 0) {
    prompt = prompt.replace(HOST_EXECUTION_DIRECTIVE, HOST_MODE_DIRECTIVE);
  }
  prompt = remapHostPathToContainer(prompt, workspaceMounts);
  ctx.meta.promptBytes = prompt.length;
  ctx.log(
    `prompt framing: head=${JSON.stringify(prompt.slice(0, 240))} tail=${JSON.stringify(prompt.slice(-240))}`,
  );

  const timeoutSeconds = chat.timeoutSeconds ?? ctx.defaultTimeoutSeconds;

  let argv: readonly string[];
  try {
    argv = buildArgv({
      task: prompt,
      viaStdin: true,
      mode: chat.mode,
      timeoutSeconds,
      model: chat.model,
      ...(conversationId === null ? {} : { conversationId }),
    });
  } catch (error) {
    if (error instanceof ArgsError) {
      const httpError = invalidRequest(error.message);
      ctx.meta.status = httpError.status;
      ctx.meta.errorMessage = httpError.message;
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
      ctx.meta.errorMessage = httpError.message;
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
  const streamSteps = ctx.deps.env["AGY_GATEWAY_STREAM_STEPS"] === "1" || ctx.deps.env["AGY_GATEWAY_STREAM_STEPS"] === "true";
  const streamingStarted = { value: false };
  let accumulated = "";
  let bridgedToolCallEmitted = false;

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
        let eligibilityAttempts = 0;
        let emptyAttempts = 0;
        for (let attempt = 1; ; attempt++) {
          let emitted = false;
          const parser = new NdjsonStreamParser({
          onProgress: (snapshot) => {
            if (snapshot.event !== "step_update" || signal.aborted || snapshot.textDelta === null) {
              return;
            }
            if (bridgedToolCallEmitted) {
              // agy executed a bridged tool inside the container; the host
              // mirrors that call and its result comes back in the next
              // request. Suppress agy's own text so the final answer is
              // produced from the host-executed result, not the container one.
              return;
            }
            const capped = boundedDelta(accumulated, snapshot.textDelta, capChars);
            accumulated = capped.accumulated;
            if (chat.stream && capped.emitted !== "") {
              emitted = true;
              res.write(chatChunk(id, created, model, { content: capped.emitted }, null));
            }
          },
          onToolInfo: (info) => {
            if (signal.aborted || !chat.stream || !streamSteps) {
              return;
            }
            const translated = translateToolCall(info.toolName, info.inputJson, workspaceMounts);
            if (translated === null) {
              return;
            }
            bridgedToolCallEmitted = true;
            emitted = true;
            const toolCallId = `${ID_PREFIX}${randomBytes(8).toString("hex")}`;
            res.write(
              chatChunk(id, created, model, {
                tool_calls: [
                  {
                    index: 0,
                    id: toolCallId,
                    type: "function",
                    function: { name: translated.name, arguments: translated.arguments },
                  },
                ],
              }, null),
            );
          },
        });
        let proc: ProcessResult;
        try {
          proc = await ctx.deps.runAgy({
            argv: [executable, ...argv],
            cwd: ctx.deps.cwd,
            env: ctx.deps.env,
            signal,
            stdin: prompt,
            hostTimeoutMs: timeoutSeconds * 1000 + HOST_GRACE_MS,
            onStdoutChunk: (chunk) => parser.push(chunk),
          });
        } catch (error) {
          throw error;
        }
        const outcome = parser.finish();
        if (outcome.kind === "failure") {
          const transientStartupFailure =
            outcome.reason.type === "status" &&
            outcome.reason.error !== null &&
            (outcome.reason.error.includes("Eligibility check failed") ||
              outcome.reason.error.includes("authentication failed or timed out"));
          const emptyOutput = outcome.reason.type === "empty-output";
          if (!emitted && !signal.aborted) {
            if (transientStartupFailure && eligibilityAttempts < MAX_ELIGIBILITY_RETRIES - 1) {
              eligibilityAttempts += 1;
              ctx.log(`agy startup check failed on attempt ${attempt} of ${MAX_ELIGIBILITY_RETRIES}; retrying`);
              continue;
            }
            if (emptyOutput && emptyAttempts < MAX_EMPTY_OUTPUT_RETRIES) {
              emptyAttempts += 1;
              ctx.log(
                `agy returned an empty response on attempt ${attempt} (promptBytes=${chat.prompt.length}); retrying once`,
              );
              continue;
            }
          }
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
        if (outcome.conversationId !== null) {
          ctx.sessions.record(chat.messages, outcome.conversationId);
        }
        const finalText = capChars === null ? outcome.text : truncateUtf16(outcome.text, capChars);
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
          return;
        }
        throw new GatewayHttpError(500, "upstream_error", "server_error", "agy eligibility check retries exhausted");
      },
    });
  } catch (error) {
    const httpError = mapRunError(error, ctx.deps.cwd);
    if (httpError === null) {
      return;
    }
    ctx.meta.status = httpError.status;
    ctx.meta.errorMessage = httpError.message;
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
