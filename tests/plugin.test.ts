import { describe, expect, test } from "bun:test";
import { AntigravityTaskPlugin, antigravityTaskSchema, createAntigravityTaskPlugin, createAntigravityTaskTool, toInteriorArgs } from "../src/index";
import AntigravityTaskPluginDefault from "../src/index";
import type { AntigravityTaskArgs } from "../src/runner-types";
import {
  CONVERSATION_ID,
  RESULT_USAGE,
  initLine,
  isToolPayload,
  makeFakeDeps,
  mockToolContext,
  processResult,
  resultLine,
  successStream,
} from "./helpers/runner-harness";

describe("antigravity-task plugin", () => {
  test("registers exactly one tool under the exact id antigravity-task", async () => {
    const fake = makeFakeDeps();
    const hooks = await createAntigravityTaskPlugin(fake.deps)();
    expect(Object.keys(hooks.tool ?? {})).toEqual(["antigravity-task"]);
  });

  test("schema defaults, bounds and types are enforced by the actual tool schema", () => {
    const schema = antigravityTaskSchema;

    const defaults = schema.parse({ task: "fix bug" });
    expect(defaults.timeoutSeconds).toBe(300);
    expect(defaults.mode).toBe("execute");

    expect(schema.parse({ task: "t", timeoutSeconds: 10 }).timeoutSeconds).toBe(10);
    expect(schema.parse({ task: "t", timeoutSeconds: 900 }).timeoutSeconds).toBe(900);
    expect(() => schema.parse({ task: "t", timeoutSeconds: 9 })).toThrow();
    expect(() => schema.parse({ task: "t", timeoutSeconds: 901 })).toThrow();
    expect(() => schema.parse({ task: "t", timeoutSeconds: 1.5 })).toThrow();
    expect(() => schema.parse({ task: "" })).toThrow();
    expect(() => schema.parse({ task: "   " })).toThrow();
    expect(() => schema.parse({})).toThrow();
    expect(() => schema.parse({ task: "t", mode: "bogus" })).toThrow();
    expect(schema.parse({ task: "t", mode: "plan" }).mode).toBe("plan");

    const full = schema.parse({ task: "t", model: "m", continueConversation: false, conversationId: "c", sandbox: true });
    expect(full.model).toBe("m");
    expect(full.continueConversation).toBe(false);
    expect(full.conversationId).toBe("c");
    expect(full.sandbox).toBe(true);
  });

  test("parsed schema args normalize into the runner contract with defaults applied", () => {
    const args: AntigravityTaskArgs = toInteriorArgs(antigravityTaskSchema.parse({ task: "probe" }));
    expect(args).toEqual({ task: "probe", timeoutSeconds: 300, mode: "execute" });
  });

  test("execute success returns exact output and execute-mode risk note", async () => {
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: successStream("final answer.") }));
    const result = await createAntigravityTaskTool(fake.deps).execute({ task: "do it" }, mockToolContext());

    expect(isToolPayload(result)).toBe(true);
    if (!isToolPayload(result)) {
      return;
    }
    expect(result.title).toBe("antigravity-task: SUCCESS (unknown) — do it");
    expect(result.output).toContain("final answer.");
    expect(result.output).toContain("antigravity-task execution details");
    expect(result.metadata.ok).toBe(true);
    if (result.metadata.ok) {
      expect(result.metadata.conversationId).toBe(CONVERSATION_ID);
      expect(result.metadata.usage).toEqual(RESULT_USAGE);
      expect(result.metadata.provenance).toMatch(/execute mode may modify files in the current workspace/);
    }
  });

  test("plan-mode provenance does not falsely promise filesystem protection", async () => {
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: successStream("plan text.") }));
    const result = await createAntigravityTaskTool(fake.deps).execute({ task: "plan it", mode: "plan" }, mockToolContext());

    expect(isToolPayload(result)).toBe(true);
    if (!isToolPayload(result) || !result.metadata.ok) {
      return;
    }
    expect(result.metadata.provenance).toMatch(/plan mode requests planning without applying edits/);
    expect(result.metadata.provenance).toMatch(/does not guarantee filesystem immutability/);
  });

  test("sandbox provenance restricts only terminal/shell access", async () => {
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: successStream("ok.") }));
    const result = await createAntigravityTaskTool(fake.deps).execute({ task: "t", sandbox: true }, mockToolContext());

    expect(isToolPayload(result)).toBe(true);
    if (!isToolPayload(result) || !result.metadata.ok) {
      return;
    }
    expect(result.metadata.provenance).toMatch(/sandbox restricts only terminal\/shell access/);
  });

  test("execute ERROR maps to a diagnostic ToolResult with typed metadata", async () => {
    const fake = makeFakeDeps();
    fake.setRunResult(processResult({ stdout: `${initLine()}\n${resultLine("ERROR", "", { error: "boom" })}\n`, exitCode: 1 }));
    const result = await createAntigravityTaskTool(fake.deps).execute({ task: "t" }, mockToolContext());

    expect(isToolPayload(result)).toBe(true);
    if (!isToolPayload(result)) {
      return;
    }
    expect(result.title).toBe("antigravity-task: status (unknown) — t");
    expect(result.metadata.ok).toBe(false);
    if (!result.metadata.ok) {
      expect(result.metadata.kind).toBe("status");
      expect(result.metadata.status).toBe("ERROR");
      expect(result.output).toMatch(/status ERROR/);
    }
  });

  test("conflicting conversation options fail without spawning a process", async () => {
    const fake = makeFakeDeps();
    const result = await createAntigravityTaskTool(fake.deps).execute(
      { task: "t", conversationId: "c", continueConversation: true },
      mockToolContext(),
    );

    expect(isToolPayload(result)).toBe(true);
    if (!isToolPayload(result)) {
      return;
    }
    expect(result.metadata.ok).toBe(false);
    if (!result.metadata.ok) {
      expect(result.metadata.kind).toBe("conversation-conflict");
    }
    expect(fake.resolveCalls).toBe(0);
    expect(fake.runCalls.length).toBe(0);
  });

  test("cwd and abort come from the ToolContext", async () => {
    const fake = makeFakeDeps();
    const controller = new AbortController();
    fake.setRunResult(processResult({ stdout: successStream("ok.") }));
    await createAntigravityTaskTool(fake.deps).execute({ task: "t" }, mockToolContext("/work/session", controller.signal));

    expect(fake.runCalls[0]?.cwd).toBe("/work/session");
    expect(fake.runCalls[0]?.signal).toBe(controller.signal);
  });

  test("named, default and factory exports are functions registering one tool", async () => {
    expect(typeof AntigravityTaskPlugin).toBe("function");
    expect(typeof AntigravityTaskPluginDefault).toBe("function");
    expect(AntigravityTaskPluginDefault).toBe(AntigravityTaskPlugin);

    const namedHooks = await AntigravityTaskPlugin();
    expect(Object.keys(namedHooks.tool ?? {})).toEqual(["antigravity-task"]);
    const defaultHooks = await AntigravityTaskPluginDefault();
    expect(Object.keys(defaultHooks.tool ?? {})).toEqual(["antigravity-task"]);
  });
});
