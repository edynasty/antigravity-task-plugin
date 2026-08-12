/**
 * Subprocess lifecycle management for the agy headless CLI (Todo 4).
 *
 * `runAgy` races the child's close event against the host timeout timer and
 * the caller's AbortSignal. First event wins: a clean close resolves; timeout
 * or abort transitions to "terminating" (SIGTERM, bounded grace, SIGKILL) and
 * rejects only after the close event confirms the child is reaped. The state
 * machine is idempotent: repeated aborts and late timeouts are no-ops, and
 * every settle path clears timers and listeners exactly once.
 *
 * Bounded settlement: a direct child may exit while a descendant keeps the
 * stdio pipes open, so 'close' can never arrive. After SIGKILL, `closeWatchMs`
 * bounds the wait; on expiry runAgy destroys the pipes and rejects with the
 * original termination kind and `exit { exitCode: null, signal: null }`
 * (direct-child exit never observed — descendant cleanup is the caller's).
 *
 * Host timeout relation (for Todo 5): pass `hostTimeoutMs` derived from the
 * tool's `timeoutSeconds` as `timeoutSeconds * 1000 + HOST_GRACE_MS` so agy's
 * own `--print-timeout` failure is not preempted by the watchdog.
 *
 * stdout is captured as UTF-8-decoded chunks (safe for the incremental parser
 * across multi-byte boundaries) up to `maxStdoutBytes`; stderr is captured as
 * one bounded string. Overflow of either stream is a typed failure, never a
 * silent discard. Exit code/signal follow the Node child_process contract
 * (code null + signal name for signal death). No protocol parsing happens here.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  DEFAULT_CLOSE_WATCH_MS,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  DEFAULT_TERMINATE_GRACE_MS,
  HOST_GRACE_MS,
  ProcessError,
  terminationMessage,
  type ProcessExit,
  type ProcessResult,
  type TerminationKind,
} from "./process-types.js";
import { resolveAgy } from "./discovery.js";

export { DEFAULT_MAX_STDERR_BYTES, DEFAULT_MAX_STDOUT_BYTES, DEFAULT_TERMINATE_GRACE_MS, HOST_GRACE_MS, resolveAgy };
export type { DiscoveryOptions } from "./discovery.js";
export type { ProcessErrorKind, ProcessExit, ProcessResult } from "./process-types.js";

export interface SpawnOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly hostTimeoutMs: number;
  readonly terminateGraceMs?: number;
  readonly closeWatchMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runAgy(options: SpawnOptions): Promise<ProcessResult> {
  const graceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
  const closeWatchMs = options.closeWatchMs ?? DEFAULT_CLOSE_WATCH_MS;
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderr = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  if (!Number.isFinite(options.hostTimeoutMs) || options.hostTimeoutMs <= 0) {
    return Promise.reject(new ProcessError("timeout", `hostTimeoutMs must be a positive finite number, got ${String(options.hostTimeoutMs)}`));
  }
  const [command, ...args] = options.argv;
  if (command === undefined) {
    return Promise.reject(new ProcessError("spawn-failed", "argv must name an executable command"));
  }
  if (options.signal.aborted) {
    return Promise.reject(new ProcessError("aborted", "agy run was aborted before spawn"));
  }
  return new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env === undefined ? undefined : { ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectPromise(new ProcessError("spawn-failed", `failed to spawn agy: ${errorMessage(error)}`));
      return;
    }

    type Phase = "running" | "terminating" | "done";
    let phase: Phase = "running";
    let terminationKind: TerminationKind | null = null;
    let overflowBytes: number | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let closeWatchTimer: ReturnType<typeof setTimeout> | null = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const stdoutChunks: string[] = [];
    let stderr = "";

    const cleanup = (): void => {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      if (closeWatchTimer !== null) {
        clearTimeout(closeWatchTimer);
        closeWatchTimer = null;
      }
      if (child.stdout !== null) {
        child.stdout.off("data", onStdout);
      }
      if (child.stderr !== null) {
        child.stderr.off("data", onStderr);
      }
      child.off("close", onClose);
      child.off("error", onError);
      options.signal.removeEventListener("abort", onAbort);
    };

    const rejectSettled = (error: ProcessError): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectPromise(error);
    };

    const resolveSettled = (result: ProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolvePromise(result);
    };

    const onStdout = (chunk: string | Buffer): void => {
      if (settled) {
        return;
      }
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdoutBytes += Buffer.byteLength(text, "utf8");
      if (phase === "running" && overflowBytes === null && stdoutBytes > maxStdout) {
        overflowBytes = stdoutBytes;
        beginTermination("stdout-overflow");
      }
      if (overflowBytes === null) {
        stdoutChunks.push(text);
      }
    };

    const onStderr = (chunk: string | Buffer): void => {
      if (settled) {
        return;
      }
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrBytes += Buffer.byteLength(text, "utf8");
      if (phase === "running" && overflowBytes === null && stderrBytes > maxStderr) {
        overflowBytes = stderrBytes;
        beginTermination("stderr-overflow");
      } else if (overflowBytes === null) {
        stderr += text;
      }
    };

    const beginTermination = (kind: TerminationKind): void => {
      if (phase !== "running") {
        return;
      }
      phase = "terminating";
      terminationKind = kind;
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      child.kill("SIGTERM");
      graceTimer = setTimeout(() => {
        graceTimer = null;
        child.kill("SIGKILL");
        closeWatchTimer = setTimeout(onCloseWatchTimeout, closeWatchMs);
      }, graceMs);
    };

    const onCloseWatchTimeout = (): void => {
      closeWatchTimer = null;
      if (phase !== "terminating" || terminationKind === null) {
        return;
      }
      phase = "done";
      if (child.stdout !== null) {
        child.stdout.destroy();
      }
      if (child.stderr !== null) {
        child.stderr.destroy();
      }
      const pid = child.pid ?? 0;
      const exit: ProcessExit = { exitCode: null, signal: null };
      rejectSettled(
        new ProcessError(terminationKind, terminationMessage(terminationKind, pid, exit), {
          pid,
          exit,
          ...(overflowBytes !== null ? { capturedBytes: overflowBytes } : {}),
        }),
      );
    };

    const onAbort = (): void => {
      if (phase === "running") {
        beginTermination("aborted");
      }
    };

    const onTimeout = (): void => {
      if (phase === "running") {
        beginTermination("timeout");
      }
    };

    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      phase = "done";
      const exit: ProcessExit = { exitCode, signal };
      const pid = child.pid ?? 0;
      if (terminationKind !== null) {
        rejectSettled(
          new ProcessError(terminationKind, terminationMessage(terminationKind, pid, exit), {
            pid,
            exit,
            ...(overflowBytes !== null ? { capturedBytes: overflowBytes } : {}),
          }),
        );
        return;
      }
      resolveSettled({ pid, exitCode, signal, stdoutChunks, stdoutBytes, stderr, stderrBytes });
    };

    const onError = (error: Error): void => {
      const details = child.pid === undefined ? {} : { pid: child.pid };
      rejectSettled(new ProcessError("spawn-failed", `failed to spawn agy: ${error.message}`, details));
    };

    if (child.stdout !== null) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", onStdout);
    }
    if (child.stderr !== null) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", onStderr);
    }
    child.on("close", onClose);
    child.on("error", onError);
    options.signal.addEventListener("abort", onAbort);
    timeoutTimer = setTimeout(onTimeout, options.hostTimeoutMs);
  });
}
