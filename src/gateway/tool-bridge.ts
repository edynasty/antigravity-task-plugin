/**
 * Tool-call bridge (gateway Todo 13 / bridge stage 2): maps agy's internal
 * tool steps onto the tool names OpenCode itself registers, so a tool call
 * emitted to the client can actually be executed by the host. Unknown tools
 * are not bridged (the gateway simply does not emit them).
 *
 * The container mounts the user's project at /workspace (host path is
 * supplied via AGY_GATEWAY_WORKSPACE). agy paths under /workspace are
 * rewritten to the host path so the host executes against the real project.
 */

import type { WorkspaceMount } from "./workspace.js";

export interface TranslatedToolCall {
  name: string;
  arguments: string;
}

interface BridgeRule {
  readonly toolNames: readonly string[];
  readonly hostName: string;
  readonly argKeys: readonly string[];
  readonly argName: string;
}

const BRIDGE_RULES: readonly BridgeRule[] = [
  {
    toolNames: ["run_command", "run_command_with_output"],
    hostName: "bash",
    argKeys: ["CommandLine", "command"],
    argName: "command",
  },
  {
    toolNames: ["view_file", "view_directory"],
    hostName: "read",
    argKeys: ["FilePath", "file_path", "path"],
    argName: "filePath",
  },
];

/** Rewrite a container path to the host path the client sees, using the
 * workspace mounts (longest containerPath wins, e.g. /workspace/p1 before
 * /workspace). */
export function remapPath(value: string, mounts: readonly WorkspaceMount[]): string {
  if (mounts.length === 0) {
    return value;
  }
  const sorted = [...mounts].sort((a, b) => b.containerPath.length - a.containerPath.length);
  for (const mount of sorted) {
    if (value === mount.containerPath) {
      return mount.hostPath;
    }
    if (value.startsWith(`${mount.containerPath}/`)) {
      return mount.hostPath + value.slice(mount.containerPath.length);
    }
  }
  return value;
}

function stringField(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return null;
}

export function translateToolCall(
  toolName: string,
  inputJson: string,
  mounts: readonly WorkspaceMount[],
): TranslatedToolCall | null {
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(inputJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    input = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const rule of BRIDGE_RULES) {
    if (!rule.toolNames.includes(toolName)) {
      continue;
    }
    const value = stringField(input, rule.argKeys);
    if (value === null) {
      return null;
    }
    const mapped = remapPath(value, mounts);
    return { name: rule.hostName, arguments: JSON.stringify({ [rule.argName]: mapped }) };
  }
  return null;
}