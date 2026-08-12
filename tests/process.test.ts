import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildArgv } from "../src/args";
import { resolveAgy, runAgy, type SpawnOptions } from "../src/process";
import { ResolveError } from "../src/process-types";
import {
  PROCESS_FIXTURE_PATH,
  assertProcessGone,
  expectProcessErrorKind,
  fixtureEnv,
  makeCountingSignal,
  makeExecutableAgy,
  makeTempDir,
  readPidFile,
  readRecordedInvocation,
  writeFixtureExecutable,
} from "./helpers/process-harness";

function captureResolveError(fn: () => string): ResolveError | null {
  try {
    fn();
  } catch (error) {
    if (error instanceof ResolveError) {
      return error;
    }
    return null;
  }
  return null;
}

interface SpawnOverrides {
  readonly scenario?: string;
  readonly signal?: AbortSignal;
  readonly hostTimeoutMs?: number;
  readonly terminateGraceMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly exitCode?: string;
  readonly stderrLines?: string;
  readonly stdoutLines?: string;
  readonly envProbe?: string;
  readonly recordPath?: string;
}

async function makeSpawnOptions(
  overrides: SpawnOverrides,
): Promise<{ readonly options: SpawnOptions; readonly pidPath: string; readonly dir: string }> {
  const dir = await makeTempDir();
  const pidPath = join(dir, "child.pid");
  const { path } = await makeExecutableAgy();
  const options: SpawnOptions = {
    argv: [path, "fixture-task"],
    cwd: dir,
    env: fixtureEnv({
      scenario: overrides.scenario ?? "record",
      pidPath,
      ...(overrides.recordPath !== undefined ? { recordPath: overrides.recordPath } : {}),
      ...(overrides.exitCode !== undefined ? { exitCode: overrides.exitCode } : {}),
      ...(overrides.stderrLines !== undefined ? { stderrLines: overrides.stderrLines } : {}),
      ...(overrides.stdoutLines !== undefined ? { stdoutLines: overrides.stdoutLines } : {}),
      ...(overrides.envProbe !== undefined ? { envProbe: overrides.envProbe } : {}),
    }),
    signal: overrides.signal ?? new AbortController().signal,
    hostTimeoutMs: overrides.hostTimeoutMs ?? 5_000,
    ...(overrides.terminateGraceMs !== undefined ? { terminateGraceMs: overrides.terminateGraceMs } : {}),
    ...(overrides.maxStdoutBytes !== undefined ? { maxStdoutBytes: overrides.maxStdoutBytes } : {}),
    ...(overrides.maxStderrBytes !== undefined ? { maxStderrBytes: overrides.maxStderrBytes } : {}),
  };
  return { options, pidPath, dir };
}

describe("resolveAgy executable discovery", () => {
  test("explicit injection wins over AGY_PATH and PATH", async () => {
    const { path: injected } = await makeExecutableAgy();
    const { path: viaEnv } = await makeExecutableAgy();
    const { path: viaPath } = await makeExecutableAgy();
    const { dir } = await makeExecutableAgy();
    expect(resolveAgy({ injected, env: { AGY_PATH: viaEnv }, path: [dir] })).toBe(injected);
    expect(resolveAgy({ env: { AGY_PATH: viaEnv }, path: [dir] })).toBe(viaEnv);
    expect(resolveAgy({ env: { AGY_PATH: viaPath }, path: [dir] })).toBe(viaPath);
  });

  test("bare command name is found by PATH search honoring separators", async () => {
    const { dir } = await makeExecutableAgy();
    const path = join(dir, "agy");
    await writeFixtureExecutable(dir, "agy", 0o755);
    expect(resolveAgy({ env: {}, path: [dir] })).toBe(path);
  });

  test("missing executable on an empty PATH is a typed not-found", () => {
    const error = captureResolveError(() => resolveAgy({ env: {}, path: [] }));
    expect(error?.kind).toBe("not-found");
  });

  test("AGY_PATH pointing at a nonexistent absolute path is not-found", () => {
    expect(() => resolveAgy({ env: { AGY_PATH: "/nonexistent/agy-binary" } })).toThrowError(
      expect.objectContaining({ kind: "not-found" }),
    );
  });

  test("an existing file without executable permission is a typed not-executable", async () => {
    const { dir } = await makeExecutableAgy();
    const plain = await writeFixtureExecutable(dir, "plain-file", 0o644);
    expect(() => resolveAgy({ env: {}, injected: plain })).toThrowError(
      expect.objectContaining({ kind: "not-executable" }),
    );
  });

  test("empty injected path is a typed empty-path", () => {
    expect(() => resolveAgy({ env: {}, injected: "   " })).toThrowError(
      expect.objectContaining({ kind: "empty-path" }),
    );
  });
});

describe("runAgy spawn and capture", () => {
  test("record: exact argv, cwd and env propagation; exit 0; child reaped", async () => {
    const dir = await makeTempDir();
    const pidPath = join(dir, "child.pid");
    const recordPath = join(dir, "record.json");
    const { path } = await makeExecutableAgy();
    const argv = buildArgv({ task: "a; $(rm -rf /) & \"quoted\"", timeoutSeconds: 90 });
    const env = fixtureEnv({ scenario: "record", pidPath, recordPath, envProbe: "probe-value" });
    const result = await runAgy({ argv: [path, ...argv], cwd: dir, env, signal: new AbortController().signal, hostTimeoutMs: 5_000 });
    const pid = await readPidFile(pidPath);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    const recorded = readRecordedInvocation(recordPath);
    expect(recorded.argv).toEqual([PROCESS_FIXTURE_PATH, ...argv]);
    expect(recorded.cwd).toBe(dir);
    expect(recorded.envProbe).toBe("probe-value");
    assertProcessGone(pid);
  });

  test("stderr capture with nonzero exit and exact exit code", async () => {
    const { options, pidPath } = await makeSpawnOptions({ scenario: "stderr", exitCode: "7", stderrLines: "2" });
    const result = await runAgy(options);
    const pid = await readPidFile(pidPath);
    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain("process-fixture diagnostic 1");
    expect(result.stderr).toContain("process-fixture diagnostic 2");
    expect(result.stdoutChunks.join("")).toBe("");
    assertProcessGone(pid);
  });

  test("stdout chunks are collected and joined losslessly", async () => {
    const { options, pidPath } = await makeSpawnOptions({ scenario: "output", stdoutLines: "3" });
    const result = await runAgy(options);
    const pid = await readPidFile(pidPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdoutChunks.join("")).toBe("process-fixture stdout line 1\nprocess-fixture stdout line 2\nprocess-fixture stdout line 3\n");
    expect(result.stdoutBytes).toBeGreaterThan(0);
    assertProcessGone(pid);
  });

  test("missing cwd is a typed spawn-failed", async () => {
    const { path } = await makeExecutableAgy();
    const dir = await makeTempDir();
    const pidPath = join(dir, "child.pid");
    const env = fixtureEnv({ scenario: "record", pidPath });
    const promise = runAgy({
      argv: [path, "t"],
      cwd: join(dir, "does-not-exist"),
      env,
      signal: new AbortController().signal,
      hostTimeoutMs: 5_000,
    });
    await expectProcessErrorKind(promise, "spawn-failed");
  });

  test("signal death is reported as exitCode null plus the signal name", async () => {
    const { options, pidPath } = await makeSpawnOptions({ scenario: "signal-term" });
    const result = await runAgy(options);
    const pid = await readPidFile(pidPath);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    assertProcessGone(pid);
  });

  test("a pre-aborted signal rejects aborted without spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    const { options, pidPath } = await makeSpawnOptions({ signal: controller.signal });
    await expectProcessErrorKind(runAgy(options), "aborted");
    expect(readPidFile(pidPath, 150).catch(() => -1)).resolves.toBe(-1);
  });
});

describe("runAgy timeout, abort and cleanup", () => {
  test("host timeout on a hanging child rejects timeout and reaps the exact PID", async () => {
    const { options, pidPath } = await makeSpawnOptions({ scenario: "hang", hostTimeoutMs: 1200, terminateGraceMs: 300 });
    const promise = runAgy(options);
    const settlement = expectProcessErrorKind(promise, "timeout");
    const pid = await readPidFile(pidPath);
    await settlement;
    assertProcessGone(pid);
  });

  test("abort on a hanging child rejects aborted and reaps the exact PID", async () => {
    const controller = new AbortController();
    const { options, pidPath } = await makeSpawnOptions({ scenario: "hang", signal: controller.signal });
    const promise = runAgy(options);
    const settlement = expectProcessErrorKind(promise, "aborted");
    const pid = await readPidFile(pidPath);
    controller.abort();
    await settlement;
    assertProcessGone(pid);
  });

  test("SIGTERM-ignoring child is escalated to SIGKILL after the grace period", async () => {
    const { options, pidPath } = await makeSpawnOptions({ scenario: "ignore-term", hostTimeoutMs: 1200, terminateGraceMs: 300 });
    const promise = runAgy(options);
    const settlement = expectProcessErrorKind(promise, "timeout");
    const pid = await readPidFile(pidPath);
    await settlement;
    assertProcessGone(pid);
  });

  test("repeated aborts are idempotent: exactly one aborted rejection, child reaped", async () => {
    const controller = new AbortController();
    const { options, pidPath } = await makeSpawnOptions({ scenario: "hang", signal: controller.signal });
    const promise = runAgy(options);
    const settlement = expectProcessErrorKind(promise, "aborted");
    const pid = await readPidFile(pidPath);
    controller.abort();
    controller.abort();
    await settlement;
    assertProcessGone(pid);
  });

  test("abort racing close: abort after clean completion is a no-op", async () => {
    const controller = new AbortController();
    const { options } = await makeSpawnOptions({ scenario: "record", signal: controller.signal });
    const result = await runAgy(options);
    controller.abort();
    expect(result.exitCode).toBe(0);
  });

  test("abort listener is removed exactly once after the run settles", async () => {
    const counting = makeCountingSignal();
    const { options } = await makeSpawnOptions({ scenario: "record", signal: counting.signal });
    await runAgy(options);
    expect(counting.added).toBe(1);
    expect(counting.removed).toBe(1);
  });
});

describe("runAgy bounded output", () => {
  test("stdout overflow rejects with stdout-overflow and reaps the child", async () => {
    const { options, pidPath } = await makeSpawnOptions({ scenario: "output", stdoutLines: "3", maxStdoutBytes: 16 });
    const promise = runAgy(options);
    const settlement = expectProcessErrorKind(promise, "stdout-overflow");
    const pid = await readPidFile(pidPath);
    await settlement;
    assertProcessGone(pid);
  });

  test("stderr overflow rejects with stderr-overflow and reaps the child", async () => {
    const { options, pidPath } = await makeSpawnOptions({ scenario: "stderr", stderrLines: "3", maxStderrBytes: 16 });
    const promise = runAgy(options);
    const settlement = expectProcessErrorKind(promise, "stderr-overflow");
    const pid = await readPidFile(pidPath);
    await settlement;
    assertProcessGone(pid);
  });
});
