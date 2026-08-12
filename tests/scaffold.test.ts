import { describe, expect, test } from "bun:test";
import {
  FIXTURE_PATH,
  isRecord,
  makeTempCwd,
  parseStream,
  requireResult,
  runFake,
  withTimeout,
} from "./helpers/fake-agy-harness";

describe("fake agy contract fixtures", () => {
  test("success: init, step_update and SUCCESS result with usage; exit 0; clean stderr", async () => {
    const { stdout, stderr, exitCode } = await runFake("success", await makeTempCwd());
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const events = parseStream(stdout);
    expect(events.map((event) => event["event"])).toEqual(["init", "step_update", "result"]);
    const init = events[0];
    expect(isRecord(init?.["init"])).toBe(true);
    const step = events[1];
    expect(isRecord(step?.["step_update"])).toBe(true);
    const result = requireResult(events[events.length - 1]?.["result"]);
    expect(result.status).toBe("SUCCESS");
    expect(result.response.length).toBeGreaterThan(0);
    expect(result.conversation_id.length).toBeGreaterThan(0);
    expect(result.usage.total_tokens).toBeGreaterThan(0);
  });

  test("error: ERROR result with error field and nonzero exit", async () => {
    const { stdout, exitCode } = await runFake("error", await makeTempCwd());
    expect(exitCode).not.toBe(0);
    const events = parseStream(stdout);
    expect(events.map((event) => event["event"])).toEqual(["init", "result"]);
    const result = requireResult(events[events.length - 1]?.["result"]);
    expect(result.status).toBe("ERROR");
    expect(result.error?.length).toBeGreaterThan(0);
    expect(result.usage.total_tokens).toBe(0);
  });

  test("empty: SUCCESS result with empty response; exit 0", async () => {
    const { stdout, exitCode } = await runFake("empty", await makeTempCwd());
    expect(exitCode).toBe(0);
    const events = parseStream(stdout);
    expect(events.map((event) => event["event"])).toEqual(["init", "result"]);
    const result = requireResult(events[events.length - 1]?.["result"]);
    expect(result.status).toBe("SUCCESS");
    expect(result.response).toBe("");
  });

  test("tail: final result JSON without trailing newline; exit 0", async () => {
    const { stdout, exitCode } = await runFake("tail", await makeTempCwd());
    expect(exitCode).toBe(0);
    const events = parseStream(stdout);
    expect(events.map((event) => event["event"])).toEqual(["init", "step_update", "result"]);
    const result = requireResult(events[events.length - 1]?.["result"]);
    expect(result.status).toBe("SUCCESS");
    expect(stdout.endsWith("\n")).toBe(false);
  });

  test("hang: emits init, stays alive, exits 143 on SIGTERM", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, FIXTURE_PATH],
      cwd: await makeTempCwd(),
      env: { ...process.env, AGY_FAKE_SCENARIO: "hang" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const initPromise = (async () => {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        try {
          let sawInit = false;
          while (!sawInit) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }
            sawInit = decoder.decode(value, { stream: true }).includes('"event":"init"');
          }
          return sawInit;
        } finally {
          reader.releaseLock();
        }
      })();
      const sawInit = await withTimeout(initPromise, 8_000, "hang scenario never emitted its init event");
      expect(sawInit).toBe(true);

      proc.kill("SIGTERM");
      const exitCode = await withTimeout(proc.exited, 8_000, "hang scenario did not exit after SIGTERM within 8s");
      expect(exitCode).toBe(143);
    } finally {
      if (proc.exitCode === null) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }
  });

  test("unsupported scenario fails clearly: exit 2, empty stdout, diagnostic on stderr", async () => {
    const { stdout, stderr, exitCode } = await runFake("bogus", await makeTempCwd());
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/unknown scenario "bogus"/);
  });
});
