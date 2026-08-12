import { describe, expect, test } from "bun:test";
import { ProcessError } from "../src/process-types";
import type { ProcessExit } from "../src/process-types";
import { DIAGNOSTIC_TRUNCATION_SUFFIX, MAX_DIAGNOSTIC_CHARS } from "../src/runner-types";
import type { RunnerFailureKind } from "../src/runner-types";
import { runAntigravityTask } from "../src/runner";
import {
  initLine,
  makeFakeDeps,
  processResult,
  resultLine,
  runContext,
} from "./helpers/runner-harness";

describe("runAntigravityTask diagnostic redaction and bounding", () => {
  test("oversized ProcessError messages are redacted and bounded without losing kind or exit", async () => {
    const fakeCwd = "/private/var/folders/qa/secret-workspace/project";
    const secretKey = "sk-1234567890abcdefghijklmn";
    const secretBearer = "Bearer abcdefghij123456";
    const secretToken = "token=supersecret123";
    const secretApiKey = "api_key=abc12345xyz";
    const cases: readonly { readonly error: ProcessError; readonly kind: RunnerFailureKind; readonly exit: ProcessExit | null }[] = [
      {
        error: new ProcessError(
          "spawn-failed",
          `failed to spawn agy: ENOENT spawn ${fakeCwd}/agy ENOENT (cwd: ${fakeCwd}) ${secretKey} ${secretBearer} ${secretToken} ${secretApiKey} ${"z".repeat(MAX_DIAGNOSTIC_CHARS * 2)}`,
        ),
        kind: "spawn-failed",
        exit: null,
      },
      {
        error: new ProcessError(
          "timeout",
          `agy run from ${fakeCwd} exceeded the host timeout ${secretKey} ${secretBearer} ${secretToken} ${secretApiKey} ${"z".repeat(MAX_DIAGNOSTIC_CHARS * 2)}`,
          { pid: 9, exit: { exitCode: null, signal: "SIGKILL" } },
        ),
        kind: "timeout",
        exit: { exitCode: null, signal: "SIGKILL" },
      },
    ];
    for (const entry of cases) {
      const fake = makeFakeDeps();
      fake.failRun(entry.error);
      const { ctx } = runContext(fakeCwd);
      const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

      expect(payload.metadata.ok).toBe(false);
      if (!payload.metadata.ok) {
        expect(payload.metadata.kind).toBe(entry.kind);
        expect(payload.metadata.exit).toEqual(entry.exit);
        for (const secret of [secretKey, secretBearer, secretToken, secretApiKey, fakeCwd]) {
          expect(payload.output).not.toContain(secret);
          expect(payload.metadata.message).not.toContain(secret);
        }
        expect(payload.metadata.message).toContain("[REDACTED]");
        expect(payload.metadata.message.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS + DIAGNOSTIC_TRUNCATION_SUFFIX.length);
      }
    }
  });

  test("stderr is redacted and bounded so secrets never reach output or metadata", async () => {
    const secretKey = "sk-1234567890abcdefghijklmn";
    const secretBearer = "Bearer abcdefghij123456";
    const longStderr = `${secretKey} leaked\n${secretBearer} leaked\n${"x".repeat(MAX_DIAGNOSTIC_CHARS * 2)}`;
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: `${initLine()}\n${resultLine("SUCCESS", "ok")}\n`, stderr: longStderr }));
    const { ctx } = runContext();
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.output).not.toContain(secretKey);
    expect(payload.output).not.toContain(secretBearer);
    expect(payload.title).not.toContain(secretKey);
    const redacted = payload.metadata.stderr;
    expect(redacted).not.toContain(secretKey);
    expect(redacted).not.toContain(secretBearer);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS + DIAGNOSTIC_TRUNCATION_SUFFIX.length);
  });

  test("status error detail is redacted in the failure message", async () => {
    const secret = "sk-1234567890abcdefghijklmn";
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: `${initLine()}\n${resultLine("ERROR", "", { error: `failure: ${secret}` })}\n`, exitCode: 1 }));
    const { ctx } = runContext();
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    if (!payload.metadata.ok) {
      expect(payload.metadata.kind).toBe("status");
      expect(payload.output).not.toContain(secret);
      expect(payload.metadata.message).toContain("[REDACTED]");
    }
  });

  test("a 5000+ char status error detail with fake cwd is bounded and redacted", async () => {
    const fakeCwd = "/private/fake/cwd/project";
    const secret = "sk-1234567890abcdefghijklmn";
    const detail = `${fakeCwd}/src/fail.ts:1 ${secret} ${"q".repeat(MAX_DIAGNOSTIC_CHARS * 2)}`;
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: `${initLine()}\n${resultLine("ERROR", "", { error: detail })}\n`, exitCode: 1 }));
    const { ctx } = runContext(fakeCwd);
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(false);
    if (!payload.metadata.ok) {
      expect(payload.metadata.kind).toBe("status");
      const prefix = "agy finished with status ERROR: ";
      expect(payload.output).not.toContain(fakeCwd);
      expect(payload.output).not.toContain(secret);
      expect(payload.metadata.message).not.toContain(fakeCwd);
      expect(payload.metadata.message).not.toContain(secret);
      expect(payload.metadata.message).toContain("[REDACTED]");
      expect(payload.metadata.message.length).toBeLessThan(detail.length);
      expect(payload.metadata.message.length).toBeLessThanOrEqual(
        prefix.length + MAX_DIAGNOSTIC_CHARS + DIAGNOSTIC_TRUNCATION_SUFFIX.length,
      );
    }
  });

  test("malformed-line diagnostic context with fake cwd and secrets is sanitized in metadata", async () => {
    const fakeCwd = "/private/fake/cwd/project";
    const secret = "sk-1234567890abcdefghijklmn";
    const malformedLine = `noise ${fakeCwd}/file.ts ${secret} garbage`;
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: `${malformedLine}\n${initLine()}\n${resultLine("SUCCESS", "ok")}\n` }));
    const { ctx } = runContext(fakeCwd);
    const payload = await runAntigravityTask({ task: "t" }, ctx, fake.deps);

    expect(payload.metadata.ok).toBe(true);
    const context = payload.metadata.diagnostics.find((entry) => entry.kind === "malformed-line");
    expect(context, "a malformed-line diagnostic must be surfaced").toBeDefined();
    if (context?.kind === "malformed-line") {
      expect(context.lineNumber).toBe(1);
      expect(context.context).not.toContain(fakeCwd);
      expect(context.context).not.toContain(secret);
      expect(context.context).toContain("[REDACTED]");
    }
  });
});
