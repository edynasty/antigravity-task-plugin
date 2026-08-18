/**
 * Gateway serial queue (Todo 13): at most one agy task runs at a time; waiting
 * jobs are FIFO; an aborted waiting job is removed without being started.
 */
import { describe, expect, test } from "bun:test";
import { QueueAbortError, QueueFullError, SerialQueue } from "../../src/gateway/queue";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function gateDeferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  const gate = deferred<void>();
  return { promise: gate.promise, release: () => gate.resolve(undefined) };
}

function controllableJob(name: string, started: string[], order: string[], gate: { readonly promise: Promise<void>; readonly release: () => void }) {
  return async (signal: AbortSignal): Promise<string> => {
    started.push(name);
    await gate.promise;
    if (signal.aborted) {
      throw new QueueAbortError(`aborted before running: ${name}`);
    }
    order.push(name);
    return name;
  };
}

describe("SerialQueue", () => {
  test("at most one job runs at a time; the second waits for the first", async () => {
    const queue = new SerialQueue(8);
    const started: string[] = [];
    const order: string[] = [];
    const gate = gateDeferred();

    const first = queue.push({ run: controllableJob("first", started, order, gate), signal: new AbortController().signal });
    const second = queue.push({ run: controllableJob("second", started, order, gate), signal: new AbortController().signal });

    expect(started).toEqual(["first"]);
    expect(queue.pendingCount).toBe(1);

    gate.release();
    await first;
    expect(order).toEqual(["first"]);
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  test("max queue length is enforced: maxLength waiting jobs then QueueFullError", async () => {
    const queue = new SerialQueue(2);
    const gate = gateDeferred();
    const first = queue.push({ run: controllableJob("first", [], [], gate), signal: new AbortController().signal });
    const second = queue.push({ run: controllableJob("second", [], [], gate), signal: new AbortController().signal });
    const third = queue.push({ run: controllableJob("third", [], [], gate), signal: new AbortController().signal });
    expect(queue.pendingCount).toBe(2);
    expect(() => queue.push({ run: controllableJob("fourth", [], [], gate), signal: new AbortController().signal })).toThrow(QueueFullError);
    gate.release();
    await first;
    await second;
    await third;
  });

  test("aborting a waiting job removes it from the queue and rejects with QueueAbortError", async () => {
    const queue = new SerialQueue(8);
    const started: string[] = [];
    const order: string[] = [];
    const gate = gateDeferred();

    const first = queue.push({ run: controllableJob("first", started, order, gate), signal: new AbortController().signal });
    const controller = new AbortController();
    const aborted = queue.push({ run: controllableJob("doomed", started, order, gate), signal: controller.signal });
    expect(queue.pendingCount).toBe(1);

    controller.abort();
    expect(aborted).rejects.toBeInstanceOf(QueueAbortError);
    expect(queue.pendingCount).toBe(0);

    const third = queue.push({ run: controllableJob("third", started, order, gate), signal: new AbortController().signal });
    expect(queue.pendingCount).toBe(1);
    gate.release();
    await first;
    await third;
    expect(started).toEqual(["first", "third"]);
  });

  test("an already-aborted signal rejects the waiting job immediately", async () => {
    const queue = new SerialQueue(8);
    const started: string[] = [];
    const order: string[] = [];
    const gate = gateDeferred();
    const first = queue.push({ run: controllableJob("first", started, order, gate), signal: new AbortController().signal });

    const controller = new AbortController();
    controller.abort();
    const doomed = queue.push({ run: controllableJob("doomed", started, order, gate), signal: controller.signal });
    expect(doomed).rejects.toBeInstanceOf(QueueAbortError);
    expect(queue.pendingCount).toBe(0);

    gate.release();
    await first;
    expect(started).toEqual(["first"]);
  });

  test("a run rejection propagates and the queue continues with the next job", async () => {
    const queue = new SerialQueue(8);
    const boom = queue.push({
      run: async () => {
        throw new Error("upstream exploded");
      },
      signal: new AbortController().signal,
    });
    expect(boom).rejects.toThrow("upstream exploded");

    const ok = queue.push({ run: async () => "ok", signal: new AbortController().signal });
    expect(ok).resolves.toBe("ok");
  });

  test("a throwing run is isolated: one bad job never blocks the queue", async () => {
    const queue = new SerialQueue(8);
    const order: string[] = [];
    const bad = queue.push({
      run: async () => {
        order.push("bad");
        throw new Error("boom");
      },
      signal: new AbortController().signal,
    });
    expect(bad).rejects.toThrow("boom");
    const good = queue.push({ run: async () => "good", signal: new AbortController().signal });
    expect(good).resolves.toBe("good");
    expect(order).toEqual(["bad"]);
  });
});
