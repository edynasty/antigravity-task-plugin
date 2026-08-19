/**
 * Gateway HTTP integration (Todo 13): the real node:http server is started on
 * an ephemeral port and driven over loopback HTTP with the injected fake deps
 * (agy is never spawned). Asserts the OpenAI wire contract end to end.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessError, ResolveError } from "../../src/process-types";
import { BUILTIN_MODELS } from "../../src/gateway/models";
import { gatewayConfigFromEnv } from "../../src/gateway/server";
import { HOST_GRACE_MS } from "../../src/process-types";
import {
  GW_CONVERSATION_ID,
  GW_RESULT_USAGE,
  chatBody,
  gwInitLine,
  gwResultLine,
  gwStepLine,
  gwStream,
  jsonRequest,
  startGateway,
  type GatewayServerHandle,
} from "./gateway-harness";

const handles: GatewayServerHandle[] = [];
const tempDirs: string[] = [];

async function spawn(
  overrides: Partial<Parameters<typeof startGateway>[0]> = {},
  envOverrides: Readonly<Record<string, string>> = {},
): Promise<GatewayServerHandle> {
  const handle = await startGateway(overrides, envOverrides);
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agy-gateway-http-"));
  tempDirs.push(dir);
  return dir;
}

describe("gateway auth", () => {
  test("no token configured: requests pass without authorization", async () => {
    const { baseUrl } = await spawn();
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody(), undefined));
    expect(response.status).toBe(200);
  });

  test("token configured: missing or wrong bearer is 401 with an OpenAI error shape", async () => {
    const { baseUrl } = await spawn({ token: "secret-token" });
    const missing = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody(), undefined));
    expect(missing.status).toBe(401);
    const body = (await missing.json()) as { error: { message: string; type: string; code: string } };
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.code).toBe("invalid_api_key");

    const wrong = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody(), "wrong-token"));
    expect(wrong.status).toBe(401);
  });

  test("token configured: matching bearer passes", async () => {
    const { baseUrl } = await spawn({ token: "secret-token" });
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody(), "secret-token"));
    expect(response.status).toBe(200);
  });

  test("models listing is auth-gated identically", async () => {
    const { baseUrl } = await spawn({ token: "secret-token" });
    const denied = await fetch(baseUrl + "/v1/models");
    expect(denied.status).toBe(401);
    const allowed = await fetch(baseUrl + "/v1/models", { headers: { authorization: "Bearer secret-token" } });
    expect(allowed.status).toBe(200);
  });
});

describe("POST /v1/chat/completions non-stream", () => {
  test("returns the full OpenAI chat.completion object with usage and conversation id", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdout(gwStream(["delta one. ", "delta two. "], "final full response."));
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false })));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["object"]).toBe("chat.completion");
    expect(body["model"]).toBe("gemini-3.5-flash-medium");
    expect(body["conversation_id"]).toBe(GW_CONVERSATION_ID);
    const choices = body["choices"] as Array<Record<string, unknown>>;
    expect(choices.length).toBe(1);
    expect((choices[0]?.["message"] as Record<string, unknown>)["role"]).toBe("assistant");
    expect((choices[0]?.["message"] as Record<string, unknown>)["content"]).toBe("final full response.");
    expect(choices[0]?.["finish_reason"]).toBe("stop");
    expect(body["usage"]).toEqual({
      prompt_tokens: GW_RESULT_USAGE.input_tokens,
      completion_tokens: GW_RESULT_USAGE.output_tokens,
      total_tokens: GW_RESULT_USAGE.total_tokens,
    });
    expect(typeof body["id"]).toBe("string");
    expect(String(body["id"])).toMatch(/^chatcmpl-/);
  });

  test("model passthrough: request model is forwarded verbatim to --model and echoed back", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdout(gwStream(["d"], "ok"));
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false, model: "custom-model-xyz" })));
    expect(response.status).toBe(200);
    const argv = fake.runCalls[0]?.argv ?? [];
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("custom-model-xyz");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["model"]).toBe("custom-model-xyz");
  });

  test("mode plan maps to --mode plan; default execute maps to accept-edits", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdout(gwStream(["d"], "ok"));
    await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false, mode: "plan" })));
    const planArgv = fake.runCalls[0]?.argv ?? [];
    expect(planArgv).toContain("--mode");
    expect(planArgv[planArgv.indexOf("--mode") + 1]).toBe("plan");

    fake.setStdout(gwStream(["d"], "ok"));
    await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false })));
    const executeArgv = fake.runCalls[1]?.argv ?? [];
    expect(executeArgv).toContain("--mode");
    expect(executeArgv[executeArgv.indexOf("--mode") + 1]).toBe("accept-edits");
  });

  test("timeoutSeconds maps to --print-timeout and the host watchdog in stdin mode", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdout(gwStream(["d"], "ok"));
    await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false, timeoutSeconds: 12 })));
    const argv = fake.runCalls[0]?.argv ?? [];
    expect(argv).toContain("--print-timeout");
    expect(argv[argv.indexOf("--print-timeout") + 1]).toBe("12s");
    expect(argv).toContain("--input-format");
    expect(argv[argv.indexOf("--input-format") + 1]).toBe("text");
    expect(fake.runCalls[0]?.hostTimeoutMs).toBe(12_000 + HOST_GRACE_MS);
  });

  test("the prompt is delivered as stream-json NDJSON on stdin, not as an argv element", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdout(gwStream(["d"], "ok"));
    await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false, messages: [{ role: "user", content: "say PONG" }] })));
    const argv = fake.runCalls[0]?.argv ?? [];
    expect(argv).not.toContain("-p");
    const stdin = fake.runCalls[0]?.stdin ?? "";
    expect(stdin).toContain("say PONG");
    expect(stdin).not.toContain('"type"');
  });

  test("conversationId body field and x-agy-conversation header both forward --conversation", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdout(gwStream(["d"], "ok"));
    await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false, conversationId: "conv-body" })));
    const bodyArgv = fake.runCalls[0]?.argv ?? [];
    expect(bodyArgv).toContain("--conversation");
    expect(bodyArgv[bodyArgv.indexOf("--conversation") + 1]).toBe("conv-body");

    fake.setStdout(gwStream(["d"], "ok"));
    const headerRequest = new Request(baseUrl + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agy-conversation": "conv-header" },
      body: JSON.stringify(chatBody({ stream: false })),
    });
    await fetch(headerRequest);
    const headerArgv = fake.runCalls[1]?.argv ?? [];
    expect(headerArgv).toContain("--conversation");
    expect(headerArgv[headerArgv.indexOf("--conversation") + 1]).toBe("conv-header");
  });

  test("temperature and unknown fields are ignored", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdout(gwStream(["d"], "ok"));
    const response = await fetch(
      baseUrl + "/v1/chat/completions",
      jsonRequest(chatBody({ stream: false, temperature: 0.7, top_p: 1, n: 2 })),
    );
    expect(response.status).toBe(200);
  });
});

describe("POST /v1/chat/completions streaming", () => {
  test("stream=true emits SSE chunks, a stop chunk, conversation comment and [DONE]", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdout(gwStream(["delta one. ", "delta two. "], "ignored for stream"));
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: true })));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();

    const dataLines = text
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));
    const chunks = dataLines
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const contentChunks = chunks.map(
      (chunk) => ((chunk["choices"] as Array<Record<string, unknown>>)[0]?.["delta"] as Record<string, unknown>)?.["content"],
    );
    expect(contentChunks).toEqual(["delta one. ", "delta two. ", undefined]);

    const terminal = chunks[chunks.length - 1] as Record<string, unknown>;
    expect((terminal["choices"] as Array<Record<string, unknown>>)[0]?.["finish_reason"]).toBe("stop");

    // Every data line must be a standard chunk or [DONE]: strict OpenAI clients
    // (AI SDK) reject non-standard payloads like a bare conversation_id object.
    for (const chunk of chunks) {
      expect(chunk["choices"]).toBeDefined();
    }

    expect(text).toContain(`: conversation_id=${GW_CONVERSATION_ID}`);
    expect(text).not.toContain('"conversation_id"');
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  test("stream defaults to true when omitted", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdout(gwStream(["delta one. "], "ignored for stream"));
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({})));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await response.text();
  });

  test("tool steps stream as OpenAI tool_calls deltas with bounded arguments", async () => {
    const { baseUrl, fake } = await spawn();
    const toolLine = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: GW_CONVERSATION_ID,
        step_index: 1,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "git status" } },
      },
    });
    fake.setStdout([gwInitLine(), toolLine, gwStepLine("result text. "), gwResultLine("SUCCESS", "ignored")].join("\n") + "\n");
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: true })));
    const text = await response.text();
    const toolChunk = text
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((chunk) => {
        const delta = (chunk["choices"] as Array<Record<string, unknown>>)[0]?.["delta"] as Record<string, unknown> | undefined;
        return delta?.["tool_calls"] !== undefined;
      });
    const delta = (toolChunk?.["choices"] as Array<Record<string, unknown>>)[0]?.["delta"] as Record<string, unknown>;
    const toolCall = (delta["tool_calls"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(toolCall["type"]).toBe("function");
    expect((toolCall["function"] as Record<string, unknown>)["name"]).toBe("run_command");
    expect((toolCall["function"] as Record<string, unknown>)["arguments"]).toBe('{"CommandLine":"git status"}');
    expect(text).not.toContain("[agy:");
    expect(text).toContain("result text. ");
  });

  test("tool step activity is disabled by AGY_GATEWAY_STREAM_STEPS=0", async () => {
    const { baseUrl, fake } = await spawn({}, { AGY_GATEWAY_STREAM_STEPS: "0" });
    const toolLine = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: GW_CONVERSATION_ID,
        step_index: 1,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
      },
    });
    fake.setStdout([gwInitLine(), toolLine, gwStepLine("result text. "), gwResultLine("SUCCESS", "ignored")].join("\n") + "\n");
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: true })));
    const text = await response.text();
    expect(text).not.toContain("tool_calls");
    expect(text).toContain("result text. ");
  });

  test("text deltas containing JSON-special characters are escaped", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdout(gwStream(['say "hi"\nnext line\t'], "ignored for stream"));
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: true })));
    const text = await response.text();
    expect(text).toContain('"content":"say \\"hi\\"\\nnext line\\t"');
  });

  test("max_tokens caps the streamed text at approximately 4 chars per token", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdout(gwStream(["0123456789abc"], "ignored for stream"));
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: true, max_tokens: 3 })));
    const text = await response.text();
    expect(text).toContain('"content":"0123456789ab"');
    expect(text).not.toContain("0123456789abc");
  });

  test("non-stream max_tokens caps the response text", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdout(gwStream(["d"], "0123456789abc"));
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false, max_tokens: 3 })));
    const body = (await response.json()) as Record<string, unknown>;
    const choices = body["choices"] as Array<Record<string, unknown>>;
    expect((choices[0]?.["message"] as Record<string, unknown>)["content"]).toBe("0123456789ab");
  });
});

describe("POST /v1/chat/completions validation", () => {
  test("malformed JSON body is a 400 invalid_request", async () => {
    const { baseUrl } = await spawn();
    const response = await fetch(baseUrl + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  test.each([
    ["missing messages", chatBody({ messages: undefined })],
    ["empty messages", chatBody({ messages: [] })],
    ["unknown role", chatBody({ messages: [{ role: "function", content: "x" }] })],
    ["non-string content", chatBody({ messages: [{ role: "user", content: 42 }] })],
    ["non-string model", chatBody({ model: 42 })],
    ["blank model", chatBody({ model: "" })],
    ["invalid max_tokens", chatBody({ max_tokens: -1 })],
    ["invalid timeoutSeconds", chatBody({ timeoutSeconds: 0 })],
    ["invalid mode", chatBody({ mode: "chaos" })],
  ])("%s returns 400", async (_name, body) => {
    const { baseUrl } = await spawn();
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(body));
    expect(response.status).toBe(400);
    const parsed = (await response.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe("invalid_request");
  });
});

describe("POST /v1/chat/completions upstream errors", () => {
  test("a host timeout maps to 504 gateway_timeout", async () => {
    const { baseUrl, fake } = await spawn();
    fake.failRun(new ProcessError("timeout", "agy run (pid 7) exceeded the host timeout and was terminated", { pid: 7, exit: { exitCode: null, signal: "SIGTERM" } }));
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false })));
    expect(response.status).toBe(504);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("gateway_timeout");
  });

  test("a spawn failure maps to 500 with a redacted message", async () => {
    const { baseUrl, fake } = await spawn();
    fake.failRun(new ProcessError("spawn-failed", "failed to spawn agy sk-ABCDEF123456"));
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false })));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("sk-ABCDEF123456");
    expect(text).toContain("server_error");
  });

  test("an agy ERROR status maps to 500 with the redacted upstream detail", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdout([gwResultLine("ERROR", "", "upstream exploded sk-ABCDEF123456")].join("\n") + "\n");
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false })));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("upstream exploded");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("sk-ABCDEF123456");
  });

  test("a resolve failure maps to 500", async () => {
    const { baseUrl, fake } = await spawn();
    fake.failResolve(new ResolveError("not-found", "agy executable was not found (checked AGY_PATH and PATH)"));
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false })));
    expect(response.status).toBe(500);
  });

  test("stream=true timeout surfaces as an SSE error line followed by [DONE]", async () => {
    const { baseUrl, fake } = await spawn();
    fake.failRun(new ProcessError("timeout", "agy run (pid 7) exceeded the host timeout and was terminated"));
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: true })));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"code":"gateway_timeout"');
    expect(text).toContain("data: [DONE]");
  });
});

describe("POST /v1/chat/completions serial queue", () => {
  test("two concurrent requests run strictly one at a time in FIFO order", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setBlocking(true);
    fake.setStdout(gwStream(["d"], "ok"));
    const first = fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false, model: "model-one" })));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    const second = fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false, model: "model-two" })));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    expect(fake.runCalls.length).toBe(1);
    expect(fake.runCalls[0]?.argv).toContain("--model");

    fake.setBlocking(false);
    fake.release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(fake.runCalls.length).toBe(2);
    expect(fake.maxActive).toBe(1);
    const firstArgv = fake.runCalls[0]?.argv ?? [];
    const secondArgv = fake.runCalls[1]?.argv ?? [];
    expect(firstArgv[firstArgv.indexOf("--model") + 1]).toBe("model-one");
    expect(secondArgv[secondArgv.indexOf("--model") + 1]).toBe("model-two");
  });

  test("a full queue returns 429 queue_full", async () => {
    const { baseUrl, fake } = await spawn({ maxQueue: 1 });
    fake.setBlocking(true);
    const first = fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false, model: "blocked-one" })));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    const second = fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false, model: "blocked-two" })));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    const overflow = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false })));
    expect(overflow.status).toBe(429);
    const body = (await overflow.json()) as { error: { message: string; type: string; code: number } };
    expect(body.error.message).toBe("queue full");
    expect(body.error.type).toBe("queue_full");
    expect(body.error.code).toBe(429);

    fake.setBlocking(false);
    fake.release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
  });
});

describe("GET /v1/models", () => {
  test("returns the OpenAI model list shape from agy models output", async () => {
    const cacheDir = tempDir();
    const { baseUrl, fake } = await spawn({ cacheDir });
    fake.setStdout("gemini-3.7-flash-high\nclaude-sonnet-4-6\n");
    const response = await fetch(baseUrl + "/v1/models");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string; data: ReadonlyArray<{ id: string; object: string; owned_by: string }> };
    expect(body.object).toBe("list");
    expect(body.data).toEqual([
      { id: "gemini-3.7-flash-high", object: "model", owned_by: "agy" },
      { id: "claude-sonnet-4-6", object: "model", owned_by: "agy" },
    ]);
    const argv = fake.runCalls[0]?.argv ?? [];
    expect(argv[argv.length - 1]).toBe("models");
  });

  test("falls back to builtins when agy models fails and no cache exists", async () => {
    const cacheDir = tempDir();
    const { baseUrl, fake } = await spawn({ cacheDir });
    fake.failRun(new ProcessError("spawn-failed", "failed to spawn agy: ENOENT"));
    const response = await fetch(baseUrl + "/v1/models");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: ReadonlyArray<{ id: string }> };
    expect(body.data.map((entry) => entry.id)).toEqual([...BUILTIN_MODELS]);
  });

  test("serves a fresh cached list without spawning agy again", async () => {
    const cacheDir = tempDir();
    const { baseUrl, fake } = await spawn({ cacheDir });
    writeFileSync(join(cacheDir, "models.json"), JSON.stringify({ models: ["cached-model"], fetchedAt: Date.now() }));
    const response = await fetch(baseUrl + "/v1/models");
    const body = (await response.json()) as { data: ReadonlyArray<{ id: string }> };
    expect(body.data.map((entry) => entry.id)).toEqual(["cached-model"]);
    expect(fake.runCalls.length).toBe(0);
  });
});

describe("gateway routing", () => {
  test("unknown routes return 404 with an OpenAI error shape", async () => {
    const { baseUrl } = await spawn();
    const response = await fetch(baseUrl + "/v1/unknown");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  test("GET /v1 answers 200 for SDK baseURL probes", async () => {
    const { baseUrl } = await spawn();
    const response = await fetch(baseUrl + "/v1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("GET / answers 200 for health probes", async () => {
    const { baseUrl } = await spawn();
    const response = await fetch(baseUrl + "/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("GET / and GET /v1 answer 200 without auth header even when token is configured", async () => {
    const { baseUrl } = await spawn({ token: "secret-token" });
    const probeV1 = await fetch(baseUrl + "/v1");
    expect(probeV1.status).toBe(200);
    const probeRoot = await fetch(baseUrl + "/");
    expect(probeRoot.status).toBe(200);
  });
});

describe("eligibility-check retry", () => {
  const eligibilityError = (): string =>
    `${gwResultLine("ERROR", "", 'Eligibility check failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": EOF')}\n`;

  test("a transient eligibility failure is retried transparently and succeeds", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdoutSequence([{ stdout: eligibilityError() }, { stdout: gwStream(["d"], "ok") }]);
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false })));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("ok");
    expect(fake.runCalls.length).toBe(2);
  });

  test("eligibility failures exhaust the retry budget and surface the upstream error", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdoutSequence([{ stdout: eligibilityError() }, { stdout: eligibilityError() }, { stdout: eligibilityError() }]);
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false })));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.message).toContain("Eligibility check failed");
    expect(fake.runCalls.length).toBe(3);
  });

  test("non-eligibility failures are not retried", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdoutSequence([{ stdout: `${gwResultLine("ERROR", "", "some unrelated failure")}\n` }]);
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false })));
    expect(response.status).toBe(500);
    expect(fake.runCalls.length).toBe(1);
  });

  test("a completely empty response is retried once and can succeed", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdoutSequence([{ stdout: `${gwResultLine("SUCCESS", "")}\n` }, { stdout: gwStream(["d"], "ok") }]);
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false })));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("ok");
    expect(fake.runCalls.length).toBe(2);
  });

  test("repeated empty responses exhaust the single retry and surface the error", async () => {
    const { baseUrl, fake } = await spawn();
    fake.setStdoutSequence([{ stdout: `${gwResultLine("SUCCESS", "")}\n` }, { stdout: `${gwResultLine("SUCCESS", "")}\n` }]);
    const response = await fetch(baseUrl + "/v1/chat/completions", jsonRequest(chatBody({ stream: false })));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("empty response");
    expect(fake.runCalls.length).toBe(2);
  });
});

describe("gatewayConfigFromEnv", () => {
  test("parses empty or whitespace token env as null", () => {
    expect(gatewayConfigFromEnv({}).token).toBeNull();
    expect(gatewayConfigFromEnv({ AGY_GATEWAY_TOKEN: "" }).token).toBeNull();
    expect(gatewayConfigFromEnv({ AGY_GATEWAY_TOKEN: "   " }).token).toBeNull();
    expect(gatewayConfigFromEnv({ AGY_GATEWAY_TOKEN: "my-token" }).token).toBe("my-token");
  });
});
