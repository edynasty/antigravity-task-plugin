import { describe, expect, test } from "bun:test";
import { remapPath, translateToolCall } from "../../src/gateway/tool-bridge";

const NO_MOUNTS = [] as const;

describe("translateToolCall", () => {
  test("run_command maps to bash with the command parameter", () => {
    const translated = translateToolCall("run_command", JSON.stringify({ CommandLine: "wc -m README.md" }), NO_MOUNTS);
    expect(translated).toEqual({ name: "bash", arguments: JSON.stringify({ command: "wc -m README.md" }) });
  });

  test("run_command_with_output also maps to bash", () => {
    const translated = translateToolCall("run_command_with_output", JSON.stringify({ command: "ls -la" }), NO_MOUNTS);
    expect(translated).not.toBeNull();
    expect(translated?.name).toBe("bash");
  });

  test("view_file maps to read with the file path", () => {
    const translated = translateToolCall("view_file", JSON.stringify({ FilePath: "/workspace/README.md" }), NO_MOUNTS);
    expect(translated).toEqual({ name: "read", arguments: JSON.stringify({ filePath: "/workspace/README.md" }) });
  });

  test("container /workspace paths are rewritten to the host path", () => {
    const mounts = [{ hostPath: "/Users/tangxingpeng/IdeaProjects/me/antigravity-task-plugin", containerPath: "/workspace" }];
    const translated = translateToolCall(
      "view_file",
      JSON.stringify({ FilePath: "/workspace/src/gateway/chat.ts" }),
      mounts,
    );
    expect(translated).toEqual({
      name: "read",
      arguments: JSON.stringify({ filePath: "/Users/tangxingpeng/IdeaProjects/me/antigravity-task-plugin/src/gateway/chat.ts" }),
    });
  });

  test("longest containerPath wins with multiple mounts", () => {
    const mounts = [
      { hostPath: "/Users/tangxingpeng/IdeaProjects/me/antigravity-task-plugin", containerPath: "/workspace" },
      { hostPath: "/Users/tangxingpeng/IdeaProjects/other-project", containerPath: "/workspace/other" },
    ];
    const translated = translateToolCall(
      "view_file",
      JSON.stringify({ FilePath: "/workspace/other/src/main.ts" }),
      mounts,
    );
    expect(translated).toEqual({
      name: "read",
      arguments: JSON.stringify({ filePath: "/Users/tangxingpeng/IdeaProjects/other-project/src/main.ts" }),
    });
  });

  test("unknown tools are not bridged", () => {
    expect(translateToolCall("write_file", JSON.stringify({ FilePath: "/workspace/x" }), NO_MOUNTS)).toBeNull();
  });

  test("malformed json is not bridged", () => {
    expect(translateToolCall("run_command", "{not json", NO_MOUNTS)).toBeNull();
  });

  test("missing required parameters are not bridged", () => {
    expect(translateToolCall("run_command", JSON.stringify({ other: 1 }), NO_MOUNTS)).toBeNull();
  });
});

describe("remapPath", () => {
  test("/workspace itself maps to the host path", () => {
    const mounts = [{ hostPath: "/host/project", containerPath: "/workspace" }];
    expect(remapPath("/workspace", mounts)).toBe("/host/project");
  });

  test("/workspace/... prefixes are replaced", () => {
    const mounts = [{ hostPath: "/host/project", containerPath: "/workspace" }];
    expect(remapPath("/workspace/a/b.txt", mounts)).toBe("/host/project/a/b.txt");
  });

  test("host or relative paths are untouched", () => {
    const mounts = [{ hostPath: "/host/project", containerPath: "/workspace" }];
    expect(remapPath("/Users/x/proj/README.md", mounts)).toBe("/Users/x/proj/README.md");
    expect(remapPath("README.md", mounts)).toBe("README.md");
  });

  test("no mounts leaves the value untouched", () => {
    expect(remapPath("/workspace/README.md", NO_MOUNTS)).toBe("/workspace/README.md");
  });

  test("longest containerPath wins with multiple mounts", () => {
    const mounts = [
      { hostPath: "/host/project", containerPath: "/workspace" },
      { hostPath: "/host/other", containerPath: "/workspace/other" },
    ];
    expect(remapPath("/workspace/other/x.txt", mounts)).toBe("/host/other/x.txt");
    expect(remapPath("/workspace/x.txt", mounts)).toBe("/host/project/x.txt");
  });
});