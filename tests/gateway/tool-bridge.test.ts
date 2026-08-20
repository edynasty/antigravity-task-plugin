import { describe, expect, test } from "bun:test";
import { remapPath, translateToolCall } from "../../src/gateway/tool-bridge";

describe("translateToolCall", () => {
  test("run_command maps to bash with the command parameter", () => {
    const translated = translateToolCall("run_command", JSON.stringify({ CommandLine: "wc -m README.md" }), null);
    expect(translated).toEqual({ name: "bash", arguments: JSON.stringify({ command: "wc -m README.md" }) });
  });

  test("run_command_with_output also maps to bash", () => {
    const translated = translateToolCall("run_command_with_output", JSON.stringify({ command: "ls -la" }), null);
    expect(translated).not.toBeNull();
    expect(translated?.name).toBe("bash");
  });

  test("view_file maps to read with the file path", () => {
    const translated = translateToolCall("view_file", JSON.stringify({ FilePath: "/workspace/README.md" }), null);
    expect(translated).toEqual({ name: "read", arguments: JSON.stringify({ filePath: "/workspace/README.md" }) });
  });

  test("container /workspace paths are rewritten to the host path", () => {
    const translated = translateToolCall(
      "view_file",
      JSON.stringify({ FilePath: "/workspace/src/gateway/chat.ts" }),
      "/Users/tangxingpeng/IdeaProjects/me/antigravity-task-plugin",
    );
    expect(translated).toEqual({
      name: "read",
      arguments: JSON.stringify({ filePath: "/Users/tangxingpeng/IdeaProjects/me/antigravity-task-plugin/src/gateway/chat.ts" }),
    });
  });

  test("unknown tools are not bridged", () => {
    expect(translateToolCall("write_file", JSON.stringify({ FilePath: "/workspace/x" }), null)).toBeNull();
  });

  test("malformed json is not bridged", () => {
    expect(translateToolCall("run_command", "{not json", null)).toBeNull();
  });

  test("missing required parameters are not bridged", () => {
    expect(translateToolCall("run_command", JSON.stringify({ other: 1 }), null)).toBeNull();
  });
});

describe("remapPath", () => {
  test("/workspace itself maps to the host path", () => {
    expect(remapPath("/workspace", "/host/project")).toBe("/host/project");
  });

  test("/workspace/... prefixes are replaced", () => {
    expect(remapPath("/workspace/a/b.txt", "/host/project")).toBe("/host/project/a/b.txt");
  });

  test("host or relative paths are untouched", () => {
    expect(remapPath("/Users/x/proj/README.md", "/host/project")).toBe("/Users/x/proj/README.md");
    expect(remapPath("README.md", "/host/project")).toBe("README.md");
  });

  test("null host path leaves the value untouched", () => {
    expect(remapPath("/workspace/README.md", null)).toBe("/workspace/README.md");
  });
});