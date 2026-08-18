/**
 * Global serial queue (ban-avoidance): at most ONE agy task runs at a time.
 * Waiting jobs are FIFO; a waiting job whose signal aborts (client disconnect)
 * is removed without ever starting; an abort after start is the run's own
 * concern (runAgy terminates the child). A throwing run is isolated — it never
 * blocks the next job.
 */

export class QueueFullError extends Error {
  constructor(message = "queue full") {
    super(message);
    this.name = "QueueFullError";
  }
}

export class QueueAbortError extends Error {
  constructor(message = "queued job aborted before it started") {
    super(message);
    this.name = "QueueAbortError";
  }
}

export interface QueuedJob<T> {
  readonly run: (signal: AbortSignal) => Promise<T>;
  readonly signal: AbortSignal;
}

interface Waiter<T> {
  readonly job: QueuedJob<T>;
  readonly signal: AbortSignal;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}

export class SerialQueue {
  readonly maxLength: number;
  private readonly waiting: Waiter<unknown>[] = [];
  private running = false;

  constructor(maxLength: number) {
    if (!Number.isInteger(maxLength) || maxLength < 1) {
      throw new Error(`SerialQueue maxLength must be a positive integer, got ${String(maxLength)}`);
    }
    this.maxLength = maxLength;
  }

  get pendingCount(): number {
    return this.waiting.length;
  }

  push<T>(job: QueuedJob<T>): Promise<T> {
    if (this.waiting.length >= this.maxLength) {
      throw new QueueFullError();
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index === -1) {
          return;
        }
        this.waiting.splice(index, 1);
        waiter.signal.removeEventListener("abort", onAbort);
        reject(new QueueAbortError());
      };
      const waiter: Waiter<unknown> = {
        job: job as QueuedJob<unknown>,
        signal: job.signal,
        resolve: resolve as (value: unknown) => void,
        reject,
        onAbort,
      };
      if (job.signal.aborted) {
        reject(new QueueAbortError());
        return;
      }
      job.signal.addEventListener("abort", onAbort);
      this.waiting.push(waiter);
      this.pump();
    });
  }

  private pump(): void {
    if (this.running) {
      return;
    }
    const waiter = this.waiting.shift();
    if (waiter === undefined) {
      return;
    }
    this.running = true;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.job.run(waiter.signal).then(
      (value) => {
        this.running = false;
        waiter.resolve(value);
        this.pump();
      },
      (error) => {
        this.running = false;
        waiter.reject(error);
        this.pump();
      },
    );
  }
}
