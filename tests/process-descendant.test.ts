import { describe, expect, test } from "bun:test";
import { runAgy } from "../src/process";
import {
  assertProcessGone,
  expectProcessErrorKind,
  killProcess,
  makeCountingSignal,
  makeSpawnOptions,
  readPidFile,
} from "./helpers/process-harness";

describe("runAgy with a descendant holding the pipes", () => {
  test("timeout settles bounded with exit null/null even though close never fires", async () => {
    const counting = makeCountingSignal();
    const { options, pidPath, childPidPath } = await makeSpawnOptions({
      scenario: "pipe-hold",
      signal: counting.signal,
      hostTimeoutMs: 1200,
      terminateGraceMs: 300,
      closeWatchMs: 300,
      childPidName: "desc.pid",
    });
    expect(childPidPath).not.toBeNull();
    if (childPidPath === null) {
      return;
    }
    const promise = runAgy(options);
    const settlement = expectProcessErrorKind(promise, "timeout", { exitCode: null, signal: null });
    const pid = await readPidFile(pidPath);
    const descendantPid = await readPidFile(childPidPath);
    const started = Date.now();
    try {
      await settlement;
    } finally {
      killProcess(descendantPid);
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2_500);
    expect(counting.added).toBe(1);
    expect(counting.removed).toBe(1);
    await assertProcessGone(pid);
    await assertProcessGone(descendantPid);
  });

  test("abort settles bounded with exit null/null; descendant cleanup is harness-owned", async () => {
    const controller = new AbortController();
    const { options, pidPath, childPidPath } = await makeSpawnOptions({
      scenario: "pipe-hold",
      signal: controller.signal,
      hostTimeoutMs: 5_000,
      terminateGraceMs: 300,
      closeWatchMs: 300,
      childPidName: "desc.pid",
    });
    expect(childPidPath).not.toBeNull();
    if (childPidPath === null) {
      return;
    }
    const promise = runAgy(options);
    const settlement = expectProcessErrorKind(promise, "aborted", { exitCode: null, signal: null });
    const pid = await readPidFile(pidPath);
    const descendantPid = await readPidFile(childPidPath);
    controller.abort();
    const started = Date.now();
    try {
      await settlement;
    } finally {
      killProcess(descendantPid);
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2_500);
    await assertProcessGone(pid);
    await assertProcessGone(descendantPid);
  });
});
