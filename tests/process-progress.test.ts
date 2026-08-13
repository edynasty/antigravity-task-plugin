/**
 * runAgy stdout-chunk observer (Todo 9). The optional `onStdoutChunk` callback
 * is invoked synchronously for every captured stdout chunk DURING child
 * execution — provable via a delayed NDJSON stream that writes chunks before
 * close. A throwing observer must never fail or abort the run, and omitting
 * the option must leave the captured result byte-identical.
 */
import { describe, expect, test } from "bun:test";
import { runAgy } from "../src/process";
import type { SpawnOptions } from "../src/process";
import { expectProcessErrorKind, makeSpawnOptions } from "./helpers/process-harness";
import { NDJSON_DELAY_ENV, NDJSON_STREAM_ENV } from "./fixtures/process-env";
import { line, initEvent, stepEvent, resultEvent } from "./fixtures/protocol/streams";

function delayedSuccessStream(): readonly string[] {
  return [initEvent(), stepEvent({ stepIndex: 0, state: "DONE", stepType: "run_command" }), resultEvent({ status: "SUCCESS", response: "done." })];
}

function ndjsonEnv(lines: readonly string[], delayMs: string): Readonly<Record<string, string>> {
  return { [NDJSON_STREAM_ENV]: JSON.stringify(lines), [NDJSON_DELAY_ENV]: delayMs };
}

async function makeNdjsonOptions(lines: readonly string[], delayMs: string, maxStdoutBytes?: number): Promise<SpawnOptions> {
  const { options } = await makeSpawnOptions({ scenario: "ndjson-stream", ...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }) });
  return { ...options, env: { ...options.env, ...ndjsonEnv(lines, delayMs) } };
}

function chunkObserver(): {
  readonly observed: string[];
  readonly timestamps: number[];
  onStdoutChunk: (chunk: string) => void;
} {
  const observed: string[] = [];
  const timestamps: number[] = [];
  return {
    observed,
    timestamps,
    onStdoutChunk: (chunk: string) => {
      observed.push(chunk);
      timestamps.push(Date.now());
    },
  };
}

describe("runAgy onStdoutChunk observer", () => {
  test("chunk callbacks fire before runAgy resolves and match captured chunks", async () => {
    const options = await makeNdjsonOptions(delayedSuccessStream(), "30");
    const { observed, timestamps, onStdoutChunk } = chunkObserver();
    const startedAt = Date.now();
    const result = await runAgy({ ...options, onStdoutChunk });
    const resolveAt = Date.now();

    expect(result.exitCode).toBe(0);
    expect(observed.join("")).toBe(result.stdoutChunks.join(""));
    expect(timestamps.length).toBe(delayedSuccessStream().length);
    expect(timestamps[0] ?? 0).toBeLessThan(resolveAt);
    expect(timestamps[0] ?? 0).toBeGreaterThanOrEqual(startedAt);
    expect(observed[0]).toContain('"event":"init"');
  });

  test("a throwing observer never fails or aborts the run", async () => {
    const options = await makeNdjsonOptions(delayedSuccessStream(), "5");
    const result = await runAgy({
      ...options,
      onStdoutChunk: () => {
        throw new Error("observer exploded");
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdoutChunks.length).toBe(delayedSuccessStream().length);
  });

  test("omitting onStdoutChunk keeps the captured result byte-identical (baseline)", async () => {
    const options = await makeNdjsonOptions(delayedSuccessStream(), "5");
    const { observed, onStdoutChunk } = chunkObserver();
    const withObserver = await runAgy({ ...options, onStdoutChunk });
    const withoutObserver = await runAgy({ ...options });

    expect(observed).toEqual([...withObserver.stdoutChunks]);
    expect(withoutObserver.stdoutChunks).toEqual(withObserver.stdoutChunks);
    expect(withoutObserver.exitCode).toBe(withObserver.exitCode);
    expect(withoutObserver.stdoutBytes).toBe(withObserver.stdoutBytes);
  });

  test("observer only sees chunks captured before stdout overflow terminates the run", async () => {
    const bigLines = ["x", line({ event: "result", result: { status: "SUCCESS", response: "y".repeat(200) } })];
    const options = await makeNdjsonOptions(bigLines, "5", 64);
    const { observed, onStdoutChunk } = chunkObserver();
    await expectProcessErrorKind(runAgy({ ...options, onStdoutChunk }), "stdout-overflow");
    expect(Buffer.byteLength(observed.join(""), "utf8")).toBeLessThanOrEqual(64);
    expect(observed.length).toBeGreaterThan(0);
  });

  test("abort before spawn rejects before any chunk is observed", async () => {
    const options = await makeNdjsonOptions(delayedSuccessStream(), "30");
    const aborted = new AbortController();
    aborted.abort();
    const { observed, onStdoutChunk } = chunkObserver();
    await expectProcessErrorKind(runAgy({ ...options, signal: aborted.signal, onStdoutChunk }), "aborted");
    expect(observed).toEqual([]);
  });
});
