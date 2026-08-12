import { describe, expect, test } from "bun:test";
import { ArgsError, buildArgv, DEFAULT_MODE, DEFAULT_TIMEOUT_SECONDS, type ArgsErrorKind } from "../src/args";

const BASE = ["-p", "summarize the design", "--output-format", "stream-json"];

function captureError(fn: () => readonly string[]): ArgsError | null {
  try {
    fn();
  } catch (error) {
    if (error instanceof ArgsError) {
      return error;
    }
    return null;
  }
  return null;
}

function expectKind(fn: () => readonly string[], kind: ArgsErrorKind): void {
  const error = captureError(fn);
  expect(error).not.toBeNull();
  if (error !== null) {
    expect(error.kind).toBe(kind);
  }
}

describe("buildArgv defaults and mode mapping", () => {
  test("defaults: mode execute and timeoutSeconds 300 with exact deterministic argv", () => {
    expect(buildArgv({ task: "summarize the design" })).toEqual([
      ...BASE,
      "--print-timeout",
      "300s",
      "--mode",
      "accept-edits",
    ]);
  });

  test("DEFAULT_MODE is execute and DEFAULT_TIMEOUT_SECONDS is 300", () => {
    expect(DEFAULT_MODE).toBe("execute");
    expect(DEFAULT_TIMEOUT_SECONDS).toBe(300);
  });

  test("explicit mode execute maps to accept-edits; plan maps to plan", () => {
    expect(buildArgv({ task: "t", mode: "execute" })).toEqual(["-p", "t", "--output-format", "stream-json", "--print-timeout", "300s", "--mode", "accept-edits"]);
    expect(buildArgv({ task: "t", mode: "plan" })).toEqual(["-p", "t", "--output-format", "stream-json", "--print-timeout", "300s", "--mode", "plan"]);
  });

  test("timeoutSeconds is formatted as the Go duration ${n}s", () => {
    const argv = buildArgv({ task: "t", timeoutSeconds: 45 });
    expect(argv[4]).toBe("--print-timeout");
    expect(argv[5]).toBe("45s");
  });
});

describe("buildArgv optional flags", () => {
  test("all options: model, conversation and sandbox appended in deterministic order", () => {
    expect(
      buildArgv({
        task: "t",
        mode: "plan",
        timeoutSeconds: 30,
        model: "gemini-3.5-flash-medium",
        conversationId: "055a398f-db14-4c5f-abbb-1bf03f8120a7",
        sandbox: true,
      }),
    ).toEqual([
      "-p",
      "t",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "30s",
      "--mode",
      "plan",
      "--model",
      "gemini-3.5-flash-medium",
      "--conversation",
      "055a398f-db14-4c5f-abbb-1bf03f8120a7",
      "--sandbox",
    ]);
  });

  test("continueConversation appends the --continue flag without a value", () => {
    expect(buildArgv({ task: "summarize the design", continueConversation: true })).toEqual([...BASE, "--print-timeout", "300s", "--mode", "accept-edits", "--continue"]);
  });

  test("sandbox true appends --sandbox; false or omitted does not", () => {
    expect(buildArgv({ task: "t", sandbox: true })).toContain("--sandbox");
    expect(buildArgv({ task: "t", sandbox: false })).not.toContain("--sandbox");
    expect(buildArgv({ task: "t" })).not.toContain("--sandbox");
  });
});

describe("buildArgv typed rejections", () => {
  test("conversationId and continueConversation together are rejected before spawn", () => {
    expectKind(() => buildArgv({ task: "t", conversationId: "c1", continueConversation: true }), "conversation-conflict");
  });

  test("empty and whitespace-only tasks are rejected as empty-task", () => {
    expectKind(() => buildArgv({ task: "" }), "empty-task");
    expectKind(() => buildArgv({ task: "   " }), "empty-task");
  });

  test("rejections are instances of the exported ArgsError class", () => {
    expect(captureError(() => buildArgv({ task: "" }))).toBeInstanceOf(ArgsError);
  });

  test("nonsensical timeouts are rejected: zero, negative, fractional, NaN", () => {
    for (const bad of [0, -5, 2.5, Number.NaN]) {
      expectKind(() => buildArgv({ task: "t", timeoutSeconds: bad }), "invalid-timeout");
    }
  });
});

describe("buildArgv shell safety", () => {
  test("shell metacharacters in the task stay one argv element, never shell-split", () => {
    const task = 'a; rm -rf / && echo pwned $(id) `ls` "quoted" \'sq\' | cat > /tmp/x &';
    const argv = buildArgv({ task });
    expect(argv).toHaveLength(8);
    expect(argv[1]).toBe(task);
    expect(argv.join("\u0000")).toContain("; rm -rf / && echo pwned");
  });

  test("model and conversation values with metacharacters remain single elements", () => {
    const model = 'gemini "x"; --mode plan';
    const conversationId = "c$(id)";
    const argv = buildArgv({ task: "t", model, conversationId });
    expect(argv).toContain(model);
    expect(argv).toContain(conversationId);
    expect(argv).toHaveLength(12);
  });

  test("whitespace inside the task is preserved verbatim", () => {
    expect(buildArgv({ task: "  a  b  " })[1]).toBe("  a  b  ");
  });
});
