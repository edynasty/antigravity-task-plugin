import { describe, expect, test } from "bun:test";
import { parseWorkspaceMounts } from "../../src/gateway/workspace";

describe("parseWorkspaceMounts", () => {
  test("empty env yields no mounts", () => {
    expect(parseWorkspaceMounts({})).toEqual([]);
  });

  test("single AGY_GATEWAY_WORKSPACE maps to /workspace", () => {
    expect(parseWorkspaceMounts({ AGY_GATEWAY_WORKSPACE: "/Users/a/proj" })).toEqual([
      { hostPath: "/Users/a/proj", containerPath: "/workspace" },
    ]);
  });

  test("AGY_GATEWAY_WORKSPACES parses multiple host=container pairs", () => {
    expect(
      parseWorkspaceMounts({
        AGY_GATEWAY_WORKSPACES: "/Users/a/p1=/workspace/p1,/Users/a/p2=/workspace/p2",
      }),
    ).toEqual([
      { hostPath: "/Users/a/p1", containerPath: "/workspace/p1" },
      { hostPath: "/Users/a/p2", containerPath: "/workspace/p2" },
    ]);
  });

  test("both env vars combine into one mount list", () => {
    expect(
      parseWorkspaceMounts({
        AGY_GATEWAY_WORKSPACE: "/Users/a/proj",
        AGY_GATEWAY_WORKSPACES: "/Users/a/other=/workspace/other",
      }),
    ).toEqual([
      { hostPath: "/Users/a/proj", containerPath: "/workspace" },
      { hostPath: "/Users/a/other", containerPath: "/workspace/other" },
    ]);
  });

  test("malformed entries are skipped", () => {
    expect(
      parseWorkspaceMounts({
        AGY_GATEWAY_WORKSPACES: "/Users/a/p1=/workspace/p1,no-equals,=/workspace/x,/Users/a/p2=",
      }),
    ).toEqual([{ hostPath: "/Users/a/p1", containerPath: "/workspace/p1" }]);
  });

  test("empty AGY_GATEWAY_WORKSPACE is ignored", () => {
    expect(parseWorkspaceMounts({ AGY_GATEWAY_WORKSPACE: "" })).toEqual([]);
  });

  test("entries are trimmed", () => {
    expect(
      parseWorkspaceMounts({
        AGY_GATEWAY_WORKSPACES: " /Users/a/p1 = /workspace/p1 ",
      }),
    ).toEqual([{ hostPath: "/Users/a/p1", containerPath: "/workspace/p1" }]);
  });
});