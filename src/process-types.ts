/**
 * Shared types, named limits and typed errors for the agy process adapter
 * (Todo 4). `ProcessResult` is consumed by the Todo 3 parser; the typed
 * errors below are the only failure surface Todo 5 needs to handle.
 */

export type ProcessExit = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
};

export interface ProcessResult extends ProcessExit {
  readonly pid: number;
  readonly stdoutChunks: readonly string[];
  readonly stdoutBytes: number;
  readonly stderr: string;
  readonly stderrBytes: number;
}

export type ProcessErrorKind = "spawn-failed" | "timeout" | "aborted" | "stdout-overflow" | "stderr-overflow";

export class ProcessError extends Error {
  readonly kind: ProcessErrorKind;
  readonly pid: number | null;
  readonly exit: ProcessExit | null;
  readonly capturedBytes: number | null;
  constructor(
    kind: ProcessErrorKind,
    message: string,
    details?: { readonly pid?: number; readonly exit?: ProcessExit; readonly capturedBytes?: number },
  ) {
    super(message);
    this.name = "ProcessError";
    this.kind = kind;
    this.pid = details?.pid ?? null;
    this.exit = details?.exit ?? null;
    this.capturedBytes = details?.capturedBytes ?? null;
  }
}

export type ResolveErrorKind = "empty-path" | "not-found" | "not-executable";

export class ResolveError extends Error {
  readonly kind: ResolveErrorKind;
  readonly attemptedPath: string | null;
  constructor(kind: ResolveErrorKind, message: string, attemptedPath: string | null = null) {
    super(message);
    this.name = "ResolveError";
    this.kind = kind;
    this.attemptedPath = attemptedPath;
  }
}

export const DEFAULT_TERMINATE_GRACE_MS = 2_000;
export const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

/**
 * Host watchdog margin over the agy CLI `--print-timeout`: Todo 5 should pass
 * `hostTimeoutMs = timeoutSeconds * 1000 + HOST_GRACE_MS` so the CLI's own
 * timeout error surfaces as a real result instead of being preempted by the
 * host timer; the host timer only backstops hangs the CLI fails to enforce.
 */
export const HOST_GRACE_MS = 5_000;
