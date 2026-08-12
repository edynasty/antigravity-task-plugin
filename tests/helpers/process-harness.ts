import { afterAll, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord, withTimeout } from "./fake-agy-harness";
import {
  ENV_PROBE_ENV,
  EXIT_CODE_ENV,
  PID_PATH_ENV,
  PROC_SCENARIO_ENV,
  RECORD_PATH_ENV,
  STDERR_LINES_ENV,
  STDOUT_LINES_ENV,
} from "../fixtures/process-env";
import { ProcessError, type ProcessErrorKind, type ProcessResult } from "../../src/process-types";

export const PROCESS_FIXTURE_PATH = resolve(import.meta.dir, "..", "fixtures", "process-fixture.ts");

const tempDirs: string[] = [];

export async function makeTempDir(): Promise<string> {
  // realpath canonicalizes macOS /var -> /private/var so the child's recorded
  // argv/cwd strings match the parent's expectations byte-for-byte.
  const raw = await mkdtemp(join(tmpdir(), "antigravity-proc-"));
  tempDirs.push(raw);
  return realpath(raw);
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

export interface FixtureEnvOptions {
  readonly scenario: string;
  readonly pidPath: string;
  readonly recordPath?: string;
  readonly exitCode?: string;
  readonly stderrLines?: string;
  readonly stdoutLines?: string;
  readonly envProbe?: string;
}

export function fixtureEnv(options: FixtureEnvOptions): Record<string, string> {
  const env: Record<string, string> = {
    [PROC_SCENARIO_ENV]: options.scenario,
    [PID_PATH_ENV]: options.pidPath,
  };
  if (options.recordPath !== undefined) {
    env[RECORD_PATH_ENV] = options.recordPath;
  }
  if (options.exitCode !== undefined) {
    env[EXIT_CODE_ENV] = options.exitCode;
  }
  if (options.stderrLines !== undefined) {
    env[STDERR_LINES_ENV] = options.stderrLines;
  }
  if (options.stdoutLines !== undefined) {
    env[STDOUT_LINES_ENV] = options.stdoutLines;
  }
  if (options.envProbe !== undefined) {
    env[ENV_PROBE_ENV] = options.envProbe;
  }
  return env;
}

export async function writeFixtureExecutable(dir: string, name: string, mode: number): Promise<string> {
  const path = join(dir, name);
  // sh wrapper + exec: shebang direct-exec of bun costs ~330ms of startup,
  // while `bun <file>` boots in ~40ms, so tests keep tight host timeouts.
  // JSON.stringify emits double-quoted paths, so spaces cannot split argv.
  const body = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(PROCESS_FIXTURE_PATH)} "$@"\n`;
  await writeFile(path, body, { mode });
  return path;
}

export async function makeExecutableAgy(): Promise<{ readonly path: string; readonly dir: string }> {
  const raw = await mkdtemp(join(tmpdir(), "antigravity-agy-"));
  tempDirs.push(raw);
  const dir = await realpath(raw);
  const path = await writeFixtureExecutable(dir, "agy-fixture", 0o755);
  return { path, dir };
}

export interface RecordedInvocation {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly envProbe: string | null;
}

export function readRecordedInvocation(path: string): RecordedInvocation {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecordedInvocation(parsed)) {
    throw new Error(`record fixture wrote an unexpected payload: ${path}`);
  }
  return parsed;
}

function isRecordedInvocation(value: unknown): value is RecordedInvocation {
  if (!isRecord(value)) {
    return false;
  }
  const argv = value["argv"];
  const cwd = value["cwd"];
  const envProbe = value["envProbe"];
  if (!Array.isArray(argv) || !argv.every((entry): entry is string => typeof entry === "string")) {
    return false;
  }
  if (typeof cwd !== "string") {
    return false;
  }
  return envProbe === null || typeof envProbe === "string";
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

export async function readPidFile(pidPath: string, deadlineMs = 2_000): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(pidPath)) {
      const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
    await delayMs(5);
  }
  throw new Error(`pid file never appeared with a valid pid: ${pidPath}`);
}

export function assertProcessGone(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
  throw new Error(`process ${pid} is still alive after runAgy settled`);
}

export interface CountingSignal {
  readonly signal: AbortSignal;
  readonly added: number;
  readonly removed: number;
}

export function makeCountingSignal(): CountingSignal {
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const signal = controller.signal;
  const origAdd = signal.addEventListener.bind(signal);
  const origRemove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, "addEventListener", {
    value: (type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
      added += 1;
      return origAdd(type, fn, opts);
    },
  });
  Object.defineProperty(signal, "removeEventListener", {
    value: (type: string, fn: EventListener, opts?: EventListenerOptions) => {
      removed += 1;
      return origRemove(type, fn, opts);
    },
  });
  return {
    signal,
    get added(): number {
      return added;
    },
    get removed(): number {
      return removed;
    },
  };
}

export async function expectProcessErrorKind(promise: Promise<ProcessResult>, kind: ProcessErrorKind): Promise<void> {
  try {
    const result = await withTimeout(promise, 5_000, `expected ProcessError(${kind}) but runAgy never settled`);
    throw new Error(`expected ProcessError(${kind}) but runAgy resolved with pid ${result.pid}`);
  } catch (error) {
    if (error instanceof ProcessError) {
      expect(error.kind).toBe(kind);
      return;
    }
    throw error;
  }
}
