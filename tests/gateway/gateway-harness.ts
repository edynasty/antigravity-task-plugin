/**
 * Shared deterministic fakes for gateway tests (Todo 13).
 *
 * Pure in-memory harness: the fake GatewayDeps never spawns a process and
 * never touches the network. `processResult` builds Todo-4-shaped ProcessResult
 * values and the NDJSON builders emit official stream-json lines whose result
 * usage (15 total) intentionally differs from the step usage (7 total) so tests
 * can prove result usage is authoritative.
 */
import type { Server } from "node:http";
import { ProcessError, ResolveError } from "../../src/process-types";
import type { ProcessResult, SpawnOptions } from "../../src/process";
import type { GatewayDeps } from "../../src/gateway/deps";
import type { GatewayConfig } from "../../src/gateway/server";
import { createGatewayServer } from "../../src/gateway/server";
export const GW_CONVERSATION_ID = "conv-gateway-00000000-0000-4000-8000-000000000000";
export const GW_RESULT_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  thinking_tokens: 2,
  cache_read_tokens: 0,
  total_tokens: 15,
} as const;
export const GW_STEP_USAGE = {
  input_tokens: 5,
  output_tokens: 2,
  thinking_tokens: 1,
  cache_read_tokens: 0,
  total_tokens: 7,
} as const;

export function gwInitLine(): string {
  return JSON.stringify({
    event: "init",
    conversation_id: GW_CONVERSATION_ID,
    init: { cwd: "/work", tools: [], permission_mode: "request-review", model: "claude-sonnet-4-6" },
  });
}

export function gwStepLine(delta: string): string {
  return JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: GW_CONVERSATION_ID,
      step_index: 0,
      state: "DONE",
      step_type: "agent_response",
      text_delta: delta,
      usage: GW_STEP_USAGE,
    },
  });
}

export function gwResultLine(status: "SUCCESS" | "ERROR", response: string, error?: string): string {
  return JSON.stringify({
    event: "result",
    result: {
      conversation_id: GW_CONVERSATION_ID,
      status,
      response,
      duration_seconds: 0.02,
      num_turns: 1,
      usage: GW_RESULT_USAGE,
      ...(error === undefined ? {} : { error }),
    },
  });
}

export function gwStream(deltas: readonly string[], response: string): string {
  return [gwInitLine(), ...deltas.map((delta) => gwStepLine(delta)), gwResultLine("SUCCESS", response)].join("\n") + "\n";
}

interface ProcOverrides {
  readonly stdout?: string;
  readonly chunks?: readonly string[];
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals | null;
}

export function processResult(overrides: ProcOverrides = {}): ProcessResult {
  const chunks = overrides.chunks ?? [overrides.stdout ?? gwStream(["fake-gateway delta. "], "fake-gateway success response.")];
  const stdout = chunks.join("");
  const stderr = overrides.stderr ?? "";
  const signal = overrides.signal ?? null;
  const exitCode = signal !== null ? null : (overrides.exitCode ?? 0);
  return {
    pid: 4242,
    stdoutChunks: chunks,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderr,
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
    exitCode,
    signal,
  };
}

export interface FakeGatewayDeps {
  readonly deps: GatewayDeps;
  readonly runCalls: readonly SpawnOptions[];
  readonly resolveCalls: number;
  readonly maxActive: number;
  setStdout(stdout: string): void;
  setStdoutSequence(sequence: Array<{ stdout: string } | ProcessError>): void;
  failRun(error: ProcessError): void;
  failResolve(error: ResolveError): void;
  setBlocking(blocking: boolean): void;
  release(): void;
}

export function makeGatewayDeps(envOverrides: Readonly<Record<string, string>> = {}): FakeGatewayDeps {
  const runCalls: SpawnOptions[] = [];
  let resolveCalls = 0;
  let maxActive = 0;
  let active = 0;
  let resolveOutcome: string | ResolveError = "/fake/agy";
  let runOutcome: ProcessResult | ProcessError = processResult();
  let runOutcomeQueue: Array<ProcessResult | ProcessError> = [];
  let blocking = false;
  const blockers: Array<() => void> = [];

  const deps: GatewayDeps = {
    env: { PATH: "/usr/bin", AGY_PATH: "/fake", ...envOverrides },
    platform: "darwin",
    cwd: "/work",
    resolveAgy: () => {
      resolveCalls += 1;
      if (resolveOutcome instanceof ResolveError) {
        throw resolveOutcome;
      }
      return resolveOutcome;
    },
    runAgy: async (options) => {
      runCalls.push(options);
      const queued = runOutcomeQueue.shift();
      const outcome: ProcessResult | ProcessError = queued === undefined ? runOutcome : queued;
      if (outcome instanceof ProcessError) {
        throw outcome;
      }
      if (blocking) {
        await new Promise<void>((resolvePromise) => {
          blockers.push(resolvePromise);
        });
      }
      if (options.signal.aborted) {
        throw new ProcessError("aborted", "agy run was aborted before spawn");
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        for (const chunk of outcome.stdoutChunks) {
          options.onStdoutChunk?.(chunk);
        }
        return outcome;
      } finally {
        active -= 1;
      }
    },
  };

  return {
    deps,
    get runCalls() {
      return runCalls;
    },
    get resolveCalls() {
      return resolveCalls;
    },
    get maxActive() {
      return maxActive;
    },
    setStdout(stdout) {
      runOutcome = processResult({ stdout });
    },
    setStdoutSequence(sequence) {
      runOutcomeQueue = sequence.map((entry) =>
        entry instanceof ProcessError ? entry : processResult({ stdout: entry.stdout }),
      );
    },
    failRun(error) {
      runOutcome = error;
    },
    failResolve(error) {
      resolveOutcome = error;
    },
    setBlocking(value) {
      blocking = value;
    },
    release() {
      const pending = blockers.splice(0);
      for (const resolvePromise of pending) {
        resolvePromise();
      }
    },
  };
}

export interface GatewayServerHandle {
  readonly baseUrl: string;
  readonly server: Server;
  readonly fake: FakeGatewayDeps;
  readonly config: GatewayConfig;
  close(): Promise<void>;
}

export async function startGateway(
  overrides: Partial<GatewayConfig> = {},
  envOverrides: Readonly<Record<string, string>> = {},
): Promise<GatewayServerHandle> {
  const fake = makeGatewayDeps(envOverrides);
  const config: GatewayConfig = {
    host: "127.0.0.1",
    port: 0,
    token: null,
    maxQueue: 8,
    defaultTimeoutSeconds: 300,
    modelsTtlSeconds: 3600,
    cacheDir: "/tmp/agy-gateway-test",
    ...overrides,
  };
  const server = createGatewayServer(fake.deps, config);
  await new Promise<void>((resolvePromise) => {
    server.listen(config.port, config.host, resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("gateway test server did not bind a TCP port");
  }
  const baseUrl = `http://${config.host}:${String(address.port)}`;
  return {
    baseUrl,
    server,
    fake,
    config,
    close() {
      return new Promise<void>((resolvePromise) => {
        server.closeAllConnections();
        server.close(() => resolvePromise());
      });
    },
  };
}

export function jsonRequest(body: unknown, token?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  };
}

export function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gemini-3.5-flash-medium",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}
